import { createHash, randomUUID } from "node:crypto";
import { canonical, validateDocument } from "@ifsoul/core/protocol";
import type { CharacterInstance, MemoryEvent } from "@ifsoul/core/protocol";
import { failure, success } from "@ifsoul/core/memory/port";
import type { MemoryPort, Result } from "@ifsoul/core/memory/port";
import { memoryLineage, historicalPlayer } from "./memory-lineage.js";

export const MEMORY_ARCHIVE_VERSION = "ifsoul-app-memory/0.4.0";
export const MEMORY_ARCHIVE_BYTES = 2_000_000;
const environments = [
  "browser-continuation",
  "app-chat",
  "lab-chat",
  "lab-garden",
];
const types = new Set([
  "bridge-evidence",
  "bridge-dialogue",
  "bridge-episode",
  "bridge-checkpoint",
  "bridge-reflection",
  "conversation-response",
  "conversation-delivery",
  "laboratory-run",
  "task-report",
  "plan-proposal",
  "plan-decision",
]);
const digest = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
export interface ArchivePayload {
  sourceMemoryId: string;
  createdAt: string;
  mode: "filtered-owner-fork";
  authority: "untrusted-history-no-execution-rights";
  playerSubjectId: string;
  characters: CharacterInstance[];
  events: MemoryEvent[];
  profileOrigins: Record<string, string>;
  unknownProfiles: string[];
  losses: string[];
  omitted: { forbidden: number; unsupported: number; derived: number };
}
export interface MemoryArchive {
  version: typeof MEMORY_ARCHIVE_VERSION;
  sha256: string;
  payload: ArchivePayload;
}
export interface ArchivePreview {
  sourceMemoryId: string;
  name: string;
  events: number;
  profiles: number;
  categories: Record<string, number>;
  losses: string[];
  omitted: ArchivePayload["omitted"];
  sha256: string;
  trust: "Untrusted historical evidence. No rights, credentials or live host state.";
}
function references(events: MemoryEvent[]) {
  const profiles = new Set<string>();
  for (const event of events) {
    const payload = event.recordedPayload as Record<string, any>;
    if (payload.entry?.summary) {
      const data = JSON.parse(payload.entry.summary);
      for (const report of data.browserReports ?? []) {
        if (report.perspectiveCharacterId)
          profiles.add(report.perspectiveCharacterId);
        if (report.actorCharacterId) profiles.add(report.actorCharacterId);
      }
      if (data.perspectiveCharacterId)
        profiles.add(data.perspectiveCharacterId);
    }
    if (payload.run?.persona?.characterId)
      profiles.add(payload.run.persona.characterId);
    for (const item of [
      ...(payload.state?.facts ?? []),
      ...(payload.state?.relationships ?? []),
    ]) {
      profiles.add(item.perspectiveCharacterId);
      for (const version of [item, ...(item.history ?? [])])
        for (const source of version.sources ?? [])
          profiles.add(source.perspectiveCharacterId);
    }
  }
  return profiles;
}
const text = (v: unknown, max: number) =>
  typeof v === "string" && v.length <= max;
const sha = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const timestamp = (v: unknown) =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT/.test(v) &&
  Number.isFinite(Date.parse(v));
function validReport(r: unknown) {
  if (
    !object(r) ||
    !keys(r, [
      "id",
      "hostId",
      "kind",
      "eventKind",
      "perspectiveCharacterId",
      "reportedClaims",
      "summary",
      "actor",
      "observer",
      "recipient",
      "actorCharacterId",
      "actorCharacterName",
    ]) ||
    !id(r.id) ||
    !text(r.kind, 128) ||
    !text(r.summary, 600)
  )
    return false;
  for (const k of ["hostId", "perspectiveCharacterId", "actorCharacterId"])
    if (r[k] !== undefined && !id(r[k])) return false;
  for (const k of ["actor", "observer", "recipient"])
    if (!["user", "agent", "host", "unknown"].includes(r[k])) return false;
  if (
    r.eventKind !== undefined &&
    !["progress", "outcome"].includes(r.eventKind)
  )
    return false;
  if (r.actorCharacterName !== undefined && !text(r.actorCharacterName, 120))
    return false;
  if (
    r.reportedClaims !== undefined &&
    (!Array.isArray(r.reportedClaims) ||
      r.reportedClaims.length > 4 ||
      !r.reportedClaims.every(
        (c: unknown) =>
          object(c) &&
          keys(c, ["subject", "key", "value"]) &&
          ["actor", "recipient"].includes(c.subject) &&
          ["role", "preference"].includes(c.key) &&
          text(c.value, 160),
      ))
  )
    return false;
  return true;
}
function validEntry(entry: Record<string, any>) {
  if (
    !id(entry.hostId) ||
    !["decide", "speak", "chat"].includes(entry.kind) ||
    !["unverified", "observed"].includes(entry.trust)
  )
    return false;
  if (
    entry.sequence !== undefined &&
    (!Number.isSafeInteger(entry.sequence) || entry.sequence < 0)
  )
    return false;
  if (entry.requestDigest !== undefined && !sha(entry.requestDigest))
    return false;
  if (entry.assistantDialogue !== undefined) return false; // separate speech events, never a source report
  const data = JSON.parse(entry.summary);
  if (
    !object(data) ||
    !keys(data, [
      "visit",
      "operation",
      "perspectiveCharacterId",
      "browserContext",
      "browserReports",
      "omittedSourceReports",
    ]) ||
    !["decide", "speak", "chat"].includes(data.operation) ||
    !text(data.browserContext, 2000) ||
    !Array.isArray(data.browserReports) ||
    data.browserReports.length > 8 ||
    !data.browserReports.every(validReport)
  )
    return false;
  if (
    data.perspectiveCharacterId !== undefined &&
    !id(data.perspectiveCharacterId)
  )
    return false;
  if (
    !object(data.visit) ||
    !keys(data.visit, ["host", "from", "to"]) ||
    !Object.values(data.visit).every(id)
  )
    return false;
  if (
    entry.derived !== undefined &&
    (!object(entry.derived) ||
      !keys(entry.derived, ["algorithm", "sources", "losses"]) ||
      entry.derived.algorithm !== "bridge-extract-v1" ||
      !Array.isArray(entry.derived.sources) ||
      entry.derived.sources.length !== 1 ||
      !entry.derived.sources.every(
        (source: unknown) =>
          object(source) &&
          keys(source, ["id", "digest", "recordedAt"]) &&
          id(source.id) &&
          sha(source.digest) &&
          timestamp(source.recordedAt),
      ) ||
      !Array.isArray(entry.derived.losses) ||
      !entry.derived.losses.every((loss: unknown) => text(loss, 1000)))
  )
    return false;
  return true;
}
const reflectionKeys = [
  "role",
  "preference",
  "reported-event",
  "trust",
  "cooperation",
  "caution",
];
const roles = ["user", "agent", "host", "unknown"];
const subject = (v: unknown) =>
  typeof v === "string" &&
  (v === "unknown" ||
    /^(character|host|player):[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v));
function boundedMap(v: unknown, valid: (v: unknown) => boolean) {
  return (
    object(v) &&
    Object.keys(v).length <= 50 &&
    Object.entries(v).every(([k, value]) => id(k) && valid(value))
  );
}
function validReflectionSource(v: unknown): boolean {
  return (
    object(v) &&
    keys(v, [
      "id",
      "sequence",
      "excerpt",
      "digest",
      "recordedAt",
      "subjectIds",
      "actorSubjectId",
      "reportedClaims",
      "perspectiveCharacterId",
      "hostId",
      "actor",
      "recipient",
      "eventKind",
    ]) &&
    id(v.id) &&
    (v.sequence === undefined ||
      (Number.isSafeInteger(v.sequence) && v.sequence >= 0)) &&
    text(v.excerpt, 600) &&
    sha(v.digest) &&
    timestamp(v.recordedAt) &&
    Array.isArray(v.subjectIds) &&
    v.subjectIds.length <= 2 &&
    v.subjectIds.every(subject) &&
    subject(v.actorSubjectId) &&
    id(v.perspectiveCharacterId) &&
    id(v.hostId) &&
    roles.includes(v.actor) &&
    roles.includes(v.recipient) &&
    ["progress", "outcome", "unknown"].includes(v.eventKind) &&
    Array.isArray(v.reportedClaims) &&
    v.reportedClaims.length <= 4 &&
    v.reportedClaims.every(
      (c: unknown) =>
        object(c) &&
        keys(c, ["subjectId", "key", "value"]) &&
        subject(c.subjectId) &&
        ["role", "preference"].includes(c.key) &&
        text(c.value, 160),
    )
  );
}
function validReflectionVersion(v: unknown, historical = false): boolean {
  return (
    object(v) &&
    (!historical ||
      keys(v, [
        "key",
        "value",
        "confidence",
        "status",
        "recordedAt",
        "reason",
        "sources",
      ])) &&
    (v.key === undefined || reflectionKeys.includes(v.key)) &&
    text(v.value, 160) &&
    typeof v.confidence === "number" &&
    Number.isFinite(v.confidence) &&
    v.confidence >= 0 &&
    v.confidence <= 0.75 &&
    ["current", "uncertain", "superseded"].includes(v.status) &&
    timestamp(v.recordedAt) &&
    text(v.reason, 240) &&
    Array.isArray(v.sources) &&
    v.sources.length >= 1 &&
    v.sources.length <= 24 &&
    v.sources.every(validReflectionSource)
  );
}
function validReflection(v: unknown): boolean {
  if (
    !object(v) ||
    !keys(v, [
      "status",
      "fingerprint",
      "attemptedFingerprints",
      "consideredSourceIds",
      "facts",
      "relationships",
      "explanation",
    ]) ||
    !["empty", "ready", "failed", "pending"].includes(v.status) ||
    (v.fingerprint !== undefined && !sha(v.fingerprint)) ||
    (v.explanation !== undefined && !text(v.explanation, 1000)) ||
    (v.attemptedFingerprints !== undefined &&
      !boundedMap(v.attemptedFingerprints, sha)) ||
    (v.consideredSourceIds !== undefined &&
      !boundedMap(
        v.consideredSourceIds,
        (ids) => Array.isArray(ids) && ids.length <= 1000 && ids.every(id),
      )) ||
    !Array.isArray(v.facts) ||
    !Array.isArray(v.relationships) ||
    v.facts.length > 12 ||
    v.relationships.length > 12
  )
    return false;
  for (const [group, items] of [
    ["reported-claim", v.facts],
    ["subjective-belief", v.relationships],
  ] as const)
    for (const item of items) {
      if (
        !object(item) ||
        !keys(item, [
          "id",
          "hostId",
          "relationshipScope",
          "kind",
          "subjectId",
          "targetId",
          "key",
          "revision",
          "validFrom",
          "perspectiveCharacterId",
          "history",
          "value",
          "confidence",
          "status",
          "recordedAt",
          "reason",
          "sources",
        ]) ||
        !validReflectionVersion(item) ||
        !id(item.id) ||
        !id(item.hostId) ||
        item.kind !== group ||
        !subject(item.subjectId) ||
        (item.targetId !== undefined && !subject(item.targetId)) ||
        !reflectionKeys.includes(item.key) ||
        !Number.isSafeInteger(item.revision) ||
        item.revision < 1 ||
        !timestamp(item.validFrom) ||
        !id(item.perspectiveCharacterId) ||
        (item.relationshipScope !== undefined &&
          !["portable", "legacy-contextual"].includes(
            item.relationshipScope,
          )) ||
        !Array.isArray(item.history) ||
        item.history.length > 4 ||
        !item.history.every((version: unknown) =>
          validReflectionVersion(version, true),
        )
      )
        return false;
    }
  return true;
}
function validRunResult(r: unknown): boolean {
  if (!object(r)) return false;
  if (r.type === "failure")
    return (
      keys(r, ["type", "error"]) &&
      object(r.error) &&
      keys(r.error, ["code", "message"]) &&
      text(r.error.code, 128) &&
      text(r.error.message, 2000)
    );
  if (r.type === "chat")
    return (
      keys(r, ["type", "response", "delivery"]) &&
      validateDocument(r.response, "conversation-response") &&
      validateDocument(r.delivery, "conversation-delivery")
    );
  return (
    r.type === "plan" &&
    keys(r, ["type", "proposal", "decision", "reports"]) &&
    validateDocument(r.proposal, "plan-proposal") &&
    validateDocument(r.decision, "plan-decision") &&
    Array.isArray(r.reports) &&
    r.reports.length <= 100 &&
    r.reports.every((report: unknown) =>
      validateDocument(report, "task-report"),
    )
  );
}
function validRun(r: Record<string, any>): boolean {
  return (
    id(r.requestId) &&
    ["chat", "plan"].includes(r.operation) &&
    text(r.provider, 128) &&
    text(r.model, 256) &&
    (r.message === undefined || text(r.message, 4000)) &&
    timestamp(r.startedAt) &&
    timestamp(r.completedAt) &&
    ["completed", "failed"].includes(r.status) &&
    (r.persona === undefined ||
      (object(r.persona) &&
        keys(r.persona, ["characterId", "name"]) &&
        id(r.persona.characterId) &&
        text(r.persona.name, 120))) &&
    Array.isArray(r.selectedMemoryIds) &&
    r.selectedMemoryIds.length <= 1000 &&
    r.selectedMemoryIds.every(id) &&
    Array.isArray(r.stages) &&
    r.stages.length <= 1000 &&
    r.stages.every(
      (stage: unknown) =>
        object(stage) &&
        keys(stage, [
          "stage",
          "operation",
          "requestId",
          "status",
          "memoryIds",
        ]) &&
        text(stage.stage, 128) &&
        ["operation", "requestId", "status"].every(
          (k) => stage[k] === undefined || text(stage[k], 128),
        ) &&
        (stage.memoryIds === undefined ||
          (Array.isArray(stage.memoryIds) &&
            stage.memoryIds.length <= 1000 &&
            stage.memoryIds.every(id))),
    ) &&
    validRunResult(r.result)
  );
}
function validEvent(event: unknown, owner: string): event is MemoryEvent {
  if (
    !object(event) ||
    !validateDocument(event, "memory-event") ||
    event.characterId !== owner ||
    !types.has(event.eventType) ||
    !environments.includes(event.environmentId) ||
    event.scope.export !== "allowed"
  )
    return false;
  if (
    event.requiredExtensions?.length ||
    Object.keys(event.extensions ?? {}).length
  )
    return false;
  const p = event.recordedPayload;
  if (!object(p)) return false;
  if (event.eventType.startsWith("bridge-")) {
    if (event.environmentId !== "browser-continuation") return false;
    const allowed: Record<string, string[]> = {
      "bridge-evidence": ["kind", "entry", "serverObservation"],
      "bridge-episode": ["kind", "entry"],
      "bridge-dialogue": ["kind", "inputId", "content", "provenance"],
      "bridge-checkpoint": ["kind", "sourceRecordsPruned", "droppedEpisodes"],
      "bridge-reflection": ["kind", "state"],
    };
    if (
      !keys(p, allowed[event.eventType] ?? []) ||
      (event.eventType !== "bridge-reflection" && p.kind !== event.eventType)
    )
      return false;
    if (
      event.eventType === "bridge-dialogue" &&
      (!id(p.inputId) ||
        !text(p.content, 4000) ||
        p.provenance !== "generated-speech-not-fact")
    )
      return false;
    if (
      event.eventType === "bridge-checkpoint" &&
      ![p.sourceRecordsPruned, p.droppedEpisodes].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    )
      return false;
    if (["bridge-evidence", "bridge-episode"].includes(event.eventType)) {
      if (
        !object(p.entry) ||
        !id(p.entry.id) ||
        typeof p.entry.summary !== "string" ||
        !keys(p.entry, [
          "id",
          "sequence",
          "hostId",
          "kind",
          "summary",
          "requestDigest",
          "source",
          "trust",
          "assistantDialogue",
          "derived",
          "serverObservation",
        ])
      )
        return false;
      if (!validEntry(p.entry)) return false;
      const data = JSON.parse(p.entry.summary);
      if (
        !object(data) ||
        !Array.isArray(data.browserReports) ||
        data.browserReports.length > 8
      )
        return false;
      if (
        p.entry.source !== "browser-report" &&
        p.entry.source !== "server-observation"
      )
        return false;
    }
    if (event.eventType === "bridge-reflection" && !validReflection(p.state))
      return false;
  } else if (event.eventType === "laboratory-run") {
    if (
      !keys(p, ["kind", "run"]) ||
      !object(p.run) ||
      !keys(p.run, [
        "persona",
        "requestId",
        "operation",
        "provider",
        "model",
        "message",
        "startedAt",
        "completedAt",
        "status",
        "stages",
        "selectedMemoryIds",
        "result",
      ]) ||
      !["chat", "plan"].includes(p.run.operation) ||
      !Array.isArray(p.run.stages) ||
      !Array.isArray(p.run.selectedMemoryIds) ||
      !object(p.run.result) ||
      !validRun(p.run)
    )
      return false;
  } else if (!validateDocument(p, event.eventType)) return false;
  return true;
}
function reflectionClosure(events: MemoryEvent[], player?: string) {
  const rawIds = new Set(
    events
      .filter((e) => e.eventType === "bridge-evidence")
      .map((e) => (e.recordedPayload.entry as any).id),
  );
  if (
    events.some(
      (e) =>
        e.eventType === "bridge-dialogue" &&
        !rawIds.has(e.recordedPayload.inputId),
    )
  )
    return false;
  const sources = new Map<
    string,
    { digest: string; report: any; host: string }
  >();
  for (const e of events) {
    if (!["bridge-evidence", "bridge-episode"].includes(e.eventType)) continue;
    const entry = e.recordedPayload.entry as any;
    for (const report of JSON.parse(entry.summary).browserReports ?? []) {
      const host = report.hostId ?? entry.hostId;
      sources.set(`source-${digest([host, report.id]).slice(0, 24)}`, {
        digest: digest(report),
        report,
        host,
      });
    }
  }
  for (const e of events) {
    const state = e.recordedPayload.state as any;
    if (e.eventType !== "bridge-reflection") continue;
    for (const item of [...state.facts, ...state.relationships]) {
      if (
        item.kind === "subjective-belief" &&
        (item.subjectId !== `character:${item.perspectiveCharacterId}` ||
          item.targetId !== player)
      )
        return false;
      for (const version of [item, ...item.history])
        for (const source of version.sources) {
          const original = sources.get(source.id);
          if (
            !original ||
            original.digest !== source.digest ||
            original.report.summary !== source.excerpt ||
            original.report.perspectiveCharacterId !==
              source.perspectiveCharacterId ||
            original.host !== source.hostId ||
            original.report.actor !== source.actor ||
            original.report.recipient !== source.recipient
          )
            return false;
          const identity = (role: string) =>
            role === "user"
              ? player
              : role === "agent"
                ? `character:${original.report.actorCharacterId ?? original.report.perspectiveCharacterId}`
                : role === "host"
                  ? `host:${original.host}`
                  : "unknown";
          const actor = identity(original.report.actor);
          const recipient =
            original.report.recipient === "agent"
              ? `character:${original.report.perspectiveCharacterId}`
              : identity(original.report.recipient);
          const expected = [...new Set([actor, recipient])].filter(
            (s) => s !== "unknown",
          );
          if (
            source.actorSubjectId !== actor ||
            canonical(source.subjectIds) !== canonical(expected)
          )
            return false;
          if (
            item.kind === "reported-claim" &&
            !expected.includes(item.subjectId)
          )
            return false;
        }
    }
  }
  return true;
}
export function previewMemoryArchive(value: unknown): Result<ArchivePreview> {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > MEMORY_ARCHIVE_BYTES)
      return failure("budget-exceeded", "The memory archive exceeds 2 MB.");
    if (
      !object(value) ||
      !keys(value, ["version", "sha256", "payload"]) ||
      value.version !== MEMORY_ARCHIVE_VERSION ||
      !/^[a-f0-9]{64}$/.test(value.sha256)
    )
      throw Error();
    const p = value.payload;
    if (
      !object(p) ||
      !keys(p, [
        "sourceMemoryId",
        "createdAt",
        "mode",
        "authority",
        "playerSubjectId",
        "characters",
        "events",
        "profileOrigins",
        "unknownProfiles",
        "losses",
        "omitted",
      ]) ||
      p.mode !== "filtered-owner-fork" ||
      p.authority !== "untrusted-history-no-execution-rights" ||
      !id(p.sourceMemoryId) ||
      !/^player:[a-f0-9]{20}$/.test(p.playerSubjectId) ||
      !/^\d{4}-\d\d-\d\dT/.test(p.createdAt) ||
      !Number.isFinite(Date.parse(p.createdAt))
    )
      throw Error();
    if (
      !Array.isArray(p.characters) ||
      !p.characters.length ||
      p.characters.length > 50 ||
      !Array.isArray(p.events) ||
      p.events.length > 500 ||
      !Array.isArray(p.unknownProfiles) ||
      !Array.isArray(p.losses) ||
      p.losses.length > 30 ||
      !p.losses.every(
        (s: unknown) => typeof s === "string" && s.length <= 1000,
      ) ||
      !object(p.omitted) ||
      !keys(p.omitted, ["forbidden", "unsupported", "derived"]) ||
      ![p.omitted.forbidden, p.omitted.unsupported, p.omitted.derived].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      !object(p.profileOrigins)
    )
      throw Error();
    const profiles = new Set<string>();
    for (const c of p.characters) {
      if (
        !validateDocument(c, "character-instance") ||
        profiles.has(c.characterId) ||
        c.requiredExtensions?.length ||
        Object.keys(c.extensions ?? {}).length ||
        c.memoryRecordIds.length ||
        c.relationshipMemoryIds.length
      )
        throw Error();
      profiles.add(c.characterId);
    }
    if (
      !profiles.has(p.sourceMemoryId) ||
      !keys(p.profileOrigins, [...profiles]) ||
      [...profiles].some((k) => !id(p.profileOrigins[k]))
    )
      throw Error();
    if (
      !p.unknownProfiles.every(id) ||
      new Set(p.unknownProfiles).size !== p.unknownProfiles.length
    )
      throw Error();
    const eventIds = new Set<string>();
    for (const e of p.events) {
      if (!validEvent(e, p.sourceMemoryId) || eventIds.has(e.memoryId))
        throw Error();
      eventIds.add(e.memoryId);
    }
    const known = new Set([
      ...Object.values(p.profileOrigins),
      ...p.unknownProfiles,
    ]);
    for (const ref of references(p.events)) if (!known.has(ref)) throw Error();
    if (!reflectionClosure(p.events, p.playerSubjectId)) throw Error();
    if (digest(p) !== value.sha256) throw Error();
    const categories: Record<string, number> = {};
    for (const e of p.events)
      categories[e.eventType] = (categories[e.eventType] ?? 0) + 1;
    return success({
      sourceMemoryId: p.sourceMemoryId,
      name: p.characters.find(
        (c: CharacterInstance) => c.characterId === p.sourceMemoryId,
      ).profile.name,
      events: p.events.length,
      profiles: p.characters.length,
      categories,
      losses: p.losses,
      omitted: p.omitted as ArchivePayload["omitted"],
      sha256: value.sha256,
      trust:
        "Untrusted historical evidence. No rights, credentials or live host state.",
    });
  } catch {
    return failure(
      "invalid-document",
      "Choose a supported, intact memory archive with closed references.",
    );
  }
}
export function exportMemoryArchive(
  memory: MemoryPort,
  owner: string,
): Result<MemoryArchive> {
  try {
    const character = memory.getCharacter(owner);
    if (!character.ok) return character;
    if (!character.value)
      return failure("no-session", "This memory is unavailable.");
    const recalled = memory.recall({
      characterId: owner,
      audienceParticipantIds: [character.value.participantId],
      environmentIds: environments,
      limit: 501,
      maxBytes: 1_000_000,
    });
    if (!recalled.ok) return recalled;
    if (recalled.value.length > 500)
      return failure(
        "budget-exceeded",
        "This memory exceeds the archive record limit.",
      );
    const omitted = { forbidden: 0, unsupported: 0, derived: 0 };
    const events: MemoryEvent[] = [];
    for (const event of recalled.value) {
      if (event.scope.export !== "allowed") {
        omitted.forbidden++;
        continue;
      }

      if (!validEvent(event, owner)) {
        omitted.unsupported++;
        continue;
      }
      events.push(structuredClone(event));
    }
    const rawIds = new Set(
      events
        .filter((e) => e.eventType === "bridge-evidence")
        .map((e) => (e.recordedPayload.entry as any).id),
    );
    for (let i = events.length - 1; i >= 0; i--)
      if (
        events[i]!.eventType === "bridge-dialogue" &&
        !rawIds.has(events[i]!.recordedPayload.inputId)
      ) {
        events.splice(i, 1);
        omitted.derived++;
      }
    for (let i = events.length - 1; i >= 0; i--) {
      if (
        events[i]!.eventType === "bridge-reflection" &&
        !reflectionClosure(
          [
            ...events.filter((e) => e.eventType !== "bridge-reflection"),
            events[i]!,
          ],
          historicalPlayer(memory, owner),
        )
      ) {
        events.splice(i, 1);
        omitted.derived++;
      }
    }
    if (!events.length)
      return failure(
        "unsupported",
        "No export-permitted retained history is available. Start a new exportable memory; existing restrictions stay unchanged.",
      );
    const lineage = memoryLineage(memory, owner);
    const refs = references(events);
    const characters: CharacterInstance[] = [];
    const profileOrigins: Record<string, string> = {};
    const catalog = memory.listCharacters(100);
    if (!catalog.ok) return catalog;
    for (const c of catalog.value) {
      if (
        lineage &&
        c.characterId !== owner &&
        !Object.hasOwn(lineage.profiles, c.characterId)
      )
        continue;
      const historical = lineage?.profiles[c.characterId] ?? c.characterId;
      if (c.characterId !== owner && !refs.has(historical)) continue;
      characters.push({
        ...structuredClone(c),
        memoryRecordIds: [],
        relationshipMemoryIds: [],
      });
      profileOrigins[c.characterId] = historical;
    }
    const unknownProfiles = [...refs].filter(
      (r) => !Object.values(profileOrigins).includes(r),
    );
    const payload: ArchivePayload = {
      sourceMemoryId: owner,
      createdAt: new Date().toISOString(),
      mode: "filtered-owner-fork",
      authority: "untrusted-history-no-execution-rights",
      playerSubjectId: historicalPlayer(memory, owner),
      characters,
      profileOrigins,
      unknownProfiles,
      events,
      omitted,
      losses: [
        "Filtered bounded snapshot: at most 500 records / 1,000,000 recall bytes from declared App environments. Additional retained rows may be outside this selection; pruned raw evidence and expired episodes are unavailable.",
        "Provider credentials/settings, authentication, usage, exchanges, execution handles and private configuration are excluded.",
        "Forbidden-export records are excluded without changing their consent.",
        "Reflections whose source export-consent closure cannot be proven are omitted; retained eligible reports may seed new interpretations.",
        "No active host mapping, execution state, ownership handoff or resume authority is transferred.",
      ],
    };
    const archive: MemoryArchive = {
      version: MEMORY_ARCHIVE_VERSION,
      payload,
      sha256: digest(payload),
    };
    const valid = previewMemoryArchive(archive);
    return valid.ok ? success(archive) : valid;
  } catch {
    return failure(
      "invalid-document",
      "This memory cannot be exported safely.",
    );
  }
}
export function importMemoryArchive(
  memory: MemoryPort,
  archive: unknown,
  expectedDigest: unknown,
): Result<{
  memoryId: string;
  characterId: string;
  profileMap: Record<string, string>;
}> {
  const checked = previewMemoryArchive(archive);
  if (!checked.ok) return checked;
  if (expectedDigest !== checked.value.sha256)
    return failure("conflict", "Preview this exact archive before importing.");
  const a = archive as MemoryArchive;
  const all = memory.listCharacters(100);
  if (!all.ok) return all;
  if (all.value.length + a.payload.characters.length > 50)
    return failure(
      "budget-exceeded",
      "The imported profiles exceed the 50-character limit.",
    );
  const token = randomUUID();
  const profileMap: Record<string, string> = {};
  const profiles: Record<string, string> = {};
  const characters = a.payload.characters.map((c, i): CharacterInstance => {
    const fresh = `fork-${token}-${i}`;
    profileMap[c.characterId] = fresh;
    profiles[fresh] = a.payload.profileOrigins[c.characterId]!;
    return {
      ...structuredClone(c),
      characterId: fresh,
      participantId: `fork-player-${token}-${i}`,
      createdAt: new Date().toISOString(),
      memoryRecordIds: [],
      relationshipMemoryIds: [],
    };
  });
  const memoryId = profileMap[a.payload.sourceMemoryId]!;
  const owner = characters.find((c) => c.characterId === memoryId)!;
  const events = a.payload.events.map((event, i): MemoryEvent => ({
    ...structuredClone(event),
    memoryId: `fork-event-${token}-${i}`,
    characterId: memoryId,
    scope: {
      audience: "participants",
      participantIds: [
        owner.participantId,
        "participant-local",
        "demo-visitor",
      ],
      export: "allowed",
    },
    participantIds: [owner.participantId],
  }));
  const committed = memory.commit({
    characters,
    events,
    exchanges: [
      {
        id: `memory-export-policy:${memoryId}`,
        characterId: memoryId,
        category: "memory-export-policy",
        input: { consent: true, sourceArchive: a.sha256 },
        result: { export: "allowed" },
      },
      {
        id: `memory-fork:${memoryId}`,
        characterId: memoryId,
        category: "memory-fork-lineage",
        input: {
          version: a.version,
          createdAt: a.payload.createdAt,
          losses: a.payload.losses,
          omitted: a.payload.omitted,
        },
        result: {
          sourceMemoryId: a.payload.sourceMemoryId,
          archiveDigest: a.sha256,
          eventOrigins: Object.fromEntries(
            events.map((e, i) => [e.memoryId, a.payload.events[i]!.memoryId]),
          ),
          profiles,
          playerSubjectId: a.payload.playerSubjectId,
        },
      },
    ],
  });
  return committed.ok
    ? success({ memoryId, characterId: memoryId, profileMap })
    : committed;
}

/** Creates a distinct, empty session. Existing record consent is immutable. */
export function createExportableMemory(
  memory: MemoryPort,
  source: unknown,
  consent: unknown,
): Result<{ memoryId: string; characterId: string }> {
  if (!id(source) || consent !== true)
    return failure(
      "invalid-document",
      "Explicitly choose a new exportable memory.",
    );
  const found = memory.getCharacter(source);
  if (!found.ok) return found;
  if (!found.value)
    return failure("no-session", "Choose an available profile.");
  const all = memory.listCharacters(100);
  if (!all.ok) return all;
  if (all.value.length >= 50)
    return failure(
      "budget-exceeded",
      "This workspace supports up to 50 profiles.",
    );
  const token = randomUUID();
  const characterId = `memory-${token}`;
  const c: CharacterInstance = {
    ...structuredClone(found.value),
    characterId,
    participantId: `memory-player-${token}`,
    createdAt: new Date().toISOString(),
    memoryRecordIds: [],
    relationshipMemoryIds: [],
    profile: {
      ...structuredClone(found.value.profile),
      name: `${found.value.profile.name.slice(0, 60)} · portable`,
    },
  };
  const stored = memory.commit({
    characters: [c],
    events: [],
    exchanges: [
      {
        id: `memory-export-policy:${characterId}`,
        characterId,
        category: "memory-export-policy",
        input: { consent: true },
        result: { export: "allowed" },
      },
    ],
  });
  return stored.ok ? success({ characterId, memoryId: characterId }) : stored;
}
export function memoryExportAllowed(memory: MemoryPort, owner: string) {
  const policy = memory.getExchange(`memory-export-policy:${owner}`);
  return policy.ok && (policy.value?.result as any)?.export === "allowed";
}
