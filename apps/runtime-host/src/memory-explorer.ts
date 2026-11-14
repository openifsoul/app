import { createHash } from "node:crypto";
import { failure, success, type MemoryPort } from "@ifsoul/core/memory/port";
import { canonical, type MemoryEvent } from "@ifsoul/core/protocol";
import { IDS } from "./default-context.js";
import {
  BRIDGE_MEMORY_LIMITS,
  type BridgeMemoryEntry,
  type BridgeSourceAccess,
} from "./bridge-memory.js";
import type { ReflectionItem, ReflectionState } from "./bridge-reflection.js";
import { historicalPlayer } from "./memory-lineage.js";

interface MemorySource {
  id: string;
  kind: string;
  digest?: string;
  excerpt?: string;
}
export interface RetainedMemoryRecord {
  id: string;
  eventId: string;
  kind: string;
  text: string;
  worldId?: string;
  sessionId?: string;
  entityIds: string[];
  recordedAt?: string;
  confidence?: number;
  sources: MemorySource[];
  detail?: unknown;
}
export interface MemoryExplorerPage {
  records: RetainedMemoryRecord[];
  next?: string;
  total?: number;
  facets?: { worlds: Record<string, number>; kinds: Record<string, number> };
  retention: { recentBridgeRecords: number; bridgeEpisodes: number };
}

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const string = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const ids = (...values: unknown[]) => [
  ...new Set(
    values.filter(
      (value): value is string =>
        typeof value === "string" && stableId.test(value),
    ),
  ),
];
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rows(event: MemoryEvent, playerId: string): RetainedMemoryRecord[] {
  const payload = event.recordedPayload;
  const base = {
    id: event.memoryId,
    eventId: event.memoryId,
    recordedAt: event.recordedAt,
    worldId:
      event.environmentId === "browser-continuation"
        ? string(payload.worldId)
        : event.environmentId,
    sessionId: event.sessionId,
    entityIds: ids(...event.participantIds),
    sources: event.provenance.sources.map(({ sourceId, sourceType }) => ({
      id: sourceId,
      kind: sourceType,
    })),
  };
  if (event.eventType === "bridge-reflection") {
    const state = payload.state as ReflectionState | undefined;
    if (!Array.isArray(state?.facts) || !Array.isArray(state?.relationships))
      return [
        {
          ...base,
          kind: event.eventType,
          text: "Unclassified stored interpretation",
          detail: payload,
        },
      ];
    if (!state.facts.length && !state.relationships.length)
      return [
        {
          ...base,
          kind: event.eventType,
          text: `Interpretation status: ${state.status}`,
        },
      ];
    return [
      ...state.facts.map((item) => ({ item, kind: "reported-claim" })),
      ...state.relationships.map((item) => ({
        item,
        kind: "subjective-belief",
      })),
    ].flatMap(({ item, kind }: { item: ReflectionItem; kind: string }) =>
      [
        { ...item, revision: item.revision },
        ...item.history.map((version, index) => ({
          ...version,
          revision: item.revision - item.history.length + index,
        })),
      ].map((version) => ({
        ...base,
        id: `${event.memoryId}:${item.id}:${version.revision}`,
        kind,
        text: `${version.key ?? item.key} · ${version.value}`,
        worldId: version.sources.at(-1)?.hostId ?? item.hostId,
        recordedAt: version.recordedAt,
        entityIds: ids(
          item.subjectId,
          item.targetId,
          `character:${item.perspectiveCharacterId}`,
        ),
        confidence: version.confidence,
        sources: version.sources.map((source) => ({
          ...source,
          kind: "reported evidence",
        })),
        detail: {
          ...version,
          subjectId: item.subjectId,
          targetId: item.targetId,
        },
      })),
    );
  }
  if (
    event.eventType === "bridge-evidence" ||
    event.eventType === "bridge-episode"
  ) {
    const entry = payload.entry as unknown as BridgeMemoryEntry;
    let detail: Record<string, unknown>;
    try {
      detail = object(JSON.parse(entry?.summary));
    } catch {
      return [
        {
          ...base,
          kind: event.eventType,
          text: "Unclassified stored record",
          detail: payload,
        },
      ];
    }
    const perspective = string(detail.perspectiveCharacterId);
    const sourceRows = (
      Array.isArray(detail.browserReports) ? detail.browserReports : []
    ).map((raw, index) => {
      const report = object(raw);
      const worldId = string(report.hostId) ?? entry.hostId;
      const sourceId = `source-${createHash("sha256")
        .update(canonical([worldId, report.id]))
        .digest("hex")
        .slice(0, 24)}`;
      const reportPerspective = string(report.perspectiveCharacterId);
      return {
        ...base,
        id: `${event.memoryId}:report:${index}`,
        kind: "browser-report",
        text: string(report.summary) ?? "",
        worldId,
        entityIds: ids(
          ...(report.actor === "user" || report.recipient === "user"
            ? [playerId]
            : []),
          report.actor === "agent" && report.actorCharacterId
            ? `character:${report.actorCharacterId}`
            : undefined,
          report.recipient === "agent" && reportPerspective
            ? `character:${reportPerspective}`
            : undefined,
          report.actor === "host" || report.recipient === "host"
            ? `host:${worldId}`
            : undefined,
        ),
        sources: [
          { id: sourceId, kind: "unverified browser report" },
          { id: event.memoryId, kind: "containing record" },
        ],
        detail: report,
      };
    });
    return [
      {
        ...base,
        kind: event.eventType,
        text: string(detail.browserContext) ?? entry.kind,
        worldId: entry.hostId,
        entityIds: ids(
          ...base.entityIds,
          perspective ? `character:${perspective}` : undefined,
        ),
        sources:
          entry.derived?.sources.map((source) => ({
            ...source,
            kind: entry.derived!.algorithm,
          })) ?? base.sources,
        detail: {
          ...entry,
          summary: undefined,
          context: detail.browserContext,
        },
      },
      ...sourceRows,
    ];
  }
  const binding = object(payload.binding);
  const messages = Array.isArray(payload.messages)
    ? payload.messages.map(object)
    : [];
  const output = object(payload.output);
  const text =
    event.summary ??
    string(payload.content) ??
    string(payload.text) ??
    string(payload.summary) ??
    string(output.content) ??
    messages.map((message) => string(message.content) ?? "").join("\n");
  return [
    {
      ...base,
      kind: event.eventType,
      text: text || event.eventType,
      entityIds: ids(
        ...base.entityIds,
        binding.characterId,
        binding.embodimentId,
        payload.senderParticipantId,
        payload.speakerParticipantId,
        ...messages.map((message) => message.participantId),
      ),
      sources: [
        ...base.sources,
        ...(typeof payload.inputId === "string"
          ? [{ id: payload.inputId, kind: "conversation input" }]
          : []),
      ],
      detail: payload,
    },
  ];
}

/** Owner-facing retention view. Search never reads journals or grants access from a filter. */
export function browseMemory(
  memory: MemoryPort,
  params: URLSearchParams,
  policy?: { allows: BridgeSourceAccess; cursorKey?: string },
) {
  const memoryId = params.get("memoryId") ?? "";
  const q = (params.get("q") ?? "").trim().normalize("NFKC").toLowerCase();
  const searchTokens = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}\p{Co}]+/gu) ?? [];
  const phrase = searchTokens(q).join(" ");
  const world = params.get("world") ?? "";
  const session = params.get("session") ?? "";
  const entity = params.get("entity") ?? "";
  const npc = params.get("npc") ?? "";
  const kind = params.get("kind") ?? "";
  const source = params.get("source") ?? "";
  const since = params.get("since") ?? "";
  const until = params.get("until") ?? "";
  const confidence = params.get("confidence") ?? "";
  const parsedConfidence = Number(confidence);
  const cursor = params.get("cursor") ?? "";
  const invalid = () =>
    failure("invalid-document", "Check the memory filters and try again.");
  if (
    !stableId.test(memoryId) ||
    q.length > 120 ||
    cursor.length > 512 ||
    [world, session, entity, npc, kind, source].some(
      (value) => value && !stableId.test(value),
    ) ||
    [since, until].some(
      (value) => value && !/^\d{4}-\d{2}-\d{2}$/.test(value),
    ) ||
    (since && until && since > until) ||
    (confidence &&
      (!Number.isFinite(parsedConfidence) ||
        parsedConfidence < 0 ||
        parsedConfidence > 1))
  )
    return invalid();
  const owner = memory.getCharacter(memoryId);
  if (!owner.ok) return owner;
  if (!owner.value)
    return failure("no-session", "This memory is not available.");
  if (!memory.scan)
    return failure(
      "unsupported",
      "This store does not support browsing retained memory.",
    );

  const filter = createHash("sha256")
    .update(
      JSON.stringify([
        memoryId,
        q,
        world,
        session,
        entity,
        npc,
        kind,
        source,
        since,
        until,
        confidence,
        policy?.cursorKey,
      ]),
    )
    .digest("base64url");
  let after = 0;
  let through: number | undefined;
  let offset = 0;
  let anchor: string | undefined;
  let resume: number | undefined;
  if (cursor) {
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      );
      if (!Array.isArray(parsed) || parsed.length !== 6 || parsed[0] !== filter)
        return invalid();
      [, after, through, offset, anchor, resume] = parsed as [
        string,
        number,
        number,
        number,
        string,
        number,
      ];
      if (
        typeof anchor !== "string" ||
        ![after, through, offset, resume].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        through! < after ||
        offset > 250
      )
        return invalid();
    } catch {
      return invalid();
    }
  }

  try {
    const cursorAfter = after;
    const cursorOffset = offset;
    const cursorResume = resume;
    after = 0;
    const scan = (after: number, through?: number, anchor?: string) =>
      memory.scan!({
        characterId: memoryId,
        visibleParticipantIds: [
          owner.value!.participantId,
          IDS.localParticipant,
          "demo-visitor",
        ],
        after,
        through,
        anchor,
        reset: {
          environmentId: "browser-continuation",
          eventType: "bridge-reset",
        },
        ...(q ? { text: q } : {}),
        limit: 96,
        includeTotal: false,
      });
    let page = scan(after, through, anchor);
    if (!page.ok) return page;
    const facets = {
      worlds: Object.create(null) as Record<string, number>,
      kinds: Object.create(null) as Record<string, number>,
    };
    let total = 0;
    const player = historicalPlayer(memory, memoryId);
    const records: RetainedMemoryRecord[] = [];
    let bytes = 0;
    let next: string | undefined;
    do {
      for (const row of page.value.entries) {
        const items = rows(row.event, player);
        if (policy) {
          if (row.event.eventType === "bridge-dialogue") {
            offset = 0;
            after = row.sequence;
            continue;
          }
          const entry = row.event.recordedPayload.entry as
            BridgeMemoryEntry | undefined;
          const reflection = row.event.eventType === "bridge-reflection";
          const authorized = items.every((record) => {
            if (
              !record.worldId ||
              !policy.allows(record.worldId, record.eventId)
            )
              return false;
            if (entry?.id && !policy.allows(record.worldId, entry.id))
              return false;
            if (reflection)
              return (
                record.sources.length > 0 &&
                record.sources.every((source) => {
                  const worldId = (source as MemorySource & { hostId?: string })
                    .hostId;
                  return !!worldId && policy.allows(worldId, source.id);
                })
              );
            if (
              record.kind === "browser-report" &&
              typeof object(record.detail).id === "string" &&
              !policy.allows(record.worldId, String(object(record.detail).id))
            )
              return false;
            return record.sources.every((source) =>
              policy.allows(record.worldId!, source.id),
            );
          });
          if (!authorized) {
            offset = 0;
            after = row.sequence;
            continue;
          }
        }
        for (let index = 0; index < items.length; index++) {
          const record = items[index]!;
          if (
            (world && record.worldId !== world) ||
            (session && record.sessionId !== session) ||
            (entity && !record.entityIds.includes(entity)) ||
            (npc &&
              !record.entityIds.includes(npc) &&
              !record.entityIds.includes(`character:${npc}`)) ||
            (kind && record.kind !== kind) ||
            (since && (record.recordedAt ?? "").slice(0, 10) < since) ||
            (until && (record.recordedAt ?? "").slice(0, 10) > until) ||
            (confidence &&
              (record.confidence === undefined ||
                record.confidence < parsedConfidence)) ||
            (source &&
              record.id !== source &&
              record.eventId !== source &&
              !record.sources.some((s) => s.id === source)) ||
            (q &&
              (!phrase ||
                !` ${searchTokens(JSON.stringify(record)).join(" ")} `.includes(
                  ` ${phrase} `,
                )))
          )
            continue;
          total++;
          if (record.worldId)
            facets.worlds[record.worldId] =
              (facets.worlds[record.worldId] ?? 0) + 1;
          facets.kinds[record.kind] = (facets.kinds[record.kind] ?? 0) + 1;
          if (
            next ||
            row.sequence <= cursorAfter ||
            (row.sequence === cursorResume && index < cursorOffset)
          )
            continue;
          const size = Buffer.byteLength(JSON.stringify(record));
          if (size > 96_000) {
            record.detail = undefined;
            record.text = record.text.slice(0, 2000);
          }
          if (
            records.length >= 20 ||
            (records.length && bytes + size > 192_000)
          ) {
            next = encode([
              filter,
              after,
              page.value.through,
              index,
              page.value.anchor,
              row.sequence,
            ]);
            continue;
          }
          bytes += size;
          records.push(record);
        }
        after = row.sequence;
      }
      if (page.value.next === undefined) break;
      page = scan(page.value.next, page.value.through, page.value.anchor);
      if (!page.ok) return page;
    } while (true);
    return success<MemoryExplorerPage>({
      records,
      total,
      facets,
      ...(next ? { next } : {}),
      retention: {
        recentBridgeRecords: BRIDGE_MEMORY_LIMITS.records,
        bridgeEpisodes: BRIDGE_MEMORY_LIMITS.episodes,
      },
    });
  } catch {
    return failure("storage", "Retained memory is unavailable. Try again.");
  }
}

export interface ScopedHistory {
  worldId: string;
  characterId: string;
  search?: (text: string) => ReadonlySet<string>;
  events: readonly {
    eventId: string;
    sessionId: string;
    senderId: string;
    recipientIds: string[];
    text: string;
  }[];
}

/** Each adapter must authenticate an exact participant-approved connection before invoking this projection. */
export function browseScopedHistory(
  params: URLSearchParams,
  history: ScopedHistory,
): ReturnType<typeof browseMemory> {
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const world = params.get("world") ?? "";
  const session = params.get("session") ?? "";
  const entity = params.get("entity") ?? "";
  const npc = params.get("npc") ?? "";
  const kind = params.get("kind") ?? "";
  const source = params.get("source") ?? "";
  const cursor = params.get("cursor") ?? "";
  if (
    q.length > 120 ||
    cursor.length > 512 ||
    [world, session, entity, npc, kind, source].some(
      (id) => id && !stableId.test(id),
    )
  )
    return failure(
      "invalid-document",
      "Check the memory filters and try again.",
    );
  // Stored participant events predate date/confidence fields. A date or confidence
  // restriction cannot be satisfied by an unknown value.
  const unknownFiltered = ["since", "until", "confidence"].some((field) =>
    params.get(field),
  );
  const matches = q ? history.search?.(q) : undefined;
  const records: RetainedMemoryRecord[] = [];
  for (const event of history.events) {
    const entityIds = ids(event.senderId, ...event.recipientIds);
    if (
      unknownFiltered ||
      (world && world !== history.worldId) ||
      (session && session !== event.sessionId) ||
      (npc && npc !== history.characterId) ||
      (entity && !entityIds.includes(entity)) ||
      (kind && kind !== "private-dialogue") ||
      (source && source !== event.eventId) ||
      (q &&
        (matches
          ? !matches.has(event.eventId)
          : !event.text.toLowerCase().includes(q)))
    )
      continue;
    records.push({
      id: event.eventId,
      eventId: event.eventId,
      kind: "private-dialogue",
      text: event.text,
      worldId: history.worldId,
      sessionId: event.sessionId,
      entityIds,
      sources: [{ id: event.eventId, kind: "private participant event" }],
    });
  }
  const query = new URLSearchParams(params);
  query.delete("cursor");
  query.sort();
  const scope = createHash("sha256")
    .update(query.toString())
    .digest("base64url");
  let after = 0;
  let through = records.length;
  if (cursor) {
    try {
      const parsed = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      );
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 4 ||
        parsed[0] !== scope ||
        !Number.isSafeInteger(parsed[1]) ||
        !Number.isSafeInteger(parsed[2]) ||
        parsed[1] < 0 ||
        parsed[2] > records.length ||
        parsed[1] >= parsed[2] ||
        records[parsed[2] - 1]?.id !== parsed[3]
      )
        return failure(
          "stale-context",
          "Retained memory changed. Start the search again.",
        );
      [, after, through] = parsed;
    } catch {
      return failure("invalid-document", "Invalid memory cursor.");
    }
  }
  return success<MemoryExplorerPage>({
    records: records.slice(after, Math.min(after + 20, through)),
    total: through,
    ...(after + 20 < through
      ? {
          next: encode([scope, after + 20, through, records[through - 1]!.id]),
        }
      : {}),
    retention: {
      recentBridgeRecords: BRIDGE_MEMORY_LIMITS.records,
      bridgeEpisodes: BRIDGE_MEMORY_LIMITS.episodes,
    },
  });
}
