import assert from "node:assert/strict";
import test from "node:test";
import { createAPI } from "../../apps/server/src/api.js";
import {
  createCharacterWorkspace,
  createScenarioController,
} from "../../apps/server/src/index.js";
import { runBridgeRequest } from "../../apps/server/src/bridge.js";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";

test("generic bridge route requires trusted local origin and an explicit available model", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  let calls = 0;
  const api = createAPI({
    mode: "local",
    password: "",
    encryptionKey: "synthetic",
    access: { kind: "local", origin: "http://127.0.0.1:8788" },
    store: { get: () => undefined, set: () => {}, delete: () => {} },
    providers: async () => [
      {
        id: "ollama",
        label: "Synthetic connection",
        available: true,
        models: [{ id: "test-model", label: "Test" }],
      },
    ],
    service: createCharacterWorkspace({
      memory: opened.value,
      controllerFor: () => createScenarioController(),
      chatEnvironment: "app",
    }),
    bridge: async (body, selection) =>
      runBridgeRequest(
        body,
        {
          id: "ollama",
          async generate(input) {
            calls++;
            return {
              ok: true,
              value: {
                content: "The orbital observatory is a new host.",
                ...(JSON.parse(input.prompt).memoryReflection
                  ? { memoryUpdates: [] }
                  : {}),
              },
            };
          },
        },
        selection.model,
        opened.value,
      ),
  });
  const body = {
    version: "ifsoul-bridge/0.1",
    hostId: "orbital-observatory",
    character: {
      id: "lumen",
      name: "Lumen",
      temperament: "precise and patient",
    },
    requestId: "fourth-host",
    operation: "chat",
    context: "Hello from an arbitrary service.",
    choices: [],
    fallbackChoiceId: "",
    history: [],
  };
  const request = (
    query = "?provider=ollama&model=test-model",
    origin = "http://127.0.0.1:8788",
  ) =>
    new Request("http://127.0.0.1:8788/api/bridge" + query, {
      method: "POST",
      headers: {
        host: "127.0.0.1:8788",
        origin,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await api(request(undefined, "https://foreign.example"))).status,
      403,
    );
    assert.equal((await api(request(""))).status, 400);
    assert.equal(
      (await api(request("?provider=ollama&model=missing"))).status,
      400,
    );
    assert.equal(calls, 0);
    const response = await api(request());
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).speech,
      "The orbital observatory is a new host.",
    );
    assert.equal(calls, 1);
    body.version = "ifsoul-bridge/0.3.0";
    body.requestId = "fourth-host-current";
    const current = await api(request());
    assert.equal(current.status, 200);
    assert.equal((await current.json()).source, "llm");
    assert.equal(calls, 2);
    for (const version of ["ifsoul-bridge/9.9", "ifsoul-app-memory/0.3.0"]) {
      body.version = version;
      const unsupported = await api(request());
      assert.equal(unsupported.status, 400);
      assert.equal(
        (await unsupported.json()).error.code,
        "unsupported-version",
      );
      assert.equal(calls, 2);
    }
  } finally {
    opened.value.close();
  }
});

test("bridge rechecks serialization after delayed body parsing and observations require no provider", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  let release!: () => void,
    active = 0,
    observations = 0;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const api = createAPI({
    mode: "local",
    password: "",
    encryptionKey: "synthetic",
    access: { kind: "local", origin: "http://127.0.0.1:8788" },
    store: { get: () => undefined, set: () => {}, delete: () => {} },
    providers: async () => [
      {
        id: "ollama",
        label: "Test",
        available: true,
        models: [{ id: "test", label: "Test" }],
      },
    ],
    service: createCharacterWorkspace({
      memory: opened.value,
      controllerFor: () => createScenarioController(),
      chatEnvironment: "app",
    }),
    bridge: async () => {
      active++;
      await blocked;
      return { source: "llm", choiceId: "", speech: "Hello" };
    },
    observeBridge: () => {
      observations++;
    },
  });
  const make = (
    path = "/api/bridge?provider=ollama&model=test",
    body: BodyInit = JSON.stringify({ version: "ifsoul-bridge/0.3.0" }),
  ) =>
    new Request("http://127.0.0.1:8788" + path, {
      method: "POST",
      headers: {
        host: "127.0.0.1:8788",
        origin: "http://127.0.0.1:8788",
        "content-type": "application/json",
      },
      body,
      duplex: "half",
    } as RequestInit);
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const slow = new ReadableStream<Uint8Array>({
    start(c) {
      feed = c;
    },
  });
  try {
    const delayed = api(make(undefined, slow));
    const running = api(make());
    while (!active) await new Promise((r) => setTimeout(r, 1));
    feed.enqueue(
      new TextEncoder().encode(
        JSON.stringify({ version: "ifsoul-bridge/0.3.0" }),
      ),
    );
    feed.close();
    assert.equal((await delayed).status, 409);
    assert.equal(active, 1);
    const observed = await api(make("/api/bridge/observations"));
    assert.equal(observed.status, 200);
    assert.equal(observations, 1);
    assert.equal(active, 1);
    release();
    assert.equal((await running).status, 200);
  } finally {
    release();
    opened.value.close();
  }
});
