import assert from "node:assert/strict";
import test from "node:test";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import type { ModelClient } from "@ifsoul/core/model-providers/types";
import type { Result } from "@ifsoul/core/memory/port";
import {
  createLabService,
  createModelController,
} from "../../apps/runtime-host/src/service.js";
import { character } from "../../apps/runtime-host/src/default-context.js";
import {
  recordBridgeRequest,
  inspectBridgeMemory,
} from "../../apps/runtime-host/src/bridge-memory.js";
const unwrap = <T>(r: Result<T>): T => {
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) throw Error();
  return r.value;
};
const malformed = [
  'Ты хочешь перейти?","tasks":[]}',
  'Нужно перейти?", "tasks": [], "memoryUpdates": [] }',
  'The garden is ready.","memoryUpdates":[]}',
];
for (const content of malformed)
  test(`reject model protocol tail before dialogue persistence: ${content}`, async () => {
    const memory = unwrap(openSQLiteMemory(":memory:"));
    try {
      const c = character();
      unwrap(memory.putCharacter(c));
      recordBridgeRequest(memory, c.characterId, {
        version: "ifsoul-bridge/0.1",
        hostId: "original-garden",
        character: {
          id: c.characterId,
          name: c.profile.name,
          temperament: "curious",
        },
        requestId: "reported-help",
        operation: "chat",
        context: "Synthetic evidence only.",
        choices: [],
        fallbackChoiceId: "",
        history: [
          {
            id: "help-outcome",
            hostId: "original-garden",
            kind: "observation",
            eventKind: "outcome",
            actor: "user",
            observer: "agent",
            recipient: "agent",
            perspectiveCharacterId: c.characterId,
            summary: "The player helped the companion.",
          },
        ],
      });
      let calls = 0;
      const client: ModelClient = {
        id: "ollama",
        async generate(input) {
          calls++;
          assert.equal(input.schema.additionalProperties, false);
          assert.equal("tasks" in (input.schema.properties as object), false);
          assert.match(
            input.system,
            /This is a conversation, not a planning request/,
          );
          assert.doesNotMatch(input.system, /For a new plan choose/);
          const reflection = JSON.parse(input.prompt).memoryReflection;
          assert.ok(reflection);
          const source = reflection.sources[0];
          // A syntactically valid provider JSON object can still contain leaked JSON
          // syntax inside the content string. Provider JSON.parse must not "repair" it.
          return {
            ok: true,
            value: JSON.parse(
              JSON.stringify({
                content,
                memoryUpdates: [
                  {
                    kind: "subjective-belief",
                    subjectId: `character:${c.characterId}`,
                    targetId: reflection.playerSubjectId,
                    key: "cooperation",
                    value: "The player helped me.",
                    confidence: 0.4,
                    reason: "A reported help outcome.",
                    sourceIds: [source.id],
                    evidenceQuote: source.excerpt,
                  },
                ],
              }),
            ),
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
            reflection: {
              memory,
              memoryId: c.characterId,
              perspectiveCharacterId: c.characterId,
            },
          }),
      });
      const result = unwrap(
        await service.run({
          requestId: "invalid-generated-dialogue",
          operation: "chat",
          provider: "ollama",
          model: "synthetic",
          message: "Что ты помнишь?",
        }),
      );
      assert.equal(calls, 1);
      assert.equal(result.result.type, "failure");
      assert.equal(
        result.memories.some(
          (e) =>
            e.eventType === "conversation-response" ||
            e.eventType === "conversation-delivery",
        ),
        false,
      );
      assert.equal(JSON.stringify(result).includes(content), false);
      assert.equal(
        inspectBridgeMemory(memory, c.characterId).reflection.relationships
          .length,
        0,
      );
      if (result.result.type === "failure")
        assert.equal(result.result.error.code, "invalid-response");
    } finally {
      memory.close();
    }
  });

for (const content of [
  "Он сказал: «Перейти?» — и остановился.",
  'Пример JSON: {"content":"Перейти?","tasks":[]}',
  'В строке может быть суффикс `","tasks":[]}`.',
  '```json\n{"content":"Привет","memoryUpdates":[]}\n```',
  'The literal suffix is \'","tasks":[]}\'.',
  "Обычные {скобки} и [пометки] разрешены.",
])
  test(`retain literal JSON, code and normal quotation unchanged: ${content}`, async () => {
    const memory = unwrap(openSQLiteMemory(":memory:"));
    try {
      const client: ModelClient = {
        id: "ollama",
        async generate() {
          return { ok: true, value: { content } };
        },
      };
      const service = createLabService({
        memory,
        chatEnvironment: "app",
        controllerFor: () =>
          createModelController({ client, model: "synthetic" }),
      });
      const result = unwrap(
        await service.run({
          requestId: "literal-example",
          operation: "chat",
          provider: "ollama",
          model: "synthetic",
          message: "Объясни пример JSON.",
        }),
      );
      assert.equal(result.result.type, "chat");
      if (result.result.type === "chat")
        assert.equal(result.result.response.output.type, "utterance");
      if (
        result.result.type === "chat" &&
        result.result.response.output.type === "utterance"
      )
        assert.equal(result.result.response.output.content, content);
    } finally {
      memory.close();
    }
  });
