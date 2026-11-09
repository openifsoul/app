import assert from "node:assert/strict";
import test from "node:test";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import { createAPI } from "../../apps/server/src/api.js";
import {
  resolveAppResourcePolicy,
  AppResourceError,
} from "../../apps/server/src/resource-policy.js";
import { boundedJSON } from "../../apps/server/src/security.js";
import { createCharacterWorkspace } from "../../apps/runtime-host/src/characters.js";
import {
  createScenarioController,
  createLabService,
  createModelController,
  SCENARIO_MODEL,
  fitModelPrompt,
} from "../../apps/runtime-host/src/service.js";
import {
  observeBridgeRequest,
  type BridgeRequest,
} from "../../apps/server/src/bridge.js";
import { inspectBridgeMemory } from "../../apps/runtime-host/src/bridge-memory.js";
import { prepareBridgeReflection } from "../../apps/runtime-host/src/bridge-reflection.js";
const origin = "http://127.0.0.1:8891";
const incoming = (path: string, body?: unknown) =>
  new Request(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      host: "127.0.0.1:8891",
      origin,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const batch: BridgeRequest = {
  version: "ifsoul-bridge/0.4.0",
  hostId: "original-garden",
  memoryId: "resource-character",
  character: { id: "resource-character", name: "Mira", temperament: "careful" },
  requestId: "resource-batch",
  operation: "chat",
  context: "Record original reported outcomes only.",
  choices: [],
  fallbackChoiceId: "",
  history: Array.from({ length: 64 }, (_, i) => ({
    id: `help-${i}`,
    hostId: "original-garden",
    summary: "Игрок помог Мире. " + "я".repeat(230),
    kind: "observation",
    eventKind: "outcome",
    actor: "user",
    recipient: "agent",
    observer: "agent",
    perspectiveCharacterId: "resource-character",
  })),
};

test("operator-configured 32–64KB App ingress/bridge retains attributed reports; low policy rejects and bodies cannot escalate", async () => {
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) > 32768);
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) < 65536);
  for (const enabled of [false, true]) {
    const opened = openSQLiteMemory(":memory:");
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const memory = opened.value;
    const policy = resolveAppResourcePolicy(
      enabled
        ? {
            http: { bodyBytes: 65536 },
            bridge: {
              maxRequestBytes: 65536,
              maxHistoryEntries: 64,
              sentHistoryEntries: 64,
            },
          }
        : {},
    );
    const values = new Map<string, string>();
    let generations = 0;
    const api = createAPI({
      mode: "local",
      access: { kind: "local", origin },
      resourcePolicy: policy,
      password: "synthetic-password",
      encryptionKey: "synthetic-encryption-key",
      store: {
        get: (key) => values.get(key),
        set: (key, value) => {
          values.set(key, value);
        },
        delete: (key) => {
          values.delete(key);
        },
      },
      service: createCharacterWorkspace({
        memory,
        controllerFor: () => {
          generations++;
          return createScenarioController();
        },
      }),
      providers: async () => [
        {
          id: "scenario",
          label: "Scenario",
          available: true,
          models: [{ id: SCENARIO_MODEL, label: "Scenario" }],
        },
      ],
      observeBridge: (body) =>
        observeBridgeRequest(body, memory, {
          bridgeLimits: policy.bridge,
          retainedHistoryEntries: policy.retainedHistoryEntries,
        }),
    });
    try {
      const response = await api(
        incoming("/api/bridge/observations", {
          ...batch,
          resourcePolicy: { http: { bodyBytes: 1024 ** 3 } },
        }),
      );
      assert.equal(response.status, enabled ? 200 : 413);
      const metadata = await (
        await api(incoming("/api/resource-policy"))
      ).json();
      assert.equal(metadata.http.bodyBytes, enabled ? 65536 : 16384);
      assert.equal(metadata.bridge.limits.maxHistoryEntries, enabled ? 64 : 12);
      assert.equal(generations, 0);
      if (enabled) {
        const entries = inspectBridgeMemory(
          memory,
          "resource-character",
        ).entries;
        const reports = JSON.parse(entries[0]!.summary).browserReports;
        assert.equal(reports.length, 64);
        assert.equal(reports[63].actor, "user");
        assert.equal(reports[63].perspectiveCharacterId, "resource-character");
        const reflection = prepareBridgeReflection(
          memory,
          "resource-character",
          "resource-character",
          false,
          { maxBytes: 65536, maxSources: 64 },
        );
        assert.ok(reflection);
        assert.ok(reflection.input.sources.length > 24);
        assert.ok(
          reflection.input.sources.every(
            (s) => s.hostId === "original-garden" && s.actor === "user",
          ),
        );
        reflection.complete([]);
      }
      const foreign = incoming("/api/resource-policy");
      foreign.headers.set("origin", "https://foreign.test");
      assert.equal((await api(foreign)).status, 403);
    } finally {
      memory.close();
    }
  }
});

test("App policy separates implementation, provider/model tokens and deadlines; one GiB is unsupported without allocation", () => {
  assert.throws(
    () => resolveAppResourcePolicy({ http: { bodyBytes: 1024 ** 3 } }),
    (error) =>
      error instanceof AppResourceError && error.code === "unsupported-policy",
  );
  assert.throws(
    () => resolveAppResourcePolicy({ ollama: { generationTimeoutMs: 100000 } }),
    /deadline-chain/,
  );
  assert.throws(
    () => resolveAppResourcePolicy({ bridge: { maxContextChars: 5000 } }),
    /core-contract/,
  );
  assert.throws(
    () => resolveAppResourcePolicy({ unknown: 1 } as never),
    /configuration/,
  );
  const high = resolveAppResourcePolicy({
    ollama: {
      promptBytes: 65536,
      promptCeilingBytes: 65536,
      generationTimeoutMs: 90000,
      limits: { timeoutMs: 95000 },
      ceilings: { timeoutMs: 95000 },
      contexts: {
        "qwen3:8b": {
          windowTokens: 8192,
          modelMaxTokens: 40960,
          source: "operator",
          estimate: { bytesPerToken: 2, overheadTokens: 128 },
        },
      },
    },
    runtime: {
      limits: { controllerTimeoutMs: 100000 },
      ceilings: { controllerTimeoutMs: 100000 },
    },
    browserTimeoutMs: 110000,
  });
  assert.equal(high.ollama.provider.effective.maxOutputTokens, 2000);
  assert.equal(high.metadata.model.contexts["qwen3:8b"].accounting, "estimate");
  assert.equal(high.metadata.model.bytesAreTokens, false);
  assert.equal(high.metadata.model.contextWhenUnlisted, "unknown");
  const prompt = { question: "x".repeat(32768) };
  assert.throws(
    () => fitModelPrompt({ ...prompt }, "system", {}, 65536),
    RangeError,
  );
  assert.equal(
    JSON.parse(fitModelPrompt({ ...prompt }, "system", {}, 65536, 65536))
      .question.length,
    32768,
  );
});

test("declared/chunked ingress budgets cancel before full buffering", async () => {
  let pulls = 0,
    cancelled = 0;
  const declared = new Request(origin, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(1024 ** 3),
    },
    body: new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls++;
          c.enqueue(new Uint8Array(10));
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    ),
    duplex: "half",
  } as RequestInit);
  await assert.rejects(
    boundedJSON(declared, 1000),
    (error) =>
      error instanceof AppResourceError && error.code === "budget-exceeded",
  );
  assert.equal(pulls, 0);
  assert.equal(cancelled, 1);
  const chunked = new Request(origin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls++;
          c.enqueue(new Uint8Array(600));
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    ),
    duplex: "half",
  } as RequestInit);
  await assert.rejects(
    boundedJSON(chunked, 1000),
    (error) =>
      error instanceof AppResourceError && error.code === "budget-exceeded",
  );
  assert.equal(pulls, 2);
  assert.equal(cancelled, 2);
});

test("HTTP reception waits are distinct configurable units and unsupported provider policy propagates safely", async () => {
  const configured = resolveAppResourcePolicy({
    http: { requestTimeoutMs: 90000, headersTimeoutMs: 12000 },
  });
  assert.equal(configured.http.requestTimeoutMs, 90000);
  assert.equal(configured.http.headersTimeoutMs, 12000);
  assert.equal(
    configured.metadata.model.provider.effective.maxOutputTokens,
    2000,
  );
  assert.throws(
    () =>
      resolveAppResourcePolicy({
        http: { requestTimeoutMs: 100, headersTimeoutMs: 101 },
      }),
    /header-timeout/,
  );
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  try {
    const service = createLabService({
      memory: opened.value,
      controllerFor: () =>
        createModelController({
          model: "synthetic",
          client: {
            id: "ollama",
            async generate() {
              return {
                ok: false,
                error: {
                  code: "unsupported-policy",
                  message: "synthetic-upstream-detail",
                },
              };
            },
          },
        }),
    });
    const result = await service.run({
      operation: "chat",
      requestId: "unsupported-window",
      provider: "ollama",
      model: "synthetic",
      message: "A short original request.",
    });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.result.type, "failure");
    if (result.value.result.type === "failure") {
      assert.equal(result.value.result.error.code, "unsupported-policy");
      assert.doesNotMatch(
        result.value.result.error.message,
        /synthetic-upstream-detail/,
      );
    }
  } finally {
    opened.value.close();
  }
});
