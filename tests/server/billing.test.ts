import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import { createAPI } from "../../apps/server/src/api.js";
import {
  createCharacterWorkspace,
  createScenarioController,
} from "../../apps/server/src/index.js";
import {
  estimateCustomerCost,
  type BillingSnapshot,
} from "../../apps/server/src/billing.js";
import { IDS } from "../../apps/runtime-host/src/default-context.js";
const tariff = {
  version: "synthetic-final-1",
  model: "synthetic",
  inputMicrodollarsPerMillion: 879000,
  outputMicrodollarsPerMillion: 6759000,
  requestMicrodollars: 3,
};
test("neutral customer capability exposes final prices, optimistic limits and estimator behind owner origin", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert(opened.ok);
  if (!opened.ok) return;
  let state: BillingSnapshot = {
    version: "ifsoul-billing-view/0.4.0",
    currency: "USD",
    availableMicrodollars: 1000000,
    reservedMicrodollars: 0,
    promotionalMicrodollars: 1000000,
    spentMicrodollars: 0,
    limits: {
      revision: 1,
      dailyMicrodollars: 1000000,
      sessionMicrodollars: 250000,
      paused: false,
    },
    tariffs: [tariff],
    expenses: [],
  };
  const api = createAPI({
    mode: "local",
    access: { kind: "local", origin: "http://127.0.0.1:8799" },
    password: "",
    encryptionKey: "synthetic",
    store: { get: () => undefined, set: () => {}, delete: () => {} },
    service: createCharacterWorkspace({
      memory: opened.value,
      controllerFor: () => createScenarioController(),
      chatEnvironment: "app",
    }),
    providers: async () => [],
    billing: {
      read: async () => structuredClone(state),
      updateLimits: async (l) => {
        if (l.revision !== state.limits.revision) throw Error();
        state = { ...state, limits: { ...l, revision: l.revision + 1 } };
        return structuredClone(state);
      },
    },
  });
  const request = (
    path: string,
    body?: unknown,
    origin = "http://127.0.0.1:8799",
  ) =>
    api(
      new Request(`http://127.0.0.1:8799/api/${path}`, {
        method: body ? "PUT" : "GET",
        headers: {
          host: "127.0.0.1:8799",
          origin,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  try {
    assert.equal(
      (await request("billing", undefined, "https://foreign.invalid")).status,
      403,
    );
    const view = await (await request("billing")).json();
    assert(view.available);
    assert(
      !/multiplier|margin|baseCost|providerCost/.test(JSON.stringify(view)),
    );
    const estimate = await (
      await request(
        "billing/estimate?model=synthetic&inputTokens=1000&outputTokens=200&calls=2",
      )
    ).json();
    assert.equal(
      estimate.microdollars,
      estimateCustomerCost(tariff, 1000, 200, 2),
    );
    const next = { ...state.limits, paused: true };
    assert.equal((await request("billing/limits", next)).status, 200);
    assert.equal((await request("billing/limits", next)).status, 409);
    assert.equal((await request("characters")).status, 200);
  } finally {
    opened.value.close();
  }
});
test("local memory remains same durable identity across provider switches and service restart without account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ifsoul-memory-modes-"));
  let memory: ReturnType<typeof openSQLiteMemory>;
  try {
    memory = openSQLiteMemory(join(dir, "memory.sqlite"));
    assert(memory.ok);
    if (!memory.ok) return;
    let service = createCharacterWorkspace({
      memory: memory.value,
      chatEnvironment: "app",
      controllerFor: () => createScenarioController(),
    });
    for (const [i, provider] of (
      ["ollama", "openai", "cloudflare"] as const
    ).entries()) {
      const result = await service.run({
        characterId: IDS.character,
        operation: "chat",
        requestId: `switch-${i}`,
        message: `Synthetic ${provider} provider memory`,
        provider,
        model: "synthetic",
      });
      assert(result.ok);
    }
    const before = service.snapshot(IDS.character);
    memory.value.close();
    memory = openSQLiteMemory(join(dir, "memory.sqlite"));
    assert(memory.ok);
    if (!memory.ok) return;
    service = createCharacterWorkspace({
      memory: memory.value,
      chatEnvironment: "app",
      controllerFor: () => createScenarioController(),
    });
    assert.deepEqual(service.snapshot(IDS.character), before);
    memory.value.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
