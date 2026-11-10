import test from "node:test";
import assert from "node:assert/strict";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import { createAPI } from "../../apps/server/src/api.js";
import {
  createCharacterWorkspace,
  createScenarioController,
} from "../../apps/server/src/index.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
test("selfhost reuses owner password/cookie auth, separates placement and rejects foreign origin", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert(opened.ok);
  if (!opened.ok) return;
  const data = new Map<string, string>();
  const origin = "https://owned-service.example",
    api = createAPI({
      mode: "local",
      placement: "selfhost",
      publicOrigin: origin,
      password: "synthetic-owner-password",
      encryptionKey: "synthetic-local-key",
      store: {
        get: (k) => data.get(k),
        set: (k, v) => {
          data.set(k, v);
        },
        delete: (k) => {
          data.delete(k);
        },
      },
      service: createCharacterWorkspace({
        memory: opened.value,
        chatEnvironment: "app",
        controllerFor: () => createScenarioController(),
      }),
      providers: async () => [],
    });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    api(
      new Request(origin + "/api/" + path, {
        method,
        headers: { origin, "content-type": "application/json", ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  try {
    const config = await (await request("config")).json();
    assert.equal(config.auth, "password");
    assert.equal(config.placement, "selfhost");
    assert.equal(config.publicOrigin, origin);
    assert.equal((await request("characters")).status, 401);
    assert.equal(
      (await request("login", "POST", { password: "wrong" })).status,
      401,
    );
    assert.equal(
      (
        await request(
          "login",
          "POST",
          { password: "synthetic-owner-password" },
          { origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    const login = await request("login", "POST", {
      password: "synthetic-owner-password",
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    const session = cookie.split(";")[0]!;
    assert.equal(
      (await request("characters", "GET", undefined, { cookie: session }))
        .status,
      200,
    );
    assert.equal(
      (
        await request("characters", "GET", undefined, {
          cookie: session,
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (await request("logout", "POST", {}, { cookie: session })).status,
      200,
    );
  } finally {
    opened.value.close();
  }
});
test("remote Node composition rejects insecure origins/listeners before touching a store", () => {
  const directory = mkdtempSync(join(tmpdir(), "ifsoul-selfhost-negative-"));
  try {
    for (const env of [
      { IFSOUL_PUBLIC_ORIGIN: "http://remote.example" },
      { IFSOUL_LISTEN_HOST: "0.0.0.0" },
      {
        IFSOUL_PUBLIC_ORIGIN: "http://127.0.0.1:8830",
        IFSOUL_LISTEN_HOST: "0.0.0.0",
      },
    ]) {
      const data = join(directory, Math.random().toString(16).slice(2));
      const child = spawnSync(
        process.execPath,
        [resolve("node_modules/tsx/dist/cli.mjs"), "apps/server/src/local.ts"],
        {
          cwd: resolve("."),
          env: { ...process.env, PORT: "8830", IFSOUL_DATA_DIR: data, ...env },
          encoding: "utf8",
          timeout: 15000,
        },
      );
      assert.notEqual(child.status, 0);
      assert.equal(existsSync(data), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
