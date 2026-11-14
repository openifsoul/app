import {
  minecraftConnectors,
  sameMinecraftTarget,
  validMinecraftTarget,
  type MinecraftTarget,
} from "../../shared/src/minecraft-connectors.js";
import { boundedJSON, secured } from "./security.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PrivateStore, ProviderOption } from "./api.js";
import type { ProviderSelection } from "@ifsoul/core/model-providers/types";
import type { CharacterWorkspace } from "../../runtime-host/src/service-types.js";

export interface GamePairRequest {
  characterId: string;
  memoryId: string;
  connectionId?: string;
  provider: ProviderSelection["provider"];
  model: string;
  consent: boolean;
  minecraftTarget?: MinecraftTarget;
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
  player?: { name: string; uuid: string };
  lastSeen?: number;
}
interface Stored extends GameBinding {
  codeHash: string;
  codeExpiresAt: number;
  tokenHash?: string;
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
}
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
          typeof row.codeHash !== "string" ||
          !Number.isSafeInteger(row.codeExpiresAt) ||
          (row.tokenHash !== undefined && !/^[a-f0-9]{64}$/.test(row.tokenHash))
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
  const inspectionIdentity = (binding: GameBinding) =>
    JSON.stringify([
      binding.principalId,
      binding.connectionId,
      binding.memoryId,
      binding.characterId,
      binding.hostId,
      binding.player?.uuid,
    ]);
  const view = ({
    codeHash,
    codeExpiresAt,
    tokenHash,
    ...r
  }: Stored): GameBinding => structuredClone(r);
  function lookup(rows: Stored[], token: string) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      fail("unauthorized");
    const row = rows.find((r) => r.tokenHash === hash(token));
    if (!row || row.revoked) fail("unauthorized");
    if (row.expiresAt <= now()) fail("expired");
    return row;
  }
  return {
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
              ].includes(k),
          ) ||
          (resolved.minecraftTarget !== undefined &&
            !validMinecraftTarget(resolved.minecraftTarget)) ||
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
        r.player = { ...player };
        r.revision++;
        r.lastSeen = now();
        return view(r);
      });
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
          r.revoked = true;
          r.revision++;
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
        ].includes(k),
    ) ||
    input.consent !== true ||
    (input.minecraftTarget !== undefined &&
      !validMinecraftTarget(input.minecraftTarget)) ||
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
        "/api/game/device/revoke",
        "/api/game/device/owner-proof",
        "/api/game/device/history-consent",
      ].includes(path)
    )
      return new Response(null, { status: 404 });
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      fail("invalid");
    const body = (await boundedJSON(request, 8192)) as Record<string, any>;
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
      if (Object.keys(body).some((k) => !["player", "minecraft"].includes(k)))
        fail("invalid");
      return reply({
        connection: broker.ready(token, body.player, body.minecraft),
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
    if (path === "/api/game/device/history-consent") {
      if (
        Object.keys(body).some((k) => k !== "allowed") ||
        typeof body.allowed !== "boolean"
      )
        fail("invalid");
      broker.setInspection(token, body.allowed);
      return reply({ ok: true });
    }
    if (
      !new URL(request.url).pathname.endsWith("/dialogue") ||
      Object.keys(body).some((k) => !["requestId", "text"].includes(k)) ||
      !safe(body.requestId) ||
      typeof body.text !== "string" ||
      !body.text.trim() ||
      body.text.length > 500 ||
      /[\p{Cc}\p{Cf}]/u.test(body.text)
    )
      fail("invalid");
    const result = await execute(binding, body);
    broker.current(binding);
    return reply(result);
  } catch {
    return reply(
      {
        error: {
          code: "connection-unavailable",
          message:
            "Reconnect or ask the service owner to review this connection.",
        },
      },
      { status: 403 },
    );
  }
}
