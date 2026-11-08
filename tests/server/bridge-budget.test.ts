import assert from "node:assert/strict";
import test from "node:test";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import type { ModelClient } from "@ifsoul/core/model-providers/types";
import { runBridgeRequest } from "../../apps/server/src/bridge.js";
const request = {
  version: "ifsoul-bridge/0.1" as const,
  hostId: "synthetic-host",
  character: { id: "budget-test", name: "Test", temperament: "careful" },
  requestId: "budget",
  operation: "chat" as const,
  context: "Hello",
  choices: [],
  fallbackChoiceId: "",
  history: [],
};
test("trusted generation budget reaches the runtime timer while defaults remain unchanged", async (t) => {
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const timers: number[] = [];
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    timers.push(delay ?? 0);
    return original(callback, delay, ...args);
  }) as typeof setTimeout);
  const systems: string[] = [];
  const client = {
    id: "ollama" as const,
    async generate(input: Parameters<ModelClient["generate"]>[0]) {
      systems.push(input.system);
      const prompt = JSON.parse(input.prompt);
      assert.equal(prompt.latestUserMessage, request.context);
      assert.equal(Object.keys(prompt).at(-1), "latestUserMessage");
      return {
        ok: true as const,
        value: { content: "Hello" },
      };
    },
  };
  try {
    await runBridgeRequest(
      { ...request, language: "ru" },
      client,
      "test",
      opened.value,
      {
        generationTimeoutMs: 50000,
        promptBudgetBytes: 10000,
      },
    );
    assert.ok(timers.includes(50000), JSON.stringify(timers));
    timers.length = 0;
    const untrustedRequest = {
      ...request,
      requestId: "default",
      generationTimeoutMs: 50000,
    };
    await runBridgeRequest(untrustedRequest, client, "test", opened.value);
    assert.ok(timers.includes(25000), JSON.stringify(timers));
    assert.match(systems[0]!, /explicitly requested language locale ru/);
    assert.match(systems[1]!, /Use only latestUserMessage/);
    assert.match(systems[1]!, /Ignore the language of historical messages/);
    assert.ok(
      systems[1]!.endsWith(
        "Do not continue the previous reply's language when the latest user message changes language.",
      ),
    );
    assert.match(systems[0]!, /SDK language selection overrides/);
    for (const promptBudgetBytes of [7999, 21001, 10000.5, NaN])
      await assert.rejects(
        runBridgeRequest(request, client, "test", opened.value, {
          promptBudgetBytes,
        }),
        RangeError,
      );
    for (const generationTimeoutMs of [0, -1, 55001, 1.5, NaN])
      await assert.rejects(
        runBridgeRequest(request, client, "test", opened.value, {
          generationTimeoutMs,
        }),
        RangeError,
      );
  } finally {
    opened.value.close();
  }
});

test("maximum accepted temperament and a fresh independent memory owner fit the fallback profile schema", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert(opened.ok);
  if (!opened.ok) return;
  const memory = opened.value;
  const temperament = "x".repeat(160);
  let calls = 0;
  try {
    const result = await runBridgeRequest(
      {
        ...request,
        version: "ifsoul-bridge/0.3.0",
        memoryId: "fresh-owner",
        character: { id: "unseen-portrayal", name: "Original", temperament },
      },
      {
        id: "ollama",
        async generate() {
          calls++;
          return {
            ok: true,
            value: { content: "Hello from an original synthetic host." },
          };
        },
      },
      "synthetic",
      memory,
    );
    assert.equal(result.source, "llm");
    assert.equal(calls, 1);
    const stored = memory.getCharacter("fresh-owner");
    assert(stored.ok && stored.value);
    if (!stored.ok || !stored.value) return;
    assert.equal(stored.value.profile.traits.temperament, temperament);
    assert(stored.value.profile.speechStyle.description.length <= 500);
    assert.equal(stored.value.schemaVersion, "0.3.0");
  } finally {
    memory.close();
  }
});
