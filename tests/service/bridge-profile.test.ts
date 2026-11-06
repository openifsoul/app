import assert from "node:assert/strict";
import test from "node:test";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import { character } from "../../apps/runtime-host/src/default-context.js";
import { runBridgeRequest } from "../../apps/server/src/bridge.js";

test("arbitrary host preserves the stored authored profile independently of memory ownership", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const memory = opened.value;
  try {
    const authored = character();
    authored.characterId = "astronomer";
    authored.participantId = "astronomer-participant";
    authored.profile = {
      name: "Telescope Keeper",
      description: "An original observatory archivist.",
      traits: { patient: true },
      preferences: [
        {
          preferenceId: "quiet",
          subject: "quiet observation",
          stance: "like",
          description: "Prefers quiet observation",
          strength: 0.5,
        },
      ],
      speechStyle: {
        description: "Precise, gentle French.",
        languages: ["fr"],
        habits: ["asks one question"],
      },
      goals: [
        {
          goalId: "catalogue",
          description: "Catalogue distant stars.",
          priority: "normal",
          status: "desired",
        },
      ],
      authoredBiography: {
        text: "Authored astronomy fiction.",
        fictional: true,
      },
    };
    const put = memory.putCharacter(authored);
    assert.ok(put.ok, JSON.stringify(put));
    let calls = 0;
    await runBridgeRequest(
      {
        version: "ifsoul-bridge/0.1",
        hostId: "orbital-observatory",
        memoryId: "separate-memory",
        language: "fr",
        character: {
          id: authored.characterId,
          name: "Untrusted replacement",
          temperament: "careful",
        },
        requestId: "authored-profile",
        operation: "chat",
        context: "Bonjour.",
        choices: [],
        fallbackChoiceId: "",
        history: [],
      },
      {
        id: "ollama",
        async generate(input) {
          calls++;
          const prompt = JSON.parse(input.prompt);
          assert.deepEqual(prompt.character, authored.profile);
          assert.deepEqual(prompt.hostIntents, []);
          assert.doesNotMatch(
            JSON.stringify(prompt.currentBriefing),
            /herb beds|synthetic game table|lab-garden/,
          );
          return { ok: true, value: { content: "Bonjour." } };
        },
      },
      "synthetic-model",
      memory,
    );
    assert.equal(calls, 1);
    const stored = memory.getCharacter(authored.characterId);
    assert.ok(stored.ok && stored.value);
    if (stored.ok && stored.value)
      assert.deepEqual(stored.value.profile, authored.profile);
  } finally {
    memory.close();
  }
});

test("workspace and direct service retain a previously stored starter profile across upgrades", async () => {
  const { createCharacterWorkspace } =
    await import("../../apps/runtime-host/src/characters.js");
  const { createLabService, createScenarioController } =
    await import("../../apps/runtime-host/src/service.js");
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const memory = opened.value;
  try {
    const previous = character();
    previous.profile.description =
      "An original synthetic character used only by the local laboratory.";
    previous.profile.traits = { previouslyAuthored: true };
    assert.ok(memory.putCharacter(previous).ok);
    const options = {
      memory,
      chatEnvironment: "app" as const,
      controllerFor: () => createScenarioController(),
    };
    const workspace = createCharacterWorkspace(options);
    assert.ok(workspace.snapshot().ok);
    const service = createLabService(options);
    assert.ok(service.snapshot().ok);
    const nextWorkspace = createCharacterWorkspace(options);
    assert.ok(nextWorkspace.snapshot().ok);
    const stored = memory.getCharacter(previous.characterId);
    assert.ok(stored.ok && stored.value);
    if (stored.ok && stored.value)
      assert.deepEqual(stored.value.profile, previous.profile);
  } finally {
    memory.close();
  }
});
