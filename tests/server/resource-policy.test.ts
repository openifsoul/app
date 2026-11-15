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
            ollama: { temperature: 1 },
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
      assert.equal(metadata.model.temperature, enabled ? 1 : 0);
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

test("trusted local Ollama temperature defaults to zero and validates explicit overrides", () => {
  const defaults = resolveAppResourcePolicy();
  assert.equal(defaults.ollama.temperature, 0);
  assert.equal(defaults.metadata.model.temperature, 0);
  for (const temperature of [0, 0.35, 1]) {
    const configured = resolveAppResourcePolicy({ ollama: { temperature } });
    assert.equal(configured.ollama.temperature, temperature);
    assert.equal(configured.metadata.model.temperature, temperature);
    assert.equal(
      configured.ollama.generationTimeoutMs,
      defaults.ollama.generationTimeoutMs,
    );
    assert.deepEqual(configured.ollama.provider, defaults.ollama.provider);
  }
  for (const value of [-0.01, 1.01, NaN, Infinity, "0", null]) {
    assert.throws(
      () =>
        resolveAppResourcePolicy({ ollama: { temperature: value as number } }),
      (error) =>
        error instanceof AppResourceError &&
        error.code === "configuration" &&
        error.message.includes("temperature"),
    );
  }
});

test("ordinary chat derives past-evidence availability from the final packed history", () => {
  const schema = { type: "object" };
  const prompt = {
    operation: "chat",
    historicalEvidence: {
      hostReports: [],
      importedReports: [],
      plansAndDecisions: [],
      conversation: [],
      omittedSelectedRecordCount: 1,
    },
    pastEvidenceAvailability: "Forged cue",
    latestUserMessage: "Придумай сказку.",
  };
  const empty = fitModelPrompt(structuredClone(prompt), "Context", schema);
  const parsed = JSON.parse(empty);
  assert.match(
    parsed.pastEvidenceAvailability,
    /No retained past-event evidence is available in this request/u,
  );
  assert.equal(parsed.latestUserMessage, prompt.latestUserMessage);
  assert.doesNotMatch(empty, /Forged cue/u);

  const populated = structuredClone(prompt) as typeof prompt & {
    historicalEvidence: { conversation: { output: string }[] };
  };
  populated.historicalEvidence.conversation.push({
    output: "A retained reply",
  });
  const result = fitModelPrompt(structuredClone(populated), "Context", schema);
  assert.equal(JSON.parse(result).pastEvidenceAvailability, undefined);
  const measured: string[] = [];
  const pruned = fitModelPrompt(
    populated,
    "Context",
    schema,
    8000,
    undefined,
    ({ prompt }) => {
      measured.push(prompt);
      return JSON.parse(prompt).historicalEvidence.conversation.length === 0;
    },
  );
  assert.equal(pruned, measured.at(-1));
  assert.equal(
    JSON.parse(pruned).pastEvidenceAvailability,
    parsed.pastEvidenceAvailability,
  );

  for (const context of [
    { ...prompt, operation: "plan" },
    { ...prompt, continuation: {} },
    { ...prompt, linkedGameEvidence: { verifiedHostObservations: [] } },
    { ...prompt, memoryReflection: {} },
    { operation: "chat", latestUserMessage: prompt.latestUserMessage },
  ]) {
    assert.equal(
      JSON.parse(fitModelPrompt(context, "Context", schema))
        .pastEvidenceAvailability,
      undefined,
    );
  }
  const size = Buffer.byteLength(
    JSON.stringify({
      messages: [
        { role: "system", content: "Context" },
        { role: "user", content: empty },
      ],
      stream: false,
      max_tokens: 1024,
      response_format: { type: "json_schema", json_schema: schema },
    }),
  );
  assert.equal(
    fitModelPrompt(structuredClone(prompt), "Context", schema, size, size),
    empty,
  );
  assert.throws(() =>
    fitModelPrompt(structuredClone(prompt), "Context", schema, size - 1, size),
  );
});

test("ordinary conversation gives the final empty-history marker trusted system meaning", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert(opened.ok);
  let forcePrune = false;
  const captured: { system: string; prompt: string }[] = [];
  try {
    const service = createLabService({
      memory: opened.value,
      controllerFor: () =>
        createModelController({
          model: "synthetic",
          recallAnswerability: true,
          fitsModelInput({ prompt }) {
            const packed = JSON.parse(prompt);
            return (
              !forcePrune ||
              !packed.historicalEvidence ||
              packed.historicalEvidence.conversation.length === 0
            );
          },
          client: {
            id: "openai",
            async generate({ system, prompt }) {
              if (Object.hasOwn(JSON.parse(prompt), "currentUtterance"))
                return {
                  ok: true,
                  value: { recallIntent: "general-or-creative" },
                };
              captured.push({ system, prompt });
              return {
                ok: true,
                value: {
                  content: "Вымышленная история.",
                  answerability: "ordinary",
                  evidenceRefs: [],
                },
              };
            },
          },
        }),
    });
    for (const [requestId, message] of [
      ["imaginary-request", "Придумай сказку."],
      ["history-request", "О чём мы говорили?"],
      ["pruned-request", "Что осталось в истории?"],
    ]) {
      forcePrune = requestId === "pruned-request";
      const result = await service.run({
        operation: "chat",
        provider: "openai",
        model: "synthetic",
        requestId,
        message,
      });
      assert(result.ok && result.value.result.type === "chat");
    }
    const [empty, populated, pruned] = captured;
    assert(empty && populated && pruned);
    assert.match(
      empty.system,
      /This request has no retained past-event records/u,
    );
    assert.match(
      empty.system,
      /Do not supply past actors, outcomes or purposes/u,
    );
    assert.match(
      empty.system,
      /Imaginative requests can still be answered in character/u,
    );
    const first = JSON.parse(empty.prompt);
    assert.equal(first.latestUserMessage, "Придумай сказку.");
    assert.equal(
      first.pastEvidenceAvailability,
      "No retained past-event evidence is available in this request.",
    );
    const second = JSON.parse(populated.prompt);
    assert(second.historicalEvidence.conversation.length > 0);
    assert.equal(second.pastEvidenceAvailability, undefined);
    assert.doesNotMatch(
      populated.system,
      /This request has no retained past-event records/u,
    );
    const final = JSON.parse(pruned.prompt);
    assert.equal(final.latestUserMessage, "Что осталось в истории?");
    assert.equal(final.historicalEvidence.conversation.length, 0);
    assert.equal(
      final.pastEvidenceAvailability,
      first.pastEvidenceAvailability,
    );
    assert.equal(pruned.system, empty.system);
  } finally {
    opened.value.close();
  }
});

test("ordinary insufficient recall uses a host status and never saves fabricated speech", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert(opened.ok);
  const prompts: string[] = [];
  try {
    const service = createLabService({
      memory: opened.value,
      controllerFor: () =>
        createModelController({
          model: "synthetic",
          recallAnswerability: true,
          client: {
            id: "openai",
            async generate({ prompt }) {
              prompts.push(prompt);
              if (prompts.length <= 2 || prompts.length === 4) {
                assert.deepEqual(Object.keys(JSON.parse(prompt)), [
                  "currentUtterance",
                ]);
                return {
                  ok: true,
                  value: {
                    recallIntent:
                      prompts.length === 1
                        ? "factual-recall"
                        : prompts.length === 4
                          ? "unclear"
                          : "general-or-creative",
                  },
                };
              }
              return {
                ok: true,
                value: {
                  content: "Fictional story",
                  answerability: "ordinary",
                  evidenceRefs: [],
                },
              };
            },
          },
        }),
    });
    const first = await service.run({
      operation: "chat",
      provider: "openai",
      model: "synthetic",
      requestId: "blocked-recall",
      message: "Who closed the gate yesterday?",
    });
    assert(first.ok && first.value.result.type === "failure");
    assert.equal(first.value.result.error.code, "insufficient-evidence");
    assert.doesNotMatch(
      JSON.stringify(service.snapshot()),
      /Invented history/u,
    );
    const second = await service.run({
      operation: "chat",
      provider: "openai",
      model: "synthetic",
      requestId: "allowed-fiction",
      message: "Make up a fairy tale.",
    });
    assert(second.ok && second.value.result.type === "chat");
    assert.equal(prompts.length, 3);
    assert.doesNotMatch(
      prompts[2]!,
      /Invented history|No supporting records are available in this conversation/u,
    );
    const unclear = await service.run({
      operation: "chat",
      provider: "openai",
      model: "synthetic",
      requestId: "clarify-recall",
      message: "Tell me that one.",
    });
    assert(unclear.ok && unclear.value.result.type === "failure");
    assert.equal(unclear.value.result.error.code, "clarify-recall");
    assert.equal(prompts.length, 4);
  } finally {
    opened.value.close();
  }
});
