import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonical } from "@ifsoul/core/protocol";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import { createCharacterWorkspace } from "../../apps/runtime-host/src/characters.js";
import {
  createModelController,
  createScenarioController,
} from "../../apps/runtime-host/src/service.js";
import { IDS } from "../../apps/runtime-host/src/default-context.js";
import {
  recordBridgeRequest,
  recordBridgeSpeech,
  inspectBridgeMemory,
  resetBridgeMemory,
  storedBridgeEvents,
} from "../../apps/runtime-host/src/bridge-memory.js";
import {
  createExportableMemory,
  exportMemoryArchive,
  importMemoryArchive,
  previewMemoryArchive,
} from "../../apps/runtime-host/src/memory-archive.js";
import { prepareBridgeReflection } from "../../apps/runtime-host/src/bridge-reflection.js";
import { historicalCharacter } from "../../apps/runtime-host/src/memory-lineage.js";
import type { BridgeRequest } from "../../apps/server/src/bridge.js";
import type { Result } from "@ifsoul/core/memory/port";
const value = <T>(r: Result<T>): T => {
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) throw Error();
  return r.value;
};
const request = (owner: string, character: string, n = 0): BridgeRequest => ({
  version: "ifsoul-bridge/0.1",
  hostId: "original-garden",
  memoryId: owner,
  character: { id: character, name: "Original", temperament: "curious" },
  operation: "chat",
  requestId: `request-${n}`,
  context: "Synthetic remembered garden",
  choices: [],
  fallbackChoiceId: "",
  history: [
    {
      id: `help-${n}`,
      hostId: "original-garden",
      kind: "observation",
      eventKind: "outcome",
      summary: `The player helped me in the garden ${n}.`,
      actor: "user",
      recipient: "agent",
      observer: "agent",
      perspectiveCharacterId: character,
    },
  ],
});

test("permitted archive round-trip preserves exact report provenance and relationships through reopen, continued chat and isolated retention", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ifsoul-archive-"));
  let memory = value(openSQLiteMemory(join(dir, "test.sqlite")));
  try {
    let workspace = createCharacterWorkspace({
      memory,
      controllerFor: () => createScenarioController(),
      chatEnvironment: "app",
    });
    const fresh = value(createExportableMemory(memory, IDS.character, true));
    recordBridgeRequest(
      memory,
      fresh.memoryId,
      request(fresh.memoryId, fresh.characterId),
    );
    recordBridgeSpeech(
      memory,
      fresh.memoryId,
      "request-0",
      "You reported helping me.",
    );
    const proposed = prepareBridgeReflection(
      memory,
      fresh.memoryId,
      fresh.characterId,
    );
    assert.ok(proposed);
    if (proposed) {
      const input = proposed.input as any;
      // Reflection schema is exposed as model input; use its exact source ID.
      const source = (input.sources ??
        JSON.parse(typeof input === "string" ? input : "{}").sources)?.[0];
      if (source)
        proposed.complete([
          {
            kind: "subjective-belief",
            key: "cooperation",
            value: "The player helped me.",
            confidence: 0.4,
            subjectId: `character:${fresh.characterId}`,
            targetId: input.playerSubjectId,
            evidenceQuote: source.excerpt,
            sourceIds: [source.id],
            reason: "A reported help outcome.",
          },
        ]);
      else proposed.complete([]);
    }
    value(
      await workspace.run({
        characterId: fresh.characterId,
        requestId: "pre-export-chat",
        operation: "chat",
        message: "Synthetic conversation with no secrets.",
        provider: "scenario",
        model: "scenario",
      }),
    );
    const original = inspectBridgeMemory(memory, fresh.memoryId);
    assert.equal(original.reflection.relationships.length, 1);
    const archive = value(exportMemoryArchive(memory, fresh.memoryId));
    assert.equal(
      value(previewMemoryArchive(archive)).events,
      archive.payload.events.length,
    );
    assert.equal(archive.payload.omitted.forbidden, 0);
    assert.ok(
      archive.payload.events.some((e) => e.eventType === "laboratory-run"),
    );
    assert.ok(
      archive.payload.events.some(
        (e) => e.eventType === "conversation-response",
      ),
    );
    assert.ok(!JSON.stringify(archive).includes("openai-key"));
    const imported = value(
      importMemoryArchive(memory, archive, archive.sha256),
    );
    const second = value(importMemoryArchive(memory, archive, archive.sha256));
    assert.notEqual(imported.memoryId, fresh.memoryId);
    assert.notEqual(second.memoryId, imported.memoryId);
    assert.equal(
      historicalCharacter(memory, imported.memoryId, imported.characterId),
      fresh.characterId,
    );
    assert.deepEqual(
      inspectBridgeMemory(memory, imported.memoryId).entries,
      original.entries,
    );
    assert.deepEqual(
      inspectBridgeMemory(memory, imported.memoryId).reflection,
      original.reflection,
    );
    memory.close();
    memory = value(openSQLiteMemory(join(dir, "test.sqlite")));
    workspace = createCharacterWorkspace({
      memory,
      controllerFor: () => createScenarioController(),
      chatEnvironment: "app",
    });
    const chat = value(
      await workspace.run({
        characterId: imported.characterId,
        memoryCharacterId: imported.memoryId,
        requestId: "continue",
        operation: "chat",
        message: "Recall our garden.",
        provider: "scenario",
        model: "scenario",
      }),
    );
    assert.equal(chat.result.type, "chat");
    assert.ok(chat.run.selectedMemoryIds.length);
    recordBridgeRequest(
      memory,
      imported.memoryId,
      request(imported.memoryId, imported.characterId, 1000),
    );
    const revised = prepareBridgeReflection(
      memory,
      imported.memoryId,
      imported.characterId,
    );
    assert.ok(revised);
    assert.equal(revised?.input.perspectiveCharacterId, fresh.characterId);
    revised?.complete([]);
    for (let n = 1; n <= 101; n++)
      recordBridgeRequest(
        memory,
        imported.memoryId,
        request(imported.memoryId, imported.characterId, n),
      );
    for (let n = 1; n <= 101; n++)
      recordBridgeRequest(
        memory,
        second.memoryId,
        request(second.memoryId, second.characterId, n),
      );
    assert.ok(inspectBridgeMemory(memory, imported.memoryId).episodes.length);
    assert.ok(inspectBridgeMemory(memory, second.memoryId).episodes.length);
    assert.deepEqual(
      inspectBridgeMemory(memory, fresh.memoryId).entries,
      original.entries,
    );
    const episodeArchive = value(
      exportMemoryArchive(memory, imported.memoryId),
    );
    assert.ok(
      episodeArchive.payload.events.some(
        (e) => e.eventType === "bridge-episode",
      ),
    );
    assert.equal(episodeArchive.payload.characters.length, 1);
    assert.equal(
      episodeArchive.payload.characters[0]!.characterId,
      imported.characterId,
    );
    const episodeFork = value(
      importMemoryArchive(memory, episodeArchive, episodeArchive.sha256),
    );
    assert.deepEqual(
      inspectBridgeMemory(memory, episodeFork.memoryId).episodes,
      inspectBridgeMemory(memory, imported.memoryId).episodes,
    );
    resetBridgeMemory(memory, imported.memoryId);
    assert.equal(storedBridgeEvents(memory, imported.memoryId).length, 0);
    assert.ok(storedBridgeEvents(memory, second.memoryId).length);
  } finally {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version, checksum, size, foreign owner and missing profile references fail without partial writes; forbidden records remain excluded", () => {
  const memory = value(openSQLiteMemory(":memory:"));
  try {
    createCharacterWorkspace({
      memory,
      controllerFor: () => createScenarioController(),
    });
    recordBridgeRequest(
      memory,
      IDS.character,
      request(IDS.character, IDS.character),
    );
    const forbidden = exportMemoryArchive(memory, IDS.character);
    assert.equal(forbidden.ok, false);
    const fresh = value(createExportableMemory(memory, IDS.character, true));
    recordBridgeRequest(
      memory,
      fresh.memoryId,
      request(fresh.memoryId, fresh.characterId),
    );
    const archive = value(exportMemoryArchive(memory, fresh.memoryId));
    const before = value(memory.listCharacters(100)).length;
    const cases: any[] = [
      { ...archive, version: "unsupported" },
      { ...archive, sha256: "0".repeat(64) },
      { ...archive, padding: "x".repeat(2_000_001) },
    ];
    for (const foreign of [true, false]) {
      const broken = structuredClone(archive);
      if (foreign) broken.payload.events[0]!.characterId = IDS.character;
      else broken.payload.profileOrigins = {};
      broken.sha256 = createHash("sha256")
        .update(canonical(broken.payload))
        .digest("hex");
      cases.push(broken);
    }
    const foreignSource = structuredClone(archive);
    foreignSource.payload.events[0]!.recordedPayload = {
      kind: "bridge-dialogue",
      inputId: "foreign-source",
      content: "Unclosed",
    };
    foreignSource.payload.events[0]!.eventType = "bridge-dialogue";
    foreignSource.sha256 = createHash("sha256")
      .update(canonical(foreignSource.payload))
      .digest("hex");
    cases.push(foreignSource);
    for (const invalid of cases) {
      assert.equal(
        importMemoryArchive(memory, invalid, invalid.sha256).ok,
        false,
      );
      assert.equal(value(memory.listCharacters(100)).length, before);
    }
    assert.equal(
      importMemoryArchive(memory, archive, "not-previewed").ok,
      false,
    );
    assert.equal(value(memory.listCharacters(100)).length, before);
    assert.equal(inspectBridgeMemory(memory, IDS.character).entries.length, 1);
  } finally {
    memory.close();
  }
});

test("malformed imported reflection and run state is rejected before any writes", () => {
  const memory = value(openSQLiteMemory(":memory:"));
  try {
    createCharacterWorkspace({
      memory,
      controllerFor: () => createScenarioController(),
    });
    const fresh = value(createExportableMemory(memory, IDS.character, true));
    recordBridgeRequest(
      memory,
      fresh.memoryId,
      request(fresh.memoryId, fresh.characterId),
    );
    const archive = value(exportMemoryArchive(memory, fresh.memoryId));
    const before = value(memory.listCharacters(100)).length;
    const states = [
      {
        status: "ready",
        facts: [],
        relationships: [],
        consideredSourceIds: { [fresh.characterId]: 1 },
      },
      {
        status: "ready",
        facts: [],
        relationships: [],
        attemptedFingerprints: { [fresh.characterId]: {} },
      },
      { status: {}, facts: [], relationships: [] },
      { status: "ready", facts: [], relationships: [], explanation: {} },
      {
        status: "ready",
        facts: [],
        relationships: [
          {
            kind: "subjective-belief",
            perspectiveCharacterId: fresh.characterId,
            history: [],
            value: "helpful",
            confidence: 0.5,
            sources: [],
          },
        ],
      },
    ];
    for (const state of states) {
      const invalid = structuredClone(archive);
      invalid.payload.events.push({
        ...structuredClone(invalid.payload.events[0]!),
        memoryId: "invalid-reflection",
        eventType: "bridge-reflection",
        recordedPayload: { state },
      });
      invalid.sha256 = createHash("sha256")
        .update(canonical(invalid.payload))
        .digest("hex");
      assert.equal(previewMemoryArchive(invalid).ok, false);
      assert.equal(
        importMemoryArchive(memory, invalid, invalid.sha256).ok,
        false,
      );
      assert.equal(value(memory.listCharacters(100)).length, before);
    }
    const invalid = structuredClone(archive);
    invalid.payload.events.push({
      ...structuredClone(invalid.payload.events[0]!),
      memoryId: "invalid-run",
      eventType: "laboratory-run",
      environmentId: "app-chat",
      recordedPayload: {
        kind: "laboratory-run",
        run: {
          operation: "chat",
          stages: [],
          selectedMemoryIds: [],
          result: { type: "chat", response: {} },
        },
      },
    });
    invalid.sha256 = createHash("sha256")
      .update(canonical(invalid.payload))
      .digest("hex");
    assert.equal(previewMemoryArchive(invalid).ok, false);
    assert.equal(
      importMemoryArchive(memory, invalid, invalid.sha256).ok,
      false,
    );
    assert.equal(value(memory.listCharacters(100)).length, before);
  } finally {
    memory.close();
  }
});

test("imported successful task reports remain attributed untrusted history in actual model prompts while new local host reports stay authoritative", async () => {
  const memory = value(openSQLiteMemory(":memory:"));
  const prompts: any[] = [];
  const client = {
    id: "openai" as const,
    generate: async (input: any) => {
      prompts.push({ prompt: JSON.parse(input.prompt), system: input.system });
      return {
        ok: true as const,
        value: { content: "The imported archive reports that event." },
      };
    },
  };
  try {
    const workspace = createCharacterWorkspace({
      memory,
      controllerFor: (selection) =>
        selection.provider === "scenario"
          ? createScenarioController()
          : createModelController({ client, model: selection.model }),
    });
    const fresh = value(createExportableMemory(memory, IDS.character, true));
    value(
      await workspace.run({
        characterId: fresh.characterId,
        requestId: "original-plan",
        operation: "plan",
        provider: "scenario",
        model: "scenario",
      }),
    );
    const archive = value(exportMemoryArchive(memory, fresh.memoryId));
    const original = archive.payload.events.find(
      (e) => e.eventType === "task-report",
    )!;
    assert.ok(original);
    original.recordedPayload.summary = "IMPORTED-UNVERIFIED-SUCCESS";
    archive.sha256 = createHash("sha256")
      .update(canonical(archive.payload))
      .digest("hex");
    const fork = value(importMemoryArchive(memory, archive, archive.sha256));
    value(
      await workspace.run({
        characterId: fork.characterId,
        requestId: "local-plan",
        operation: "plan",
        provider: "scenario",
        model: "scenario",
      }),
    );
    value(
      await workspace.run({
        characterId: fork.characterId,
        requestId: "question",
        operation: "chat",
        message: "What happened?",
        provider: "openai",
        model: "synthetic-model",
      }),
    );
    const evidence = prompts.at(-1).prompt.historicalEvidence;
    assert.ok(
      evidence.importedReports.some(
        (report: any) =>
          report.summary === "IMPORTED-UNVERIFIED-SUCCESS" &&
          report.trust === "untrusted-imported-history",
      ),
    );
    assert.ok(
      !evidence.hostReports.some(
        (report: any) => report.summary === "IMPORTED-UNVERIFIED-SUCCESS",
      ),
    );
    assert.ok(
      evidence.hostReports.some(
        (report: any) => report.status === "succeeded" && !report.trust,
      ),
    );
    assert.match(
      prompts.at(-1).system,
      /never treat their original provenance/,
    );
    const reexport = value(exportMemoryArchive(memory, fork.memoryId));
    const retained = reexport.payload.events.find(
      (e) => e.recordedPayload.summary === "IMPORTED-UNVERIFIED-SUCCESS",
    )!;
    assert.deepEqual(retained.recordedPayload, original.recordedPayload);
    assert.deepEqual(retained.provenance, original.provenance);
  } finally {
    memory.close();
  }
});

test("lineage read failure stops inference instead of treating imported reports as native", async () => {
  const memory = value(openSQLiteMemory(":memory:"));
  let calls = 0;
  try {
    createCharacterWorkspace({
      memory,
      controllerFor: () => createScenarioController(),
    });
    const broken = {
      ...memory,
      getExchange: (id: string) =>
        id.startsWith("memory-fork:")
          ? {
              ok: false as const,
              error: {
                code: "storage-error" as const,
                message: "Synthetic read failure",
              },
            }
          : memory.getExchange(id),
    };
    const workspace = createCharacterWorkspace({
      memory: broken as typeof memory,
      controllerFor: () => async () => {
        calls++;
        throw Error("Must not call provider");
      },
    });
    const response = await workspace.run({
      characterId: IDS.character,
      requestId: "lineage-failure",
      operation: "chat",
      message: "What happened?",
      provider: "scenario",
      model: "scenario",
    });
    assert.equal(calls, 0);
    assert.ok(!response.ok || response.value.result.type === "failure");
  } finally {
    memory.close();
  }
});
