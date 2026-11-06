import assert from "node:assert/strict";
import test from "node:test";
import { createAPI } from "../../apps/server/src/api.js";
import {
  createCharacterWorkspace,
  createScenarioController,
} from "../../apps/server/src/index.js";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import { IDS } from "../../apps/runtime-host/src/default-context.js";

test("memory APIs enforce owner authentication/origin, explicit new-session consent, preview and fork-only import", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const memory = opened.value;
  try {
    const service = createCharacterWorkspace({
      memory,
      controllerFor: () => createScenarioController(),
      chatEnvironment: "app",
    });
    const api = createAPI({
      mode: "local",
      access: { kind: "local", origin: "http://127.0.0.1:8793" },
      password: "",
      encryptionKey: "synthetic",
      store: { get: () => undefined, set: () => {}, delete: () => {} },
      service,
      providers: async () => [],
    });
    const post = (
      path: string,
      body: unknown,
      origin = "http://127.0.0.1:8793",
    ) =>
      api(
        new Request(`http://127.0.0.1:8793/api/memory/${path}`, {
          method: "POST",
          headers: {
            origin,
            host: "127.0.0.1:8793",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
    assert.equal(
      (
        await post(
          "new",
          { characterId: IDS.character, consent: true },
          "http://foreign.invalid",
        )
      ).status,
      403,
    );
    assert.equal(
      (await post("new", { characterId: IDS.character })).status,
      400,
    );
    const created = await (
      await post("new", { characterId: IDS.character, consent: true })
    ).json();
    assert.ok(created.ok);
    const result = await service.run({
      characterId: created.value.memoryId,
      operation: "chat",
      requestId: "safe-chat",
      message: "Synthetic archive dialogue",
      provider: "scenario",
      model: "scenario",
    });
    assert.ok(result.ok);
    const exported = await (
      await api(
        new Request(
          `http://127.0.0.1:8793/api/memory/export?memoryId=${created.value.memoryId}`,
          { headers: { host: "127.0.0.1:8793" } },
        ),
      )
    ).json();
    assert.ok(exported.ok);
    const preview = await (
      await post("preview", { archive: exported.value })
    ).json();
    assert.ok(preview.ok);
    assert.equal(
      (await post("import", { archive: exported.value })).status,
      400,
    );
    const imported = await (
      await post("import", {
        archive: exported.value,
        expectedDigest: preview.value.sha256,
      })
    ).json();
    assert.ok(imported.ok);
    assert.notEqual(imported.value.memoryId, created.value.memoryId);
    const noAuth = createAPI({
      mode: "local",
      password: "synthetic-owner-password",
      encryptionKey: "synthetic",
      store: { get: () => undefined, set: () => {}, delete: () => {} },
      service,
      providers: async () => [],
    });
    assert.equal(
      (
        await noAuth(
          new Request(
            `http://127.0.0.1:8793/api/memory/export?memoryId=${created.value.memoryId}`,
          ),
        )
      ).status,
      401,
    );
  } finally {
    memory.close();
  }
});
