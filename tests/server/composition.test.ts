import assert from "node:assert/strict";
import test from "node:test";
import { trustedLocalRequest } from "../../apps/server/src/app-auth.js";
import { createAPI } from "../../apps/server/src/api.js";
import {
  createCharacterWorkspace,
  createScenarioController,
} from "../../apps/server/src/index.js";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";

test("local App opens without account and rejects foreign origins for reads and writes", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  try {
    const settings = new Map<string, string>();
    const api = createAPI({
      mode: "local",
      password: "",
      encryptionKey: "synthetic-test-key",
      access: { kind: "local", origin: "http://127.0.0.1:8788" },
      store: {
        get: (k) => settings.get(k),
        set: (k, v) => {
          settings.set(k, v);
        },
        delete: (k) => {
          settings.delete(k);
        },
      },
      providers: async () => [],
      service: createCharacterWorkspace({
        memory: opened.value,
        controllerFor: () => createScenarioController(),
        chatEnvironment: "app",
      }),
    });
    const request = (path: string, origin?: string) =>
      new Request("http://127.0.0.1:8788/api/" + path, {
        headers: { host: "127.0.0.1:8788", ...(origin ? { origin } : {}) },
      });
    assert.equal((await api(request("status"))).status, 200);
    const config = await (await api(request("config"))).json();
    assert.deepEqual(config, {
      mode: "local",
      auth: "local",
      laboratory: true,
    });
    assert.equal(
      (await api(request("characters", "https://evil.example"))).status,
      403,
    );
    assert.equal(
      trustedLocalRequest(
        new Request("http://127.0.0.1:8788/api/characters", {
          method: "POST",
          headers: { host: "127.0.0.1:8788" },
        }),
        "http://127.0.0.1:8788",
      ),
      false,
    );
  } finally {
    opened.value.close();
  }
});

test("host-injected principal works without Clerk and cannot enable cloud laboratory", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  try {
    const api = createAPI({
      mode: "cloud",
      password: "",
      encryptionKey: "synthetic-test-key",
      access: { kind: "principal", id: "synthetic-user" },
      store: { get: () => undefined, set: () => {}, delete: () => {} },
      providers: async () => [],
      service: createCharacterWorkspace({
        memory: opened.value,
        controllerFor: () => createScenarioController(),
        chatEnvironment: "app",
      }),
    });
    assert.equal(
      (await api(new Request("https://synthetic.example/api/characters")))
        .status,
      200,
    );
    assert.equal(
      (
        await api(
          new Request("https://synthetic.example/api/lab/run", {
            method: "POST",
          }),
        )
      ).status,
      403,
    );
  } finally {
    opened.value.close();
  }
});
