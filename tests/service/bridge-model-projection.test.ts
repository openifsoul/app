import assert from "node:assert/strict";
import test from "node:test";
import { projectBridgeRecallForModel } from "../../apps/runtime-host/src/bridge-memory.js";

test("model recall removes storage envelopes without losing worlds, attribution, citations or conflicting reports", () => {
  const report = {
    id: "report-identifier",
    hostId: "garden",
    kind: "observation",
    eventKind: "outcome",
    summary: "You harvested the blue iris.",
    actor: "user",
    observer: "agent",
    recipient: "agent",
    perspectiveCharacterId: "mira",
    reportedClaims: [{ subject: "recipient", key: "role", value: "healer" }],
  };
  const conflict = {
    ...report,
    actor: "agent",
    actorCharacterId: "rook",
    actorCharacterName: "Rook",
  };
  const latest = "What happened across the worlds?";
  const entries = ["garden", "cards", "dungeon"].map((hostId, i) => ({
    id: `source-${i}`,
    hostId,
    kind: "chat",
    source: "browser-report",
    trust: "unverified",
    recordedAt: "2026-01-01T00:00:00Z",
    requestDigest: "a".repeat(64),
    sequence: i,
    summary: JSON.stringify({
      visit: { from: "garden", to: hostId },
      operation: "chat",
      perspectiveCharacterId: "mira",
      browserContext: i === 0 ? latest : "A prior question",
      browserReports: [report, ...(i === 2 ? [conflict] : [])],
    }),
    serverObservation: {
      hostId,
      previousHost: "garden",
      meaning: "Only receipt was observed; never completed play.",
    },
    assistantDialogue: {
      content: "I remember our story.",
      provenance: "generated-speech-not-fact",
    },
  }));
  const recall = {
    visitedHosts: ["garden", "cards", "dungeon"],
    retention: { policy: "Durable retention policy" },
    entries,
    reflection: {
      facts: [
        { sources: [{ id: "source-0", recordedAt: "2026-01-01T00:00:00Z" }] },
      ],
    },
    provenance: "Browser reports are unverified; generated speech is not fact.",
  };
  const before = JSON.stringify(recall);
  const projected = projectBridgeRecallForModel(recall, latest);
  const out = projected.entries as Record<string, unknown>[];
  const reports = projected.reports as Record<string, unknown>[];
  assert.equal(JSON.stringify(recall), before);
  assert.ok(JSON.stringify(projected).length < before.length * 0.8);
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((e) => e.hostId),
    recall.visitedHosts,
  );
  assert.equal(reports.length, 2);
  assert.equal(reports[0]!.id, undefined);
  assert.equal(out[0]!.id, "source-0");
  assert.equal(out[1]!.id, undefined);
  assert.deepEqual(out[0]!.reportRefs, out[1]!.reportRefs);
  assert.equal((out[2]!.reportRefs as string[]).length, 2);
  assert.equal(reports[0]!.actor, "user");
  assert.equal(reports[1]!.actorCharacterId, "rook");
  assert.equal(reports[1]!.actorCharacterName, "Rook");
  assert.equal(reports[0]!.observer, "agent");
  assert.deepEqual(reports[0]!.reportedClaims, report.reportedClaims);
  assert.equal(out[0]!.recordedAt, entries[0]!.recordedAt);
  assert.equal(out[0]!.source, "browser-report");
  assert.equal(out[0]!.trust, "unverified");
  assert.deepEqual(out[0]!.assistantDialogue, entries[0]!.assistantDialogue);
  assert.deepEqual(projected.reflection, recall.reflection);
  assert.equal(
    (out[0]!.context as Record<string, unknown>).browserContext,
    undefined,
  );
  assert.equal(
    (out[1]!.context as Record<string, unknown>).browserContext,
    "A prior question",
  );
  assert.equal(out[0]!.requestDigest, undefined);
  assert.equal(out[0]!.sequence, undefined);
});

test("oversized projected recall packs all worlds and prunes orphan reports", async () => {
  const { fitModelPrompt } =
    await import("../../apps/runtime-host/src/service.js");
  const entries = Array.from({ length: 15 }, (_, i) => ({
    id: `source-${i}`,
    hostId: ["garden", "cards", "dungeon"][i % 3],
    source: "browser-report",
    trust: "unverified",
    summary: JSON.stringify({
      browserContext: "context ".repeat(300),
      browserReports: [
        {
          id: `report-${i}`,
          hostId: ["garden", "cards", "dungeon"][i % 3],
          actor: "agent",
          actorCharacterId: "rook",
          actorCharacterName: "Rook",
          recipient: "user",
          observer: "host",
          reportedClaims: [{ subject: "actor", key: "role", value: "healer" }],
          summary: "reported action ".repeat(150),
        },
      ],
    }),
  }));
  const continuation = projectBridgeRecallForModel({
    visitedHosts: ["garden", "cards", "dungeon"],
    entries,
  });
  const original = JSON.stringify(continuation);
  const packed = fitModelPrompt(
    { continuation: structuredClone(continuation) },
    "system ".repeat(400),
    {},
    10000,
  );
  assert.equal(JSON.stringify(continuation), original);
  const out = JSON.parse(packed).continuation;
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({
        messages: [
          { role: "system", content: "system ".repeat(400) },
          { role: "user", content: packed },
        ],
        stream: false,
        max_tokens: 1024,
        response_format: { type: "json_schema", json_schema: {} },
      }),
    ) <= 10000,
  );
  assert.deepEqual(
    new Set(out.entries.map((e: { hostId: string }) => e.hostId)),
    new Set(["garden", "cards", "dungeon"]),
  );
  const used = new Set(
    out.entries.flatMap((e: { reportRefs: string[] }) => e.reportRefs),
  );
  assert.equal(out.reports.length, used.size);
  for (const report of out.reports) {
    assert.ok(used.has(report.ref));
    assert.equal(report.actorCharacterId, "rook");
    assert.equal(report.recipient, "user");
    assert.equal(report.observer, "host");
    assert.equal(report.reportedClaims[0].value, "healer");
  }
});

test("legacy reports without their own perspective retain distinct historical context", () => {
  const report = {
    id: "legacy",
    kind: "observation",
    actor: "unknown",
    summary: "An action was reported.",
  };
  const entries = ["mira", "rook"].map((perspectiveCharacterId) => ({
    hostId: "garden",
    source: "browser-report",
    trust: "unverified",
    summary: JSON.stringify({
      perspectiveCharacterId,
      browserReports: [report],
    }),
  }));
  const projected = projectBridgeRecallForModel({ entries });
  assert.equal((projected.reports as unknown[]).length, 2);
  assert.notDeepEqual(
    (projected.entries as { reportRefs: string[] }[])[0]!.reportRefs,
    (projected.entries as { reportRefs: string[] }[])[1]!.reportRefs,
  );
});

test("prompt budgets reject invalid trusted settings and preserve default behavior", async () => {
  const { fitModelPrompt } =
    await import("../../apps/runtime-host/src/service.js");
  for (const budget of [7999, 21001, 10000.5, NaN])
    assert.throws(() => fitModelPrompt({}, "system", {}, budget), RangeError);
  assert.equal(
    fitModelPrompt({ question: "Hello" }, "system", {}),
    fitModelPrompt({ question: "Hello" }, "system", {}, 21000),
  );
});
