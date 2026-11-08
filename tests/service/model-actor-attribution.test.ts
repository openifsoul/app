import assert from "node:assert/strict";
import test from "node:test";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import type { ModelClient } from "@ifsoul/core/model-providers/types";
import {
  createLabService,
  createModelController,
} from "../../apps/runtime-host/src/service.js";
import { character } from "../../apps/runtime-host/src/default-context.js";
import { recordBridgeRequest } from "../../apps/runtime-host/src/bridge-memory.js";

test("App's packed local-model prompt preserves historical actors separately from observers", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const memory = opened.value;
  try {
    const c = character();
    assert.ok(memory.putCharacter(c).ok);
    recordBridgeRequest(memory, c.characterId, {
      version: "ifsoul-bridge/0.1",
      hostId: "garden",
      requestId: "synthetic-actors",
      character: {
        id: c.characterId,
        name: c.profile.name,
        temperament: "careful",
      },
      operation: "speak",
      context: "Reported original host events.",
      choices: [],
      fallbackChoiceId: "",
      history: [
        {
          id: "synthetic-compost",
          hostId: "garden",
          kind: "observation",
          eventKind: "outcome",
          actor: "agent",
          observer: "user",
          recipient: "unknown",
          actorCharacterId: c.characterId,
          actorCharacterName: c.profile.name,
          perspectiveCharacterId: c.characterId,
          summary:
            "The companion used one portion of compost on bed 1. This bed will yield an extra fruit.",
        },
        {
          id: "synthetic-stand",
          hostId: "cards",
          kind: "observation",
          eventKind: "outcome",
          actor: "user",
          observer: "agent",
          recipient: "unknown",
          perspectiveCharacterId: c.characterId,
          summary: "The player stood with 19 points.",
        },
        {
          id: "synthetic-unknown",
          hostId: "garden",
          kind: "observation",
          actor: "unknown",
          observer: "user",
          perspectiveCharacterId: c.characterId,
          summary: "An unidentified visitor moved a stone.",
        },
      ],
    });
    let calls = 0;
    const client: ModelClient = {
      id: "ollama",
      async generate(input) {
        calls++;
        assert.match(
          input.system,
          /Attribute actions to the stored actor, never to the observer or recipient/,
        );
        assert.match(input.system, /Unknown actors stay unknown/);
        assert.match(
          input.system,
          /Generated dialogue and opinions cannot override/,
        );
        const prompt = JSON.parse(input.prompt);
        const reports = prompt.continuation.reports;
        const compost = reports.find((r: any) => r.summary.includes("compost"));
        assert.ok(compost);
        assert.equal(compost.actor, "agent");
        assert.equal(compost.observer, "user");
        assert.equal(compost.actorCharacterId, c.characterId);
        assert.equal(compost.actorCharacterName, c.profile.name);
        const stand = reports.find((r: any) => r.summary.includes("stood"));
        assert.equal(stand.actor, "user");
        assert.equal(stand.observer, "agent");
        const unknown = reports.find((r: any) =>
          r.summary.includes("unidentified"),
        );
        assert.equal(unknown.actor, "unknown");
        assert.equal(unknown.actorCharacterId, undefined);
        return {
          ok: true,
          value: { content: "A synthetic attributed reply." },
        };
      },
    };
    const service = createLabService({
      memory,
      chatEnvironment: "app",
      controllerFor: () =>
        createModelController({
          client,
          model: "synthetic",
          promptBudgetBytes: 10_000,
        }),
    });
    const result = await service.run({
      operation: "chat",
      requestId: "synthetic-attribution-chat",
      message: "What happened in the garden and card game?",
      provider: "ollama",
      model: "synthetic",
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(calls, 1);
  } finally {
    memory.close();
  }
});
