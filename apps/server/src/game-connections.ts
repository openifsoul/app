import {
  minecraftConnectors,
  minecraftActionAvailability,
  type GameAction,
  sameMinecraftTarget,
  validMinecraftTarget,
  type MinecraftTarget,
} from "../../shared/src/minecraft-connectors.js";
import {
  capabilityAccepts,
  validCapabilityManifest,
  validChannelPolicy,
  type ChannelPolicy,
  validCapabilityReport,
  validCapabilityRequest,
  type CapabilityManifest,
  type CapabilityReport,
  type CapabilityRequest,
  type CapabilitySession,
} from "@ifsoul/adapter-sdk/bridge";
import { canonical } from "@ifsoul/core/protocol";
import { boundedJSON, secured } from "./security.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PrivateStore, ProviderOption } from "./api.js";
import type { ProviderSelection } from "@ifsoul/core/model-providers/types";
import type { CharacterWorkspace } from "../../runtime-host/src/service-types.js";

export type { GameAction };
function validActions(actions: unknown): actions is GameAction[] {
  return (
    Array.isArray(actions) &&
    (actions.length === 0 ||
      (actions.length === 1 && ["movement", "colony"].includes(actions[0])) ||
      (actions.length === 2 &&
        actions[0] === "movement" &&
        actions[1] === "defense"))
  );
}
function profileActions(target?: MinecraftTarget): readonly GameAction[] {
  return minecraftActionAvailability[
    target?.connector ?? "minecraft-mineflayer"
  ];
}
const bridgeChoiceIds: Record<
  keyof typeof minecraftConnectors,
  readonly string[]
> = {
  "minecraft-mineflayer": [
    "follow",
    "come",
    "north",
    "south",
    "east",
    "west",
    "defend",
  ],
  "minecraft-citizens": ["follow", "come"],
  "minecraft-easy-npc": ["come"],
  "minecraft-minecolonies": ["recall-worker"],
  "minecraft-customnpcs": ["come"],
};
function permittedActions(actions: unknown, target?: MinecraftTarget) {
  return (
    validActions(actions) &&
    actions.length > 0 &&
    actions.every((action) => profileActions(target).includes(action))
  );
}
const actionIds: Record<string, GameAction> = {
  follow: "movement",
  come: "movement",
  north: "movement",
  south: "movement",
  east: "movement",
  west: "movement",
  defend: "defense",
  "recall-worker": "colony",
};
const actionResults = new Set([
  "stopped",
  "interrupted",
  "arrived",
  "target-died",
  "expired",
  "failed",
  "unreachable",
]);
export interface GamePairRequest {
  characterId: string;
  memoryId: string;
  connectionId?: string;
  provider: ProviderSelection["provider"];
  model: string;
  consent: boolean;
  minecraftTarget?: MinecraftTarget;
  actions?: GameAction[];
}
export interface GameBinding extends ProviderSelection {
  connectionId: string;
  principalId: string;
  hostId: string;
  characterId: string;
  memoryId: string;
  character: { id: string; name: string; temperament: string };
  revision: number;
  expiresAt: number;
  revoked: boolean;
  minecraftTarget?: MinecraftTarget;
  actions?: GameAction[];
  activeActions?: GameAction[];
  player?: { name: string; uuid: string };
  lastSeen?: number;
  capability?: CapabilitySession;
  capabilityOffline?: boolean;
  capabilityRequired?: true;
  channelPolicyRequired?: true;
}
interface CapabilityPolicy {
  revision: number;
  worldId: string;
  embodimentId: string;
  allowedIntentIds: string[];
  descriptorKeys: Record<string, string>;
  channelPolicy?: ChannelPolicy;
}
interface CapabilityOperation {
  request: CapabilityRequest;
  argumentsKey: string;
  terminal: boolean;
  pending: boolean;
  checkpoint: number;
  reports: Map<
    string,
    { fingerprint: string; late: boolean; persisted: boolean }
  >;
}
interface LiveCapability {
  providerId: string;
  manifest: CapabilityManifest;
  connectionRevision: number;
  expiresAt: number;
  operations: Map<string, CapabilityOperation>;
  group?: true;
  deliveries?: Map<
    string,
    {
      channel: string;
      audienceKey: string;
      authority: string;
      expiresAt: number;
    }
  >;
}
interface Stored extends GameBinding {
  codeHash: string;
  codeExpiresAt: number;
  tokenHash?: string;
  capabilityPolicy?: CapabilityPolicy;
  capabilityClaims?: string[];
}
export interface GameGrant {
  connection: GameBinding;
  code: string;
  expiresAt: number;
}
export interface GameConnectionPort {
  list(): Promise<GameBinding[]>;
  controlProof(): Promise<{ code: string; expiresAt: number }>;
  pair(input: GamePairRequest): Promise<GameGrant>;
  revoke(connectionId: string): Promise<void>;
  history(connectionId: string): Promise<unknown[]>;
  capabilities?(connectionId: string, input: unknown): Promise<GameBinding>;
}
const safeText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\p{Cc}\p{Cf}]/u.test(value);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const safe = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
export class GameConnectionError extends Error {
  constructor(
    readonly code: "unauthorized" | "invalid" | "expired" | "conflict",
  ) {
    super(code);
  }
}
function fail(
  code: "unauthorized" | "invalid" | "expired" | "conflict",
): never {
  throw new GameConnectionError(code);
}
/** Composition owns a serialized durable store; no credentials are returned by owner list/read APIs. */
export function createGameConnectionBroker(options: {
  store: PrivateStore;
  transaction: <T>(f: () => T) => T;
  now?: () => number;
  limits?: {
    maxRows?: number;
    maxActivePerPrincipal?: number;
    maxStoredPerPrincipal?: number;
    maxControlProofs?: number;
    maxControlProofsPerPrincipal?: number;
  };
}) {
  const now = options.now ?? Date.now;
  const liveCapabilities = new Map<string, LiveCapability>();
  const capabilityLeaseMs = 30_000;
  function live(row: Stored) {
    const active = liveCapabilities.get(row.connectionId);
    return active?.connectionRevision === row.revision && !row.revoked
      ? active
      : undefined;
  }
  function scopeMatches(
    policy: CapabilityPolicy,
    manifest: CapabilityManifest,
  ) {
    return (
      policy.worldId === manifest.worldId &&
      policy.embodimentId === manifest.embodimentId
    );
  }
  function descriptorKey(item: CapabilityManifest["capabilities"][number]) {
    const { readiness, reason, ...descriptor } = item;
    return canonical(descriptor);
  }
  function validGrantIds(
    policy: CapabilityPolicy,
    manifest: CapabilityManifest,
  ) {
    if (!scopeMatches(policy, manifest)) return [];
    return policy.allowedIntentIds.filter((id) =>
      manifest.capabilities.some(
        (item) =>
          item.intentId === id &&
          descriptorKey(item) === policy.descriptorKeys[id],
      ),
    );
  }
  function clearChangedGrants(row: Stored, manifest: CapabilityManifest) {
    const policy = row.capabilityPolicy;
    if (!policy) return;
    const validIds = validGrantIds(policy, manifest);
    const previous = policy.channelPolicy;
    const channels = (manifest.channels ?? []).map((supported) => {
      const current = scopeMatches(policy, manifest)
        ? previous?.channels.find((row) => row.channel === supported.channel)
        : undefined;
      return {
        channel: supported.channel,
        listen: supported.listen && Boolean(current?.listen),
        react: supported.react && Boolean(current?.react),
        speak: supported.speak && Boolean(current?.speak),
      };
    });
    const next = previous && {
      channels,
      fallback: scopeMatches(policy, manifest)
        ? previous.fallback
        : ("silence" as const),
    };
    if (
      validIds.length !== policy.allowedIntentIds.length ||
      canonical(previous) !== canonical(next)
    ) {
      policy.allowedIntentIds = validIds;
      policy.channelPolicy = next;
      policy.revision++;
    }
  }
  function capabilityView(
    row: Stored,
    active: LiveCapability,
  ): CapabilitySession {
    const policy = row.capabilityPolicy;
    const channelPolicy =
      policy && scopeMatches(policy, active.manifest)
        ? policy.channelPolicy
        : undefined;
    const channels = active.manifest.channels?.map((row) => {
      const grant = channelPolicy?.channels.find(
        (candidate) => candidate.channel === row.channel,
      );
      const defaultAllowed = row.channel === "private";
      return {
        channel: row.channel,
        listen: row.listen && (grant?.listen ?? defaultAllowed),
        react: row.react && (grant?.react ?? defaultAllowed),
        speak: row.speak && (grant?.speak ?? defaultAllowed),
      };
    });
    return structuredClone({
      ...(channels && {
        channelPolicy: {
          channels,
          fallback: row.minecraftTarget
            ? "silence"
            : (channelPolicy?.fallback ?? "silence"),
        },
      }),
      providerId: active.providerId,
      manifest: active.manifest,
      policyRevision: policy?.revision ?? 0,
      allowedIntentIds: policy ? validGrantIds(policy, active.manifest) : [],
      expiresAt: active.expiresAt,
    });
  }
  const limits = {
    maxRows: 10000,
    maxActivePerPrincipal: 16,
    maxStoredPerPrincipal: 64,
    maxControlProofs: 10000,
    maxControlProofsPerPrincipal: 16,
    ...options.limits,
  };
  if (
    !Object.values(limits).every(
      (n) => Number.isSafeInteger(n) && n > 0 && n <= 1000000,
    )
  )
    fail("invalid");
  function run<T>(f: (rows: Stored[]) => T): T {
    return options.transaction(() => {
      const raw = options.store.get("game-connections-v1");
      const doc =
        raw !== undefined
          ? JSON.parse(raw)
          : { version: "ifsoul-game-connections/0.4.0", rows: [] };
      if (
        doc.version !== "ifsoul-game-connections/0.4.0" ||
        !Array.isArray(doc.rows)
      )
        fail("invalid");
      for (const row of doc.rows) {
        if (
          !row ||
          !safe(row.principalId) ||
          !safe(row.connectionId) ||
          !safe(row.hostId) ||
          !safe(row.memoryId) ||
          !safe(row.characterId) ||
          !row.character ||
          typeof row.character.name !== "string" ||
          !Number.isSafeInteger(row.revision) ||
          row.revision < 1 ||
          !Number.isSafeInteger(row.expiresAt) ||
          typeof row.revoked !== "boolean" ||
          (row.minecraftTarget !== undefined &&
            !validMinecraftTarget(row.minecraftTarget)) ||
          (row.actions !== undefined && !validActions(row.actions)) ||
          (row.activeActions !== undefined &&
            !validActions(row.activeActions)) ||
          typeof row.codeHash !== "string" ||
          !Number.isSafeInteger(row.codeExpiresAt) ||
          (row.tokenHash !== undefined &&
            !/^[a-f0-9]{64}$/.test(row.tokenHash)) ||
          (row.capabilityClaims !== undefined &&
            (!Array.isArray(row.capabilityClaims) ||
              row.capabilityClaims.length > 512 ||
              !row.capabilityClaims.every(
                (claim: unknown) =>
                  typeof claim === "string" && /^[a-f0-9]{64}$/.test(claim),
              ))) ||
          (row.capabilityPolicy !== undefined &&
            (!row.capabilityPolicy ||
              !Number.isSafeInteger(row.capabilityPolicy.revision) ||
              row.capabilityPolicy.revision < 1 ||
              !safe(row.capabilityPolicy.worldId) ||
              !safe(row.capabilityPolicy.embodimentId) ||
              !Array.isArray(row.capabilityPolicy.allowedIntentIds) ||
              !row.capabilityPolicy.allowedIntentIds.every(safe) ||
              !row.capabilityPolicy.descriptorKeys ||
              !row.capabilityPolicy.allowedIntentIds.every(
                (id: string) =>
                  Object.hasOwn(row.capabilityPolicy.descriptorKeys, id) &&
                  typeof row.capabilityPolicy.descriptorKeys[id] === "string",
              )))
        )
          fail("invalid");
      }
      const result = f(doc.rows);
      options.store.set("game-connections-v1", JSON.stringify(doc));
      return result;
    });
  }
  function readProofs() {
    const raw = options.store.get("game-owner-proofs-v1");
    const doc =
      raw !== undefined
        ? JSON.parse(raw)
        : { version: "ifsoul-game-owner-proof/0.4.0", rows: [] };
    if (
      doc.version !== "ifsoul-game-owner-proof/0.4.0" ||
      !Array.isArray(doc.rows) ||
      !doc.rows.every(
        (r: { principalId: string; codeHash: string; expiresAt: number }) =>
          r &&
          safe(r.principalId) &&
          /^[a-f0-9]{64}$/.test(r.codeHash) &&
          Number.isSafeInteger(r.expiresAt),
      )
    )
      fail("invalid");
    return doc as {
      version: string;
      rows: { principalId: string; codeHash: string; expiresAt: number }[];
    };
  }
  const inspectKey = (connectionId: string) =>
    `game-inspection-v1:${connectionId}`;
  const continuityKey = (connectionId: string) =>
    `game-continuity-v1:${connectionId}`;
  const inspectionIdentity = (binding: GameBinding) =>
    JSON.stringify([
      binding.principalId,
      binding.connectionId,
      binding.memoryId,
      binding.characterId,
      binding.hostId,
      binding.player?.uuid,
    ]);
  const continuityIdentity = (binding: GameBinding) =>
    JSON.stringify([inspectionIdentity(binding), binding.revision]);
  const continuity = (row: Stored) => {
    if (
      row.minecraftTarget ||
      !row.player ||
      row.revoked ||
      row.expiresAt <= now()
    )
      return;
    const entry = options.store.get(continuityKey(row.connectionId));
    const id = entry?.slice(0, 36);
    if (
      id &&
      /^[0-9a-f-]{36}$/.test(id) &&
      entry === id + ":" + continuityIdentity(row)
    )
      return { id, binding: view(row) };
  };
  const view = ({
    codeHash,
    codeExpiresAt,
    tokenHash,
    capabilityPolicy,
    capabilityClaims,
    ...r
  }: Stored): GameBinding => {
    const active = liveCapabilities.get(r.connectionId);
    const current =
      active?.connectionRevision === r.revision && !r.revoked
        ? active
        : undefined;
    return {
      ...structuredClone(r),
      ...(current
        ? {
            capability: capabilityView(
              { ...r, codeHash, codeExpiresAt, capabilityPolicy },
              current,
            ),
            capabilityOffline: current.expiresAt <= now(),
          }
        : {}),
    };
  };
  function lookup(rows: Stored[], token: string) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      fail("unauthorized");
    const row = rows.find((r) => r.tokenHash === hash(token));
    if (!row || row.revoked) fail("unauthorized");
    if (row.expiresAt <= now()) fail("expired");
    return row;
  }
  function capabilityActor(rows: Stored[], authority: string | GameBinding) {
    if (typeof authority === "string") return lookup(rows, authority);
    const row = rows.find(
      (entry) =>
        entry.connectionId === authority.connectionId &&
        entry.principalId === authority.principalId &&
        entry.revision === authority.revision,
    );
    if (!row || row.revoked || row.expiresAt <= now()) fail("unauthorized");
    return row;
  }
  return {
    publishGroupCapability(
      binding: GameBinding,
      player: NonNullable<GameBinding["player"]>,
      manifest: unknown,
    ) {
      if (!validCapabilityManifest(manifest)) fail("invalid");
      return run((rows) => {
        const row = capabilityActor(rows, binding);
        if (
          row.minecraftTarget ||
          (row.player && row.player.uuid !== player.uuid)
        )
          fail("unauthorized");
        row.player = player;
        row.capabilityRequired = true;
        if (manifest.channels) row.channelPolicyRequired = true;
        if (row.channelPolicyRequired && !manifest.channels) fail("invalid");
        clearChangedGrants(row, manifest);
        liveCapabilities.set(row.connectionId, {
          providerId: randomUUID(),
          manifest: structuredClone(manifest),
          connectionRevision: row.revision,
          expiresAt: Math.min(row.expiresAt, now() + capabilityLeaseMs),
          operations: new Map(),
          group: true,
        });
        return view(row);
      });
    },
    controlProof(principalId: string) {
      return run(() => {
        if (!safe(principalId)) fail("unauthorized");
        const doc = readProofs();
        doc.rows = doc.rows.filter((r) => r.expiresAt > now());
        if (
          doc.rows.length >= limits.maxControlProofs ||
          doc.rows.filter((r) => r.principalId === principalId).length >=
            limits.maxControlProofsPerPrincipal
        )
          fail("conflict");
        const code = randomBytes(18).toString("base64url"),
          expiresAt = now() + 300000;
        doc.rows.push({ principalId, codeHash: hash(code), expiresAt });
        options.store.set("game-owner-proofs-v1", JSON.stringify(doc));
        return { code, expiresAt };
      });
    },
    confirmOwner(code: string, connectionId: string) {
      return run((rows) => {
        if (
          typeof code !== "string" ||
          !/^[A-Za-z0-9_-]{24}$/.test(code) ||
          !safe(connectionId)
        )
          fail("unauthorized");
        const doc = readProofs(),
          proof = doc.rows.find(
            (r) => r.codeHash === hash(code) && r.expiresAt > now(),
          );
        if (!proof) fail("unauthorized");
        const row = rows.find(
          (r) =>
            r.connectionId === connectionId &&
            r.principalId === proof.principalId,
        );
        if (!row) fail("unauthorized");
        doc.rows.splice(doc.rows.indexOf(proof), 1);
        options.store.set("game-owner-proofs-v1", JSON.stringify(doc));
        return view(row);
      });
    },
    create(
      principalId: string,
      resolved: Omit<
        GameBinding,
        | "connectionId"
        | "principalId"
        | "hostId"
        | "revision"
        | "expiresAt"
        | "revoked"
        | "activeActions"
      >,
      existingConnectionId?: string,
    ): GameGrant {
      return run((rows) => {
        const old = existingConnectionId
          ? rows.find(
              (r) =>
                r.connectionId === existingConnectionId &&
                r.principalId === principalId,
            )
          : undefined;
        if (
          existingConnectionId &&
          (!old ||
            old.characterId !== resolved.characterId ||
            old.memoryId !== resolved.memoryId ||
            !sameMinecraftTarget(old.minecraftTarget, resolved.minecraftTarget))
        )
          fail("unauthorized");
        if (
          !resolved ||
          Object.keys(resolved).some(
            (k) =>
              ![
                "characterId",
                "memoryId",
                "provider",
                "model",
                "character",
                "minecraftTarget",
                "actions",
              ].includes(k),
          ) ||
          (resolved.minecraftTarget !== undefined &&
            !validMinecraftTarget(resolved.minecraftTarget)) ||
          (resolved.actions !== undefined &&
            !permittedActions(resolved.actions, resolved.minecraftTarget)) ||
          !safe(resolved.characterId) ||
          !safe(resolved.memoryId) ||
          !resolved.character ||
          !safe(resolved.character.id) ||
          typeof resolved.character.name !== "string" ||
          resolved.character.name.length > 80 ||
          typeof resolved.character.temperament !== "string" ||
          resolved.character.temperament.length > 160
        )
          fail("invalid");
        if (!old) {
          const stale = rows
            .filter(
              (r) =>
                r.principalId === principalId &&
                (r.revoked || r.expiresAt <= now()),
            )
            .sort((a, b) => a.expiresAt - b.expiresAt);
          while (
            rows.filter((r) => r.principalId === principalId).length >=
              limits.maxStoredPerPrincipal &&
            stale.length
          ) {
            const candidate = stale.shift()!;
            rows.splice(rows.indexOf(candidate), 1);
          }
        }
        if (
          !safe(principalId) ||
          (!old &&
            rows.filter((r) => r.principalId === principalId).length >=
              limits.maxStoredPerPrincipal) ||
          (!old && rows.length >= limits.maxRows) ||
          rows.filter(
            (r) =>
              r !== old &&
              r.principalId === principalId &&
              !r.revoked &&
              r.expiresAt > now(),
          ).length >= limits.maxActivePerPrincipal
        )
          fail("invalid");
        const code = randomBytes(18).toString("base64url"),
          id = old?.connectionId ?? randomUUID(),
          expiresAt = now() + 300000;
        const row: Stored = {
          ...structuredClone(resolved),
          connectionId: id,
          principalId,
          hostId: `game-${id}`,
          revision: (old?.revision ?? 0) + 1,
          expiresAt: now() + 3600000,
          revoked: false,
          ...(old?.player && !resolved.minecraftTarget
            ? { player: old.player }
            : {}),
          codeHash: hash(code),
          codeExpiresAt: expiresAt,
        };
        if (old) {
          options.store.delete(inspectKey(old.connectionId));
          rows[rows.indexOf(old)] = row;
        } else rows.push(row);
        return { connection: view(row), code, expiresAt };
      });
    },
    list(principalId: string) {
      return run((rows) =>
        rows.filter((r) => r.principalId === principalId).map(view),
      );
    },
    redeem(code: string, serverConnectorOnly = false) {
      return run((rows) => {
        if (typeof code !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(code))
          fail("unauthorized");
        const row = rows.find((r) => r.codeHash === hash(code));
        if (
          !row ||
          row.revoked ||
          row.tokenHash ||
          (serverConnectorOnly && !row.minecraftTarget)
        )
          fail("unauthorized");
        if (row.codeExpiresAt <= now()) fail("expired");
        const token = randomBytes(32).toString("base64url");
        row.tokenHash = hash(token);
        row.codeHash = "";
        return { token, connection: view(row) };
      });
    },
    authenticate(token: string) {
      return run((rows) => view(lookup(rows, token)));
    },
    ready(
      token: string,
      player: { name: string; uuid: string },
      minecraft?: {
        connector: string;
        version: string;
        loader: string;
        upstream: string;
        npcId: string;
      },
      actionCapabilities?: unknown,
      capabilityManifest?: unknown,
    ) {
      return run((rows) => {
        const r = lookup(rows, token);
        if (
          !player ||
          Object.keys(player).some((k) => !["name", "uuid"].includes(k)) ||
          !/^[A-Za-z0-9_]{3,16}$/.test(player.name) ||
          !/^[a-f0-9-]{36}$/i.test(player.uuid)
        )
          fail("invalid");
        const target = r.minecraftTarget;
        if (target) {
          const profile = minecraftConnectors[target.connector];
          if (
            !minecraft ||
            typeof minecraft !== "object" ||
            Object.keys(minecraft).length !== 5 ||
            player.uuid !== target.playerId ||
            minecraft.connector !== target.connector ||
            minecraft.npcId !== target.npcId ||
            minecraft.version !== profile.version ||
            minecraft.loader !== profile.loader ||
            minecraft.upstream !== profile.upstream
          )
            fail("unauthorized");
        } else if (minecraft !== undefined) fail("unauthorized");
        if (
          r.player &&
          (r.player.uuid !== player.uuid || r.player.name !== player.name)
        )
          fail("conflict");
        if (
          actionCapabilities !== undefined &&
          !validActions(actionCapabilities)
        )
          fail("invalid");
        if (r.actions) {
          const active = r.actions.filter(
            (action) =>
              profileActions(target).includes(action) &&
              (actionCapabilities as GameAction[] | undefined)?.includes(
                action,
              ),
          );
          r.activeActions =
            active.includes("defense") && !active.includes("movement")
              ? []
              : active;
        }
        if (
          (r.capabilityRequired || capabilityManifest !== undefined) &&
          !validCapabilityManifest(capabilityManifest)
        )
          fail("invalid");
        r.player = { ...player };
        r.revision++;
        r.lastSeen = now();
        if (capabilityManifest) {
          r.capabilityRequired = true;
          if (capabilityManifest.channels) r.channelPolicyRequired = true;
          if (r.channelPolicyRequired && !capabilityManifest.channels)
            fail("invalid");
          for (const [key, entry] of liveCapabilities)
            if (entry.expiresAt + 30 * 60_000 <= now())
              liveCapabilities.delete(key);
          clearChangedGrants(r, capabilityManifest);
          liveCapabilities.set(r.connectionId, {
            providerId: randomUUID(),
            manifest: structuredClone(capabilityManifest),
            connectionRevision: r.revision,
            expiresAt: Math.min(r.expiresAt, now() + capabilityLeaseMs),
            operations: new Map(),
          });
        } else liveCapabilities.delete(r.connectionId);
        return view(r);
      });
    },
    updateCapabilities(
      authority: string | GameBinding,
      providerId: unknown,
      manifest: unknown,
    ) {
      return run((rows) => {
        const row = capabilityActor(rows, authority);
        const active = live(row);
        if (active && Boolean(active.group) !== (typeof authority !== "string"))
          fail("unauthorized");
        if (
          !active ||
          active.providerId !== providerId ||
          active.expiresAt <= now()
        )
          fail("unauthorized");
        if (
          !validCapabilityManifest(manifest) ||
          manifest.worldId !== active.manifest.worldId ||
          manifest.embodimentId !== active.manifest.embodimentId
        )
          fail("invalid");
        if (manifest.revision === active.manifest.revision) {
          if (canonical(manifest) !== canonical(active.manifest))
            fail("conflict");
        } else {
          if (Number(manifest.revision) <= Number(active.manifest.revision))
            fail("conflict");
          if (manifest.channels) row.channelPolicyRequired = true;
          if (row.channelPolicyRequired && !manifest.channels) fail("invalid");
          clearChangedGrants(row, manifest);
          active.manifest = structuredClone(manifest);
        }
        active.expiresAt = Math.min(row.expiresAt, now() + capabilityLeaseMs);
        return view(row);
      });
    },
    setCapabilityPolicy(
      principalId: string,
      connectionId: string,
      input: unknown,
    ) {
      return run((rows) => {
        const row = rows.find(
          (r) =>
            r.connectionId === connectionId && r.principalId === principalId,
        );
        if (!row) fail("unauthorized");
        const active = live(row);
        if (!active || active.expiresAt <= now()) fail("expired");
        const body = input as {
          providerId?: unknown;
          manifestRevision?: unknown;
          policyRevision?: unknown;
          allowedIntentIds?: unknown;
          channelPolicy?: unknown;
        } | null;
        if (
          !body ||
          typeof body !== "object" ||
          Object.keys(body).some(
            (key) =>
              ![
                "providerId",
                "manifestRevision",
                "policyRevision",
                "allowedIntentIds",
                "channelPolicy",
              ].includes(key),
          ) ||
          !Array.isArray(body.allowedIntentIds) ||
          body.allowedIntentIds.length > 48 ||
          new Set(body.allowedIntentIds).size !==
            body.allowedIntentIds.length ||
          body.allowedIntentIds.some(
            (id) =>
              !active.manifest.capabilities.some(
                (item) =>
                  item.intentId === id && item.support !== "unsupported",
              ),
          )
        )
          fail("invalid");
        const policy = capabilityView(row, active);
        if (
          body.providerId !== policy.providerId ||
          body.manifestRevision !== policy.manifest.revision ||
          body.policyRevision !== policy.policyRevision
        )
          fail("conflict");
        if (
          body.channelPolicy !== undefined &&
          (!validChannelPolicy(body.channelPolicy) ||
            (row.minecraftTarget &&
              body.channelPolicy.fallback !== "silence") ||
            !active.manifest.channels ||
            body.channelPolicy.channels.some((requested) => {
              const supported = active.manifest.channels?.find(
                (row) => row.channel === requested.channel,
              );
              return (
                !supported ||
                (requested.listen && !supported.listen) ||
                (requested.react && !supported.react) ||
                (requested.speak && !supported.speak)
              );
            }))
        )
          fail("invalid");
        const previousChannels =
          row.capabilityPolicy &&
          scopeMatches(row.capabilityPolicy, active.manifest)
            ? row.capabilityPolicy.channelPolicy
            : undefined;
        row.capabilityPolicy = {
          channelPolicy: body.channelPolicy ?? previousChannels,
          revision: policy.policyRevision + 1,
          worldId: active.manifest.worldId,
          embodimentId: active.manifest.embodimentId,
          allowedIntentIds: [...body.allowedIntentIds],
          descriptorKeys: Object.fromEntries(
            active.manifest.capabilities
              .filter((item) =>
                (body.allowedIntentIds as string[]).includes(item.intentId),
              )
              .map((item) => [item.intentId, descriptorKey(item)]),
          ),
        };
        return view(row);
      });
    },
    authorizeCapability(
      authority: string | GameBinding,
      input: CapabilityRequest,
    ) {
      const accepted = run((rows) => {
        const row = capabilityActor(rows, authority);
        const active = live(row);
        if (active && Boolean(active.group) !== (typeof authority !== "string"))
          fail("unauthorized");
        if (
          !active ||
          active.expiresAt <= now() ||
          active.providerId !== input.providerId
        )
          fail("unauthorized");
        const policy = capabilityView(row, active);
        const descriptor = policy.manifest.capabilities.find(
          (item) => item.intentId === input.intentId,
        );
        if (
          policy.manifest.revision !== input.manifestRevision ||
          policy.policyRevision !== input.policyRevision ||
          !policy.allowedIntentIds.includes(input.intentId) ||
          !descriptor ||
          !capabilityAccepts(descriptor, input)
        )
          fail("unauthorized");
        const argumentsKey = canonical(
          Object.fromEntries(
            input.arguments.map(({ name, value }) => [name, value]),
          ),
        );
        const existing = active.operations.get(input.id);
        if (existing) {
          if (
            existing.terminal ||
            existing.pending ||
            existing.argumentsKey !== argumentsKey ||
            existing.request.intentId !== input.intentId ||
            existing.request.manifestRevision !== input.manifestRevision ||
            existing.request.policyRevision !== input.policyRevision ||
            input.checkpoint !== existing.checkpoint + 1
          )
            fail("conflict");
          return { operation: existing, active, revision: row.revision };
        }
        const claim = hash(
          canonical([
            row.principalId,
            active.manifest.worldId,
            active.manifest.embodimentId,
            input.id,
          ]),
        );
        const claims = (row.capabilityClaims ??= []);
        if (
          input.checkpoint !== 1 ||
          claims.length >= 512 ||
          rows.some(
            (candidate) =>
              candidate.principalId === row.principalId &&
              candidate.capabilityClaims?.includes(claim),
          )
        )
          fail("conflict");
        claims.push(claim);
        const operation: CapabilityOperation = {
          request: structuredClone(input),
          argumentsKey,
          terminal: false,
          pending: false,
          reports: new Map(),
          checkpoint: 1,
        };
        return { operation, active, revision: row.revision };
      });
      accepted.operation.checkpoint = input.checkpoint;
      accepted.active.operations.set(input.id, accepted.operation);
      return { authorized: true, revision: accepted.revision };
    },
    async reportCapability(
      authority: string | GameBinding,
      report: CapabilityReport,
      execute: (
        binding: GameBinding,
        body: Record<string, unknown>,
      ) => Promise<unknown>,
    ) {
      const accepted = run((rows) => {
        const row = capabilityActor(rows, authority);
        const active = live(row);
        if (active && Boolean(active.group) !== (typeof authority !== "string"))
          fail("unauthorized");
        const operation = active?.operations.get(report.id);
        if (
          !active ||
          active.providerId !== report.providerId ||
          !operation ||
          operation.request.intentId !== report.intentId
        )
          fail("unauthorized");
        const fingerprint = canonical(report);
        const existing = operation.reports.get(report.reportId);
        if (existing?.fingerprint === fingerprint && existing.persisted) return;
        if (
          (existing && existing.fingerprint !== fingerprint) ||
          operation.pending ||
          (!existing && operation.reports.size >= 64)
        )
          fail("conflict");
        const policy = capabilityView(row, active);
        const late =
          existing?.late ??
          (operation.terminal ||
            active.expiresAt <= now() ||
            operation.request.manifestRevision !== active.manifest.revision ||
            operation.request.policyRevision !== policy.policyRevision);
        const receipt = existing ?? { fingerprint, late, persisted: false };
        return { operation, receipt, binding: view(row), late };
      });
      if (!accepted) return { ok: true };
      const { operation, receipt, binding, late } = accepted;
      operation.reports.set(report.reportId, receipt);
      if (late || report.status !== "progress") operation.terminal = true;
      operation.pending = true;
      try {
        await execute(binding, { operation: "action-report", ...report, late });
        receipt.persisted = true;
        return { ok: true };
      } finally {
        operation.pending = false;
      }
    },
    setInspection(token: string, allowed: boolean) {
      return run((rows) => {
        const row = lookup(rows, token);
        if (!row.player) fail("unauthorized");
        const key = inspectKey(row.connectionId);
        if (allowed) options.store.set(key, inspectionIdentity(row));
        else options.store.delete(key);
      });
    },
    setContinuity(token: string, allowed: boolean) {
      return run((rows) => {
        const row = lookup(rows, token);
        if (!row.player || row.minecraftTarget) fail("unauthorized");
        const key = continuityKey(row.connectionId);
        if (allowed) {
          if (!continuity(row))
            options.store.set(
              key,
              randomUUID() + ":" + continuityIdentity(row),
            );
        } else options.store.delete(key);
      });
    },
    continuityBindings(principalId: string, memoryId: string) {
      return run((rows) =>
        rows.flatMap((row) => {
          if (row.principalId !== principalId || row.memoryId !== memoryId)
            return [];
          const approved = continuity(row);
          return approved ? [approved] : [];
        }),
      );
    },
    inspection(principalId: string, connectionId: string, memoryId?: string) {
      return run((rows) => {
        const row = rows.find(
          (item) =>
            item.principalId === principalId &&
            item.connectionId === connectionId,
        );
        if (
          !row ||
          row.revoked ||
          row.expiresAt <= now() ||
          !row.player ||
          (memoryId !== undefined && row.memoryId !== memoryId) ||
          options.store.get(inspectKey(connectionId)) !==
            inspectionIdentity(row)
        )
          fail("unauthorized");
        return view(row);
      });
    },
    sharedDelivery(
      token: string,
      body: Record<string, unknown>,
      issue = false,
    ) {
      return run((rows) => {
        const row = lookup(rows, token);
        const active = live(row);
        const channel = body.channel;
        if (
          !row.minecraftTarget ||
          !active ||
          active.expiresAt <= now() ||
          (channel !== "group" && channel !== "public") ||
          !safe(body.requestId) ||
          typeof body.audienceKey !== "string" ||
          !/^[a-f0-9]{64}$/.test(body.audienceKey)
        )
          fail("unauthorized");
        const current = capabilityView(row, active);
        const policy = current.channelPolicy?.channels.find(
          (item) => item.channel === channel,
        );
        if (!policy?.listen || !policy.react || !policy.speak)
          fail("unauthorized");
        const authority = {
          providerId: current.providerId,
          manifestRevision: current.manifest.revision,
          policyRevision: current.policyRevision,
        };
        if (
          body.providerId !== authority.providerId ||
          body.manifestRevision !== authority.manifestRevision ||
          body.policyRevision !== authority.policyRevision
        )
          fail("conflict");
        const deliveries = (active.deliveries ??= new Map());
        const prior = deliveries.get(body.requestId);
        if (issue) {
          if (prior || deliveries.size >= 512) fail("conflict");
          deliveries.set(body.requestId, {
            channel,
            audienceKey: body.audienceKey,
            authority: canonical(authority),
            expiresAt: now() + 5000,
          });
        } else {
          if (
            !prior ||
            prior.channel !== channel ||
            prior.audienceKey !== body.audienceKey ||
            prior.authority !== canonical(authority) ||
            prior.expiresAt < now()
          )
            fail("conflict");
          // Keep a tombstone so a replay cannot recreate the delivery right.
          prior.expiresAt = 0;
        }
        return authority;
      });
    },
    current(binding: GameBinding) {
      return run((rows) => {
        const r = rows.find(
          (r) =>
            r.connectionId === binding.connectionId &&
            r.principalId === binding.principalId,
        );
        if (
          !r ||
          r.revoked ||
          r.revision !== binding.revision ||
          r.expiresAt <= now()
        )
          fail("unauthorized");
        return view(r);
      });
    },
    revoke(principalId: string, id: string) {
      return run((rows) => {
        const r = rows.find(
          (r) => r.connectionId === id && r.principalId === principalId,
        );
        if (!r) fail("unauthorized");
        if (!r.revoked) {
          options.store.delete(inspectKey(id));
          options.store.delete(continuityKey(id));
          r.revoked = true;
          r.revision++;
          liveCapabilities.delete(id);
        }
        return view(r);
      });
    },
  };
}
/** Resolve from authenticated workspace ownership, never caller profile names or imported IDs. */
export async function resolveGamePair(
  workspace: CharacterWorkspace,
  providers: () => Promise<ProviderOption[]>,
  input: GamePairRequest,
) {
  if (
    !input ||
    Object.keys(input).some(
      (k) =>
        ![
          "characterId",
          "memoryId",
          "provider",
          "model",
          "consent",
          "connectionId",
          "minecraftTarget",
          "actions",
        ].includes(k),
    ) ||
    input.consent !== true ||
    (input.minecraftTarget !== undefined &&
      !validMinecraftTarget(input.minecraftTarget)) ||
    (input.actions !== undefined &&
      !permittedActions(input.actions, input.minecraftTarget)) ||
    !safe(input.characterId) ||
    !safe(input.memoryId) ||
    (input.connectionId !== undefined && !safe(input.connectionId))
  )
    fail("invalid");
  const snapshot = workspace.snapshot(input.characterId, input.memoryId);
  if (!snapshot.ok) fail("unauthorized");
  const provider = (await providers()).find(
    (p) =>
      p.id === input.provider &&
      p.available &&
      p.models.some((m) => m.id === input.model),
  );
  if (!provider) fail("invalid");
  const character = snapshot.value.persona ?? snapshot.value.character;
  return {
    characterId: input.characterId,
    memoryId: input.memoryId,
    provider: input.provider,
    model: input.model,
    ...(input.actions ? { actions: input.actions } : {}),
    ...(input.minecraftTarget
      ? { minecraftTarget: input.minecraftTarget }
      : {}),
    character: {
      id: character.characterId,
      name: character.profile.name,
      temperament:
        character.profile.description.slice(0, 160) ||
        "Respond briefly and privately.",
    },
  };
}
/** Native bearer requests are separate from cookie/owner routes and never accept browser Origin. */
export async function gameDeviceRequest(
  request: Request,
  broker: ReturnType<typeof createGameConnectionBroker>,
  execute: (
    binding: GameBinding,
    body: Record<string, unknown>,
  ) => Promise<unknown>,
  serverConnectorOnly = false,
  allowContinuity = false,
) {
  const reply = (body: unknown, init?: ResponseInit) =>
    secured(Response.json(body, init));
  try {
    if (
      (serverConnectorOnly &&
        new URL(request.url).pathname.endsWith("/owner-proof")) ||
      request.method !== "POST" ||
      request.headers.has("origin") ||
      request.headers.has("cookie") ||
      request.headers.has("sec-fetch-site")
    )
      return new Response(null, { status: 403 });
    const path = new URL(request.url).pathname;
    if (
      ![
        "/api/game/device/redeem",
        "/api/game/device/ready",
        "/api/game/device/dialogue",
        "/api/game/device/capabilities",
        "/api/game/device/revoke",
        "/api/game/device/owner-proof",
        "/api/game/device/history-consent",
        ...(allowContinuity ? ["/api/game/device/continuity-consent"] : []),
      ].includes(path)
    )
      return new Response(null, { status: 404 });
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      fail("invalid");
    const body = (await boundedJSON(
      request,
      ["/api/game/device/ready", "/api/game/device/capabilities"].includes(path)
        ? 24_576
        : 8192,
    )) as Record<string, any>;
    if (!body || typeof body !== "object" || Array.isArray(body))
      fail("invalid");
    if (new URL(request.url).pathname.endsWith("/redeem")) {
      if (Object.keys(body).some((k) => k !== "code")) fail("invalid");
      return reply(broker.redeem(body.code, serverConnectorOnly));
    }
    const token =
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (serverConnectorOnly && !broker.authenticate(token).minecraftTarget)
      fail("unauthorized");
    if (new URL(request.url).pathname.endsWith("/ready")) {
      if (
        Object.keys(body).some(
          (k) =>
            ![
              "player",
              "minecraft",
              "actionCapabilities",
              "capabilityManifest",
            ].includes(k),
        )
      )
        fail("invalid");
      return reply({
        connection: broker.ready(
          token,
          body.player,
          body.minecraft,
          body.actionCapabilities,
          body.capabilityManifest,
        ),
      });
    }
    if (path === "/api/game/device/capabilities") {
      if (
        Object.keys(body).some(
          (key) => !["providerId", "capabilityManifest"].includes(key),
        )
      )
        fail("invalid");
      return reply({
        connection: broker.updateCapabilities(
          token,
          body.providerId,
          body.capabilityManifest,
        ),
      });
    }
    if (path === "/api/game/device/owner-proof") {
      if (Object.keys(body).some((k) => !["code", "connectionId"].includes(k)))
        fail("invalid");
      return reply({
        authorized: true,
        connection: broker.confirmOwner(body.code, body.connectionId),
      });
    }
    const binding = broker.authenticate(token);
    if (path === "/api/game/device/revoke") {
      if (Object.keys(body).length) fail("invalid");
      broker.revoke(binding.principalId, binding.connectionId);
      return reply({ ok: true });
    }
    if (!binding.player) fail("unauthorized");
    if (
      path === "/api/game/device/history-consent" ||
      path === "/api/game/device/continuity-consent"
    ) {
      if (
        Object.keys(body).some((k) => k !== "allowed") ||
        typeof body.allowed !== "boolean"
      )
        fail("invalid");
      if (path === "/api/game/device/continuity-consent")
        broker.setContinuity(token, body.allowed);
      else broker.setInspection(token, body.allowed);
      return reply({ ok: true });
    }
    if (path !== "/api/game/device/dialogue") fail("invalid");
    if (body.operation === "action-check" && Object.keys(body).length > 1) {
      const { operation, ...input } = body;
      if (!validCapabilityRequest(input)) fail("invalid");
      return reply(broker.authorizeCapability(token, input));
    }
    if (body.operation === "action-report") {
      const { operation, ...input } = body;
      if (!validCapabilityReport(input)) fail("invalid");
      return reply(await broker.reportCapability(token, input, execute));
    }
    if (
      binding.capabilityRequired &&
      (body.operation === "action-check" || body.operation === "action-outcome")
    )
      fail("unauthorized");
    if (body.operation === "channel-delivery-check") {
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "operation",
              "requestId",
              "channel",
              "audienceKey",
              "providerId",
              "manifestRevision",
              "policyRevision",
            ].includes(key),
        )
      )
        fail("invalid");
      broker.sharedDelivery(token, body);
      return reply({ authorized: true });
    }
    if (body.channel !== undefined) {
      if (
        !binding.minecraftTarget ||
        Object.keys(body).some(
          (key) =>
            !["requestId", "text", "channel", "audienceKey"].includes(key),
        ) ||
        !safe(body.requestId) ||
        !safeText(body.text, 500) ||
        (body.channel !== "group" && body.channel !== "public") ||
        typeof body.audienceKey !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.audienceKey)
      )
        fail("invalid");
      const snapshot = binding.capability;
      const permission = snapshot?.channelPolicy?.channels.find(
        (row) => row.channel === body.channel,
      );
      if (!snapshot || binding.capabilityOffline || !permission?.listen)
        return reply({ unavailable: true, reason: "channel-policy" });
      const silent = !permission.react || !permission.speak;
      const result = await execute(binding, {
        ...body,
        ...(silent && { suppressDialogue: true }),
      });
      if (
        silent ||
        !result ||
        typeof result !== "object" ||
        !("speech" in result) ||
        typeof result.speech !== "string" ||
        !result.speech
      )
        return reply({ unavailable: true, reason: "channel-policy" });
      broker.current(binding);
      const authority = broker.sharedDelivery(
        token,
        {
          ...body,
          providerId: snapshot.providerId,
          manifestRevision: snapshot.manifest.revision,
          policyRevision: snapshot.policyRevision,
        },
        true,
      );
      return reply({ ...result, destination: body.channel, authority });
    }
    const privatePolicy = binding.capability?.channelPolicy?.channels.find(
      (row) => row.channel === "private",
    );
    if (
      (body.operation === undefined || body.operation === "decide") &&
      binding.channelPolicyRequired &&
      (binding.capabilityOffline || !privatePolicy?.listen)
    )
      return reply({ unavailable: true, reason: "channel-policy" });
    const currentActions = binding.activeActions?.filter(
      (action) =>
        binding.actions?.includes(action) &&
        profileActions(binding.minecraftTarget).includes(action),
    );
    const allowed = (id: string) => {
      if (id === "none") return true;
      if (
        !bridgeChoiceIds[
          binding.minecraftTarget?.connector ?? "minecraft-mineflayer"
        ].includes(id)
      )
        return false;
      if (!binding.capabilityRequired)
        return currentActions?.includes(actionIds[id]) ?? false;
      const intentId = `minecraft.${id}`;
      return (
        !binding.capabilityOffline &&
        binding.capability?.allowedIntentIds.includes(intentId) &&
        binding.capability.manifest.capabilities.some(
          (item) => item.intentId === intentId && item.readiness === "ready",
        )
      );
    };
    if (
      body.operation !== undefined &&
      !binding.capabilityRequired &&
      !currentActions?.length
    )
      fail("unauthorized");
    if (body.operation === "action-check") {
      if (Object.keys(body).length !== 1) fail("invalid");
      return reply({ authorized: true, revision: binding.revision });
    }
    if (body.operation === "action-outcome") {
      if (
        Object.keys(body).some(
          (k) => !["operation", "id", "action", "result"].includes(k),
        ) ||
        !safe(body.id) ||
        body.action === "none" ||
        !allowed(body.action) ||
        !actionResults.has(body.result)
      )
        fail("invalid");
    } else {
      if (
        Object.keys(body).some(
          (k) =>
            !(
              body.operation === "decide"
                ? ["operation", "requestId", "text", "choices"]
                : ["requestId", "text"]
            ).includes(k),
        ) ||
        !safe(body.requestId) ||
        !safeText(body.text, 500)
      )
        fail("invalid");
      if (body.operation === "decide") {
        if (
          !Array.isArray(body.choices) ||
          body.choices.length < 2 ||
          body.choices.length > 8 ||
          body.choices[0]?.id !== "none" ||
          new Set(body.choices.map((c) => c?.id)).size !==
            body.choices.length ||
          !body.choices.every(
            (c) =>
              c &&
              Object.keys(c).length === 2 &&
              allowed(c.id) &&
              safeText(c.label, 160),
          )
        )
          fail("invalid");
      }
    }
    const suppressDialogue =
      binding.capability?.channelPolicy &&
      (!privatePolicy?.react || !privatePolicy.speak);
    const result = await execute(
      binding,
      suppressDialogue ? { ...body, suppressDialogue: true } : body,
    );
    const latest = broker.current(binding);
    if (
      binding.capability?.channelPolicy &&
      (latest.capabilityOffline ||
        latest.capability?.providerId !== binding.capability.providerId ||
        latest.capability.policyRevision !==
          binding.capability.policyRevision ||
        latest.capability.manifest.revision !==
          binding.capability.manifest.revision)
    )
      return reply({ unavailable: true, reason: "channel-policy" });
    return reply(result);
  } catch (error) {
    return reply(
      {
        error: {
          code: "connection-unavailable",
          message:
            "Reconnect or ask the service owner to review this connection.",
        },
      },
      {
        status:
          error instanceof GameConnectionError && error.code === "conflict"
            ? 409
            : 403,
      },
    );
  }
}
