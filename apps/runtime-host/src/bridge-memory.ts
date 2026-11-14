import { memoryExportAllowed } from "./memory-archive.js";
import { historicalCharacter } from "./memory-lineage.js";
import { inspectReflectionMemory } from "./bridge-reflection.js";
import { IDS } from "./default-context.js";
import { canonical } from "@ifsoul/core/protocol";
import { createHash } from "node:crypto";
import type { MemoryPort } from "@ifsoul/core/memory/port";
import type { MemoryEvent } from "@ifsoul/core/protocol";
import type { BridgeRequest } from "../../server/src/bridge.js";

export const BRIDGE_MEMORY_LIMITS = {
  records: 100,
  episodes: 60,
  consolidationBatch: 20,
  recallRecords: 20,
  recallBytes: 12000,
} as const;
export interface BridgeMemoryEntry {
  id: string;
  sequence?: number;
  hostId: string;
  kind: string;
  summary: string;
  requestDigest?: string;
  source: "browser-report" | "server-observation";
  trust: "unverified" | "observed";
  assistantDialogue?: {
    content: string;
    provenance: "generated-speech-not-fact";
  };
  derived?: {
    algorithm: "bridge-extract-v1";
    sources: { id: string; digest: string; recordedAt: string }[];
    losses: string[];
  };
  serverObservation?: {
    hostId: string;
    previousHost: string | null;
    meaning: string;
  };
}
const hash = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 32);
const validId = (s: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s);
function owner(memory: MemoryPort, id: string) {
  if (!validId(id)) throw Error("Invalid memory identity");
  const result = memory.getCharacter(id);
  if (!result.ok) throw Error("Memory unavailable");
  return result.value;
}
export function activeBridgeEvents(memory: MemoryPort, id: string) {
  const chronological = storedBridgeEvents(memory, id);
  let reset = -1;
  chronological.forEach((e, i) => {
    if (e.eventType === "bridge-reset") reset = i;
  });
  return chronological
    .slice(reset + 1)
    .filter((e) =>
      ["bridge-evidence", "bridge-dialogue"].includes(e.eventType),
    );
}
export function storedBridgeEvents(memory: MemoryPort, memoryId: string) {
  const character = owner(memory, memoryId);
  if (!character) return [];
  const audience = [
    character.participantId,
    IDS.localParticipant,
    "demo-visitor",
  ];
  if (memory.scan) {
    const events: MemoryEvent[] = [];
    let after: number | undefined;
    let through: number | undefined;
    let anchor: string | undefined;
    do {
      const page = memory.scan({
        characterId: memoryId,
        visibleParticipantIds: audience,
        after,
        through,
        anchor,
        limit: 128,
        includeTotal: false,
      });
      if (!page.ok) throw Error("Memory unavailable");
      for (const { event } of page.value.entries)
        if (event.environmentId === "browser-continuation") events.push(event);
      after = page.value.next;
      through = page.value.through;
      anchor = page.value.anchor;
    } while (after !== undefined);
    return events;
  }
  const result = memory.recall({
    characterId: memoryId,
    audienceParticipantIds: audience,
    environmentIds: ["browser-continuation"],
    limit: 1000,
    maxBytes: 1000000,
  });
  if (!result.ok) throw Error("Memory unavailable");
  return result.value;
}
export function inspectBridgeMemory(memory: MemoryPort, memoryId: string) {
  const all = storedBridgeEvents(memory, memoryId);
  let resetIndex = -1;
  all.forEach((event, index) => {
    if (event.eventType === "bridge-reset") resetIndex = index;
  });
  const eligible = all.slice(resetIndex + 1);
  const checkpoint = eligible
    .filter((e) => e.eventType === "bridge-checkpoint")
    .at(-1);
  const dialogues = new Map(
    eligible
      .filter((e) => e.eventType === "bridge-dialogue")
      .map((e) => [e.recordedPayload.inputId, e] as const),
  );
  return {
    memoryId,
    reflection: inspectReflectionMemory(memory, memoryId),
    capacity: BRIDGE_MEMORY_LIMITS.records,
    remainingWrites: null,
    episodes: eligible
      .filter((e) => e.eventType === "bridge-episode")
      .map((e) => e.recordedPayload.entry as unknown as BridgeMemoryEntry),
    retention: {
      sourceRecordsPruned: Number(
        checkpoint?.recordedPayload.sourceRecordsPruned ?? 0,
      ),
      droppedEpisodes: Number(checkpoint?.recordedPayload.droppedEpisodes ?? 0),
      recentRecords: BRIDGE_MEMORY_LIMITS.records,
      episodeRecords: BRIDGE_MEMORY_LIMITS.episodes,
      policy:
        "Saved originals remain until explicit deletion. Prompt projections are bounded; older legacy episodes may lack their originals.",
      retryHorizon:
        "Original request receipts are retained. Earlier legacy episodes may retain only a source digest.",
    },
    entries: eligible
      .filter((e) => e.eventType === "bridge-evidence")
      .map((e) => {
        const entry = e.recordedPayload.entry as unknown as BridgeMemoryEntry;
        const dialogue = dialogues.get(entry.id);
        return dialogue
          ? {
              ...entry,
              assistantDialogue: {
                content: String(dialogue.recordedPayload.content),
                provenance: "generated-speech-not-fact" as const,
              },
            }
          : entry;
      }),
  };
}
export function bridgeMemoryEvent(
  memory: MemoryPort,
  memoryId: string,
  id: string,
  eventType: string,
  payload: Record<string, unknown>,
): MemoryEvent {
  const character = owner(memory, memoryId);
  if (!character) throw Error("Memory owner missing");
  return {
    schemaVersion: "0.4.0",
    kind: "memory-event",
    memoryId: id,
    characterId: memoryId,
    recordedAt: new Date().toISOString(),
    scope: {
      audience: "participants",
      participantIds: [
        character.participantId,
        IDS.localParticipant,
        "demo-visitor",
      ],
      export: memoryExportAllowed(memory, memoryId) ? "allowed" : "forbidden",
    },
    provenance: { sources: [{ sourceType: "derivation", sourceId: id }] },
    eventType,
    participantIds: [character.participantId],
    environmentId: "browser-continuation",
    recordedPayload: payload,
  };
}
function salience(entry: BridgeMemoryEntry) {
  try {
    const detail = JSON.parse(entry.summary);
    const reports = detail.browserReports ?? [];
    return reports.reduce(
      (
        score: number,
        report: { eventKind?: string; actor?: string; summary?: string },
      ) =>
        score +
        (report.eventKind === "outcome" ? 100000 : 0) +
        (report.actor && report.actor !== "unknown" ? 1000 : 0) +
        String(report.summary ?? "").length,
      0,
    );
  } catch {
    return 0;
  }
}
function forgetBridge(memory: MemoryPort, memoryId: string) {
  const all = storedBridgeEvents(memory, memoryId);
  if (!all.length) return;
  if (!memory.compact)
    throw Error("Storage adapter does not support explicit forget");
  const marker = bridgeMemoryEvent(
    memory,
    memoryId,
    `bridge-reset-${crypto.randomUUID()}`,
    "bridge-reset",
    { kind: "bridge-reset", forgetFence: true },
  );
  // The first atomic chunk writes the fence. Later chunks clear older bytes.
  for (let start = 0; start < all.length; start += 200) {
    const selected = all.slice(start, start + 200);
    const exchangeIds: string[] = [];
    for (const event of selected) {
      if (event.eventType !== "bridge-evidence") continue;
      for (const id of [
        event.memoryId,
        event.memoryId.replace("bridge-input-", "bridge-dialogue-"),
      ]) {
        const found = memory.getExchange(id);
        if (!found.ok) throw Error("Memory unavailable");
        if (found.value) {
          if (
            found.value.characterId !== memoryId ||
            found.value.category !==
              (id === event.memoryId ? "bridge-input" : "bridge-dialogue")
          )
            throw Error("Bridge receipt ownership conflict");
          exchangeIds.push(id);
        }
      }
    }
    const saved = memory.compact({
      characterId: memoryId,
      environmentId: "browser-continuation",
      scope: selected[0]!.scope,
      eventIds: selected.map((event) => event.memoryId),
      exchangeIds,
      events: start === 0 ? [marker] : [],
      exchanges: [],
    });
    if (!saved.ok)
      throw Error(
        "Could not finish forgetting this memory. Retry to remove the remaining records.",
      );
  }
}
export function bridgeForgetGeneration(memory: MemoryPort, memoryId: string) {
  return storedBridgeEvents(memory, memoryId)
    .filter((event) => event.eventType === "bridge-reset")
    .at(-1)?.memoryId;
}
export function resetBridgeMemory(memory: MemoryPort, memoryId: string) {
  if (!owner(memory, memoryId)) return;
  forgetBridge(memory, memoryId);
}
export function recordBridgeRequest(
  memory: MemoryPort,
  memoryId: string,
  request: BridgeRequest,
  retention: { historyEntries?: number } = {},
) {
  const historyEntries = retention.historyEntries ?? 8;
  if (
    !Number.isSafeInteger(historyEntries) ||
    historyEntries < 1 ||
    historyEntries > 128
  )
    throw new RangeError("Invalid retained report window");
  const identity = `bridge-input-${hash(memoryId + ":" + request.requestId)}`;
  const previous = memory.getExchange(identity);
  if (!previous.ok) throw Error("Memory unavailable");
  if (previous.value) {
    if (canonical(previous.value.input) !== canonical(request))
      throw Error("Request conflict");
    return;
  }
  const retained = inspectBridgeMemory(memory, memoryId);
  const retainedEntries = [...retained.episodes, ...retained.entries];
  const existingEpisode = retained.episodes.find((e) =>
    e.derived?.sources.some((source) => source.id === identity),
  );
  if (existingEpisode) {
    const digest = createHash("sha256")
      .update(canonical(request))
      .digest("hex");
    if (
      !existingEpisode.requestDigest ||
      existingEpisode.requestDigest !== digest
    )
      throw Error("Request conflict: retained episode source differs");
    return; // Exact source already consolidated; never resurrect expired raw IDs.
  }
  const last = retained.entries.at(-1);
  const previousHost = last?.hostId;
  const reported = new Set(
    retainedEntries.flatMap((entry) => {
      try {
        return (JSON.parse(entry.summary).browserReports ?? []).map(
          (h: { id: string }) => h.id,
        );
      } catch {
        return [];
      }
    }),
  );
  if (
    request.context === "Browser observation ingestion only." &&
    request.history.every((h) => reported.has(h.id))
  )
    return;
  const entry: BridgeMemoryEntry = {
    id: identity,
    sequence:
      retainedEntries.reduce(
        (latest, e) => Math.max(latest, e.sequence ?? 0),
        0,
      ) + 1,
    requestDigest: createHash("sha256")
      .update(canonical(request))
      .digest("hex"),
    hostId: request.hostId,
    kind: request.operation,
    summary: JSON.stringify({
      visit:
        previousHost && previousHost !== request.hostId
          ? { from: previousHost, to: request.hostId }
          : { host: request.hostId },
      operation: request.operation,
      perspectiveCharacterId: historicalCharacter(
        memory,
        memoryId,
        request.character.id,
      ),
      browserContext: request.context,
      browserReports: request.history
        .filter((h) => !reported.has(h.id))
        .map((h) => ({
          id: h.id,
          hostId: h.hostId,
          kind: h.kind,
          eventKind: h.eventKind,
          ...(h.perspectiveCharacterId
            ? {
                perspectiveCharacterId: historicalCharacter(
                  memory,
                  memoryId,
                  h.perspectiveCharacterId,
                ),
              }
            : {}),
          ...(h.reportedClaims ? { reportedClaims: h.reportedClaims } : {}),
          summary: h.summary,
          actor: h.actor ?? "unknown",
          observer: h.observer ?? "unknown",
          recipient: h.recipient ?? "unknown",
          ...(h.actor === "agent"
            ? {
                actorCharacterId: historicalCharacter(
                  memory,
                  memoryId,
                  h.actorCharacterId ?? request.character.id,
                ),
                actorCharacterName:
                  h.actorCharacterName ?? request.character.name,
              }
            : {}),
        })),
    }),
    source: "browser-report",
    trust: "unverified",
    serverObservation: {
      hostId: request.hostId,
      previousHost: previousHost ?? null,
      meaning:
        "A request reached this host; no completed gameplay is asserted.",
    },
  };
  const saved = memory.commit({
    exchanges: [
      {
        id: identity,
        characterId: memoryId,
        category: "bridge-input",
        input: request,
        result: { recorded: true },
      },
    ],
    events: [
      bridgeMemoryEvent(memory, memoryId, identity, "bridge-evidence", {
        kind: "bridge-evidence",
        entry,
        serverObservation: {
          hostId: request.hostId,
          previousHost: previousHost ?? null,
          meaning:
            "A request reached this host; no completed gameplay is asserted.",
        },
      }),
    ],
  });
  if (!saved.ok) throw Error("Memory unavailable");
}
/** Token overlap ranks remembered wording without using inferred identities or embeddings. */
export function memoryRelevance(question: string, text: string): number {
  const words = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const terms = new Set(words(question));
  return [...new Set(words(text))].filter((term) => terms.has(term)).length;
}

/** Host and source decisions are supplied by trusted composition, never request text. */
export type BridgeSourceAccess = (world: string, sourceId: string) => boolean;

export function visibleBridgeEntries(
  entries: BridgeMemoryEntry[],
  access?: BridgeSourceAccess,
): BridgeMemoryEntry[] {
  if (!access) return entries;
  return entries
    .filter((entry) => {
      if (!entry.hostId || !access(entry.hostId, entry.id)) return false;
      try {
        const detail = JSON.parse(entry.summary);
        // A composite can repeat a report in generated speech or its summary.
        // Withhold the entire composite if any constituent is inaccessible.
        return (
          typeof detail.perspectiveCharacterId === "string" &&
          (detail.browserReports ?? []).every(
            (report: { hostId?: string; id?: string }) =>
              typeof report.hostId === "string" &&
              typeof report.id === "string" &&
              access(report.hostId, report.id) &&
              access(
                report.hostId,
                `source-${hash(canonical([report.hostId, report.id])).slice(0, 24)}`,
              ),
          ) &&
          (entry.derived?.sources ?? []).every((source) =>
            access(entry.hostId, source.id),
          )
        );
      } catch {
        return false;
      }
    })
    .map(({ assistantDialogue: _dialogue, ...entry }) => entry);
}

export function recallBridgeMemory(
  memory: MemoryPort,
  memoryId: string,
  question: string,
  access?: BridgeSourceAccess,
) {
  const snapshot = inspectBridgeMemory(memory, memoryId);
  const all = visibleBridgeEntries(
    [...snapshot.episodes, ...snapshot.entries],
    access,
  );
  const ranked = all
    .map((entry, index) => ({
      entry,
      index,
      score: memoryRelevance(question, entry.hostId + " " + entry.summary),
    }))
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const strongest = ranked.find(
    ({ entry, score }) =>
      score > 0 &&
      (() => {
        try {
          return JSON.parse(entry.summary).browserContext !== question;
        } catch {
          return true;
        }
      })(),
  );
  const representatives = [...new Set(all.map((e) => e.hostId))].map(
    (host) =>
      all
        .filter((e) => e.hostId === host)
        .sort((a, b) => salience(b) - salience(a))[0]!,
  );
  const allocation = Math.floor(
    BRIDGE_MEMORY_LIMITS.recallBytes / Math.max(1, representatives.length),
  );
  const covered = representatives.map((original) => {
    if (Buffer.byteLength(JSON.stringify(original)) <= allocation)
      return original;
    const entry = structuredClone(original);
    try {
      const detail = JSON.parse(entry.summary) as {
        browserContext?: string;
        browserReports?: { summary: string }[];
        [key: string]: unknown;
      };
      const reports = detail.browserReports ?? [];
      detail.browserContext = String(detail.browserContext ?? "").slice(0, 160);
      detail.browserReports = reports.map((r) => ({
        ...r,
        summary: r.summary.slice(0, 100),
      }));
      detail.compactedForPrompt = true;
      delete entry.assistantDialogue;
      entry.summary = JSON.stringify(detail);
      while (
        Buffer.byteLength(JSON.stringify(entry)) > allocation &&
        detail.browserReports.length > 1
      ) {
        detail.browserReports.pop();
        detail.omittedSourceReports =
          reports.length - detail.browserReports.length;
        entry.summary = JSON.stringify(detail);
      }
    } catch {
      entry.summary = entry.summary.slice(0, 200);
    }
    return entry;
  });
  const candidates = [
    ...(strongest ? [strongest.entry] : []),
    ...covered,
    ...ranked.map((r) => r.entry),
  ];
  const selected: BridgeMemoryEntry[] = [];
  let bytes = 0;
  for (const entry of candidates) {
    if (selected.some((e) => e.id === entry.id)) continue;
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (selected.length >= BRIDGE_MEMORY_LIMITS.recallRecords) break;
    if (bytes + size > BRIDGE_MEMORY_LIMITS.recallBytes) continue;
    selected.push(entry);
    bytes += size;
  }
  return {
    visitedHosts: [...new Set(all.map((e) => e.hostId))],
    ...(strongest ? { relevantEntryId: strongest.entry.id } : {}),
    retention: snapshot.retention,
    reflection: {
      status: snapshot.reflection.status,
      facts: snapshot.reflection.facts
        .filter(
          (item) =>
            !access ||
            (item.sources.length > 0 &&
              [
                ...item.sources,
                ...item.history.flatMap((revision) => revision.sources),
              ].every(
                (source) => !!source.hostId && access(source.hostId, source.id),
              )),
        )
        .slice(-4)
        .map(({ history, sources, ...item }) => ({
          ...item,
          sources: sources.map((s) => ({
            id: s.id,
            hostId: s.hostId,
            excerpt: s.excerpt.slice(0, 160),
            recordedAt: s.recordedAt,
          })),
        })),
      relationships: snapshot.reflection.relationships
        .filter(
          (item) =>
            !access ||
            (item.sources.length > 0 &&
              [
                ...item.sources,
                ...item.history.flatMap((revision) => revision.sources),
              ].every(
                (source) => !!source.hostId && access(source.hostId, source.id),
              )),
        )
        .slice(-4)
        .map(({ history, sources, ...item }) => ({
          ...item,
          sources: sources.map((s) => ({
            id: s.id,
            hostId: s.hostId,
            excerpt: s.excerpt.slice(0, 160),
            recordedAt: s.recordedAt,
          })),
        })),
      provenance:
        "Model-extracted reported claims and subjective beliefs, not verified truth. Relationship identity persists across worlds and chat; source host labels are historical context, never current role/state. legacy-contextual beliefs remain uncertain world-specific views awaiting reconciliation. Historical perspective remains distinct from current portrayal. Older versions and source digests are available through owner inspection.",
    },
    entries: selected,
    omitted: all.length - selected.length,
    provenance:
      "Visits record server-received requests only. Browser contexts and reports are unverified, never authoritative game outcomes. Assistant dialogue is attributed generated speech, never confirmation of facts or outcomes. Actor, observer and recipient are distinct historical roles; agent actorCharacterId is the portrayed character at report time, never automatically the current profile. Unknown actors stay unknown. Derived episodes are lossy source excerpts with digests, not independent facts.",
  };
}

export function recordBridgeSpeech(
  memory: MemoryPort,
  memoryId: string,
  requestId: string,
  content: string,
) {
  const inputId = `bridge-input-${hash(memoryId + ":" + requestId)}`;
  const id = `bridge-dialogue-${hash(memoryId + ":" + requestId)}`;
  const previous = memory.getExchange(id);
  if (!previous.ok) throw Error("Memory unavailable");
  if (previous.value) return;
  const saved = memory.commit({
    exchanges: [
      {
        id,
        characterId: memoryId,
        category: "bridge-dialogue",
        input: { inputId },
        result: { content: content.slice(0, 600) },
      },
    ],
    events: [
      bridgeMemoryEvent(memory, memoryId, id, "bridge-dialogue", {
        kind: "bridge-dialogue",
        inputId,
        content: content.slice(0, 600),
        provenance: "generated-speech-not-fact",
      }),
    ],
  });
  if (!saved.ok) throw Error("Memory unavailable");
}

/** Semantic model-facing projection of selected recall; durable inspection stays unchanged. */
export function projectBridgeRecallForModel(
  recall: Record<string, unknown>,
  latestUserMessage = "",
): Record<string, unknown> {
  recall = structuredClone(recall);
  const citedIds = new Set<string>();
  const collectCitations = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(collectCitations);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (typeof object.id === "string") citedIds.add(object.id);
    Object.values(object).forEach(collectCitations);
  };
  collectCitations(recall.reflection);
  if (typeof recall.relevantEntryId === "string")
    citedIds.add(recall.relevantEntryId);
  const reports: Record<string, unknown>[] = [];
  const reportRefs = new Map<string, string>();
  const entries = (Array.isArray(recall.entries) ? recall.entries : []).map(
    (raw, index) => {
      const entry = raw as Record<string, unknown>;
      let detail: Record<string, unknown>;
      try {
        detail =
          typeof entry.summary === "string"
            ? JSON.parse(entry.summary)
            : structuredClone(entry.summary);
      } catch {
        detail = { browserContext: entry.summary };
      }
      if (!detail || typeof detail !== "object" || Array.isArray(detail))
        detail = { browserContext: entry.summary };
      const { browserReports, operation: _operation, ...context } = detail;
      if (context.browserContext === latestUserMessage)
        delete context.browserContext;
      const refs = (Array.isArray(browserReports) ? browserReports : []).map(
        (report) => {
          // Same identifier with a changed payload remains a distinct variant.
          const reported = report as Record<string, unknown>;
          const key = canonical({
            hostId: reported.hostId ?? entry.hostId,
            perspectiveCharacterId:
              reported.perspectiveCharacterId ?? detail.perspectiveCharacterId,
            report,
          });
          let ref = reportRefs.get(key);
          if (!ref) {
            ref = `r${reports.length + 1}`;
            reportRefs.set(key, ref);
            const { id, ...semantic } = reported;
            reports.push({
              ref,
              ...semantic,
              ...(typeof id === "string" && citedIds.has(id) ? { id } : {}),
            });
          }
          return ref;
        },
      );
      const {
        id,
        requestDigest: _digest,
        sequence: _sequence,
        summary: _summary,
        serverObservation,
        ...provenance
      } = entry;
      const observation = serverObservation as
        Record<string, unknown> | undefined;
      return {
        ref: `e${index + 1}`,
        ...provenance,
        ...(typeof id === "string" && citedIds.has(id) ? { id } : {}),
        ...(observation
          ? {
              observedVisit: {
                hostId: observation.hostId,
                previousHost: observation.previousHost,
              },
            }
          : {}),
        context,
        ...(refs.length ? { reportRefs: refs } : {}),
      };
    },
  );
  const { retention: _retention, entries: _entries, ...rest } = recall;
  return { ...rest, entries, reports };
}

/** Latest actual user utterance for this portrayal, across hosts and retained episodes. */
export function latestBridgeUserMessage(
  memory: MemoryPort,
  memoryId: string,
  characterId: string,
  access?: BridgeSourceAccess,
): string {
  const character = owner(memory, memoryId);
  if (!character) return "";
  const perspective = historicalCharacter(memory, memoryId, characterId);
  const snapshot = inspectBridgeMemory(memory, memoryId);
  const events = storedBridgeEvents(memory, memoryId);
  const times = new Map(
    events.map((event) => [
      String(
        (event.recordedPayload.entry as Record<string, unknown> | undefined)
          ?.id ?? "",
      ),
      event.recordedAt,
    ]),
  );
  const candidates: { text: string; time: number; sequence: number }[] = [];
  for (const entry of visibleBridgeEntries(
    [...snapshot.episodes, ...snapshot.entries],
    access,
  )) {
    if (entry.kind !== "chat") continue;
    try {
      const detail = JSON.parse(entry.summary);
      const historicalPerspective = detail.perspectiveCharacterId;
      if (
        historicalPerspective !== perspective &&
        !(historicalPerspective === undefined && memoryId === characterId)
      )
        continue;
      if (
        typeof detail.browserContext !== "string" ||
        !detail.browserContext.trim()
      )
        continue;
      const sourceTime =
        entry.derived?.sources.at(-1)?.recordedAt ?? times.get(entry.id);
      candidates.push({
        text: detail.browserContext,
        time: Date.parse(sourceTime ?? "") || 0,
        sequence: entry.sequence ?? 0,
      });
    } catch {
      /* Legacy unstructured reports do not establish who authored a message. */
    }
  }
  const app = memory.recall({
    characterId: memoryId,
    audienceParticipantIds: [character.participantId, IDS.localParticipant],
    environmentIds: ["app-chat", IDS.chat],
    limit: 1000,
    maxBytes: 1000000,
  });
  if (!app.ok) throw Error("Memory unavailable");
  for (const event of app.value) {
    const run = event.recordedPayload.run as
      Record<string, unknown> | undefined;
    if (
      event.eventType !== "laboratory-run" ||
      !run ||
      run.operation !== "chat" ||
      typeof run.message !== "string"
    )
      continue;
    const persona = run.persona as { characterId?: string } | undefined;
    const authorPerspective = historicalCharacter(
      memory,
      memoryId,
      persona?.characterId ?? event.characterId,
    );
    if (authorPerspective !== perspective) continue;
    candidates.push({
      text: run.message,
      time: Date.parse(String(run.startedAt ?? event.recordedAt)) || 0,
      sequence: 0,
    });
  }
  return (
    candidates.sort((a, b) => b.time - a.time || b.sequence - a.sequence)[0]
      ?.text ?? ""
  );
}
