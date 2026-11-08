import assert from "node:assert/strict";
import test from "node:test";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import type { ModelClient } from "@ifsoul/core/model-providers/types";
import {
  createLabService,
  createModelController,
} from "../../apps/runtime-host/src/service.js";
import { character } from "../../apps/runtime-host/src/default-context.js";
import {
  recordBridgeRequest,
  inspectBridgeMemory,
} from "../../apps/runtime-host/src/bridge-memory.js";

test("App author UUIDs and full reported outcomes fit relationship generation and revision with explicit 32KB policy", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const memory = opened.value;
  const profile = character();
  profile.characterId = "character-00000000-0000-4000-a000-000000000001";
  profile.participantId = "participant-00000000-0000-4000-a000-000000000001";
  profile.profile.name = "Mira Venn";
  profile.profile.description =
    "An observant, kind mechanic who prefers careful promises, but is wary of people who break them.";
  profile.profile.authoredBiography = {
    fictional: true,
    text: "Mira grew up in a small riverside workshop and learned to repair baskets and tools. This background is fictional and not evidence of any shared event.",
  };
  let calls = 0;
  const client: ModelClient = {
    id: "ollama",
    async generate(input) {
      calls++;
      const reflection = JSON.parse(input.prompt).memoryReflection;
      assert.ok(reflection, `App call ${calls} must carry reflection`);
      if (calls === 2)
        assert.equal(
          reflection.previous.find((p: any) => p.kind === "subjective-belief")
            .value,
          "Tentative cooperation from reported help.",
        );
      return {
        ok: true,
        value: {
          content:
            "I remember the reported experiences, with some uncertainty.",
          memoryUpdates: [
            {
              kind: "subjective-belief",
              subjectId: `character:${profile.characterId}`,
              targetId: reflection.playerSubjectId,
              key: calls === 1 ? "cooperation" : "caution",
              value:
                calls === 1
                  ? "Tentative cooperation from reported help."
                  : "More caution after a reported broken promise.",
              confidence: calls === 1 ? 0.6 : 0.45,
              reason:
                calls === 1
                  ? "Two distinct reported outcomes suggest cooperation."
                  : "The new contrary report changes my earlier view.",
              sourceIds: reflection.sources.slice(0, 2).map((s: any) => s.id),
              evidenceQuote: reflection.sources[0].excerpt.slice(0, 160),
            },
          ],
        },
      };
    },
  };
  const observe = (hostId: string, id: string, summary: string) =>
    recordBridgeRequest(memory, profile.characterId, {
      version: "ifsoul-bridge/0.1",
      hostId,
      memoryId: profile.characterId,
      character: {
        id: profile.characterId,
        name: profile.profile.name,
        temperament: "careful",
      },
      requestId: id,
      operation: "chat",
      context: "Reported synthetic outcomes.",
      choices: [],
      fallbackChoiceId: "",
      history: [
        {
          id,
          hostId,
          summary,
          kind: "observation",
          eventKind: "outcome",
          actor: "user",
          recipient: "agent",
          observer: "agent",
          perspectiveCharacterId: profile.characterId,
        },
      ],
    });
  try {
    assert.ok(memory.putCharacter(profile).ok);
    observe(
      "garden",
      "pouch-returned",
      "At the riverside garden, the player found the seed pouch Mira had dropped and returned it to her. Mira and the player repaired the split harvest basket together; it held water again.",
    );
    observe(
      "friendly-21",
      "token-returned",
      "After the card round, the player returned Mira's brass token and patiently explained the rule Mira had missed. The player and Mira then finished the practice round together.",
    );
    const service = createLabService({
      memory,
      character: profile,
      chatEnvironment: "app",
      controllerFor: () =>
        createModelController({
          client,
          model: "synthetic",
          reflection: { memory },
          promptBudgetBytes: 32768,
          promptBudgetCeilingBytes: 32768,
        }),
    });
    const first = await service.run({
      operation: "chat",
      requestId: "initial-app-reflection",
      provider: "ollama",
      model: "synthetic",
      message:
        "What stands out to you about our reported experiences together?",
    });
    assert.ok(first.ok);
    if (!first.ok) return;
    assert.equal(first.value.result.type, "chat");
    const initial = inspectBridgeMemory(memory, profile.characterId).reflection
      .relationships[0]!;
    assert.ok(initial);
    observe(
      "garden",
      "promise-broken",
      "The player promised to return Mira's seed packet by dusk, but kept it. At dusk Mira reported that her packet was still missing.",
    );
    const second = await service.run({
      operation: "chat",
      requestId: "revised-app-reflection",
      provider: "ollama",
      model: "synthetic",
      message:
        "Considering both the earlier reports and the latest event, how do you view our cooperation now?",
    });
    assert.ok(second.ok);
    if (!second.ok) return;
    assert.equal(second.value.result.type, "chat");
    assert.equal(calls, 2);
    const revised = inspectBridgeMemory(memory, profile.characterId).reflection
      .relationships[0]!;
    assert.equal(revised.id, initial.id);
    assert.equal(revised.revision, 2);
    assert.equal(revised.history[0]!.value, initial.value);
  } finally {
    memory.close();
  }
});
