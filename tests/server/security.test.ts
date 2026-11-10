import { createCharacterWorkspace } from "../../apps/runtime-host/src/characters.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createAPI, type PrivateStore } from "../../apps/server/src/api.js";
import {
  secured,
  authenticated,
  decryptCredential,
  encryptCredential,
  sessionCookie,
} from "../../apps/server/src/security.js";
import {
  createScenarioController,
  SCENARIO_MODEL,
} from "../../apps/runtime-host/src/service.js";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
const origin = "https://laboratory.example";
const password = "synthetic-owner-password-for-tests";
function setup() {
  const m = openSQLiteMemory(":memory:");
  assert.ok(m.ok);
  const memory = m.value;
  const map = new Map<string, string>();
  const store: PrivateStore = {
    get: (k) => map.get(k),
    set: (k, v) => {
      map.set(k, v);
    },
    delete: (k) => {
      map.delete(k);
    },
  };
  let calls = 0;
  const service = createCharacterWorkspace({
    memory,
    controllerFor: () => async (input, signal) => {
      calls++;
      return createScenarioController()(input, signal);
    },
  });
  const api = createAPI({
    mode: "cloud",
    password,
    encryptionKey: "test-encryption-secret",
    store,
    service,
    providers: async () => [
      {
        id: "scenario",
        label: "Scenario",
        available: true,
        models: [{ id: SCENARIO_MODEL, label: "Scenario" }],
      },
    ],
  });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
    from: string | undefined = origin,
  ) =>
    new Request(origin + path, {
      method,
      headers: {
        ...(from ? { origin: from } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const login = async () => {
    const r = await api(request("/api/login", "POST", { password }));
    assert.equal(r.status, 200);
    return r.headers.get("set-cookie")!.split(";")[0];
  };
  return { api, request, login, memory, map, calls: () => calls };
}
test("closed API rejects unauthenticated inference, forged cookies and cross-origin credential writes", async () => {
  const h = setup();
  try {
    assert.equal((await h.api(h.request("/api/run", "POST", {}))).status, 401);
    const cookie = await h.login();
    assert.equal(
      (
        await h.api(
          h.request(
            "/api/credentials/openai",
            "POST",
            { key: "synthetic-test-key-not-a-real-secret" },
            cookie,
            "https://evil.example",
          ),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await h.api(
          h.request("/api/snapshot", "GET", undefined, cookie + "tampered"),
        )
      ).status,
      401,
    );
    const missingOrigin = new Request(origin + "/api/run", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal((await h.api(missingOrigin)).status, 403);
    assert.equal(h.calls(), 0);
  } finally {
    h.memory.close();
  }
});
test("owner credentials are encrypted separately, never returned by snapshot/status, removable", async () => {
  const h = setup();
  try {
    const cookie = await h.login();
    const key = "synthetic-openai-key-for-storage-test";
    const result = await h.api(
      h.request("/api/credentials/openai", "POST", { key }, cookie),
    );
    assert.equal(result.status, 200);
    assert.ok(h.map.get("openai-key"));
    assert.ok(!h.map.get("openai-key")!.includes(key));
    assert.equal(
      await decryptCredential(
        h.map.get("openai-key")!,
        "test-encryption-secret",
      ),
      key,
    );
    for (const path of ["/api/status", "/api/snapshot"])
      assert.ok(
        !(
          await (await h.api(h.request(path, "GET", undefined, cookie))).text()
        ).includes(key),
      );
    assert.equal(
      (
        await h.api(
          h.request("/api/credentials/openai", "DELETE", undefined, cookie),
        )
      ).status,
      200,
    );
    assert.equal(h.map.has("openai-key"), false);
  } finally {
    h.memory.close();
  }
});
test("signed sessions expire, encryption binds ciphertext to deployment secret", async () => {
  const cookie = (await sessionCookie(password, true, 1000)).split(";")[0];
  const r = new Request(origin, { headers: { cookie } });
  assert.equal(await authenticated(r, password, 1001), true);
  assert.equal(await authenticated(r, password, 43201001), false);
  assert.equal(await authenticated(r, "different", 1001), false);
  const cipher = await encryptCredential("synthetic", "first");
  await assert.rejects(decryptCredential(cipher, "second"));
});
test("login guessing is bounded and response protects browser storage/cache", async () => {
  const h = setup();
  try {
    for (let i = 0; i < 8; i++)
      assert.equal(
        (await h.api(h.request("/api/login", "POST", { password: "wrong" })))
          .status,
        401,
      );
    const r = await h.api(h.request("/api/login", "POST", { password }));
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.ok(
      r.headers
        .get("content-security-policy")
        ?.includes("frame-ancestors 'none'"),
    );
  } finally {
    h.memory.close();
  }
});
test("authenticated full cycle uses actual runtime memory and rejects arbitrary provider/model", async () => {
  const h = setup();
  try {
    const cookie = await h.login();
    assert.equal(
      (
        await h.api(
          h.request(
            "/api/run",
            "POST",
            {
              operation: "plan",
              requestId: "network-probe",
              provider: "http://evil.example",
              model: "x",
            },
            cookie,
          ),
        )
      ).status,
      400,
    );
    for (const operation of ["plan", "chat"]) {
      const r = await h.api(
        h.request(
          "/api/run",
          "POST",
          {
            operation,
            requestId: `api-${operation}`,
            provider: "scenario",
            model: SCENARIO_MODEL,
            ...(operation === "chat" ? { message: "What happened?" } : {}),
          },
          cookie,
        ),
      );
      assert.equal(r.status, 200);
      const body = (await r.json()) as { ok: boolean };
      assert.equal(body.ok, true);
    }
    assert.equal(h.calls(), 2);
    const snap = (await (
      await h.api(h.request("/api/snapshot", "GET", undefined, cookie))
    ).json()) as { ok: boolean; value: { memories: unknown[] } };
    assert.equal(snap.ok, true);
    assert.ok(snap.value.memories.length > 0);
  } finally {
    h.memory.close();
  }
});
test("oversized JSON cannot save a key or call a model", async () => {
  const h = setup();
  try {
    const cookie = await h.login();
    const r = await h.api(
      h.request(
        "/api/credentials/openai",
        "POST",
        { key: "x".repeat(20000) },
        cookie,
      ),
    );
    assert.equal(r.status, 500);
    assert.equal(h.map.has("openai-key"), false);
    assert.equal(h.calls(), 0);
  } finally {
    h.memory.close();
  }
});

test("character catalog requires owner auth and origin; profiles cannot inject history", async () => {
  const h = setup();
  try {
    assert.equal((await h.api(h.request("/api/characters"))).status, 401);
    const cookie = await h.login();
    const draft = {
      requestId: "api-created",
      name: "Nova",
      description: "An original fictional companion.",
      speechStyle: "Warm.",
      biography: "An invented past.",
    };
    assert.equal(
      (
        await h.api(
          h.request(
            "/api/characters",
            "POST",
            draft,
            cookie,
            "https://evil.test",
          ),
        )
      ).status,
      403,
    );
    const created = await h.api(
      h.request("/api/characters", "POST", draft, cookie),
    );
    assert.equal(created.status, 200);
    const body = (await created.json()) as {
      ok: boolean;
      value: { character: { characterId: string }; memories: unknown[] };
    };
    assert.equal(body.ok, true);
    assert.equal(body.value.memories.length, 0);
    const list = (await (
      await h.api(h.request("/api/characters", "GET", undefined, cookie))
    ).json()) as { value: unknown[] };
    assert.equal(list.value.length, 2);
    const snap = (await (
      await h.api(
        h.request(
          "/api/snapshot?characterId=" + body.value.character.characterId,
          "GET",
          undefined,
          cookie,
        ),
      )
    ).json()) as { value: { character: { characterId: string } } };
    assert.equal(
      snap.value.character.characterId,
      body.value.character.characterId,
    );
    assert.equal(
      (
        await h.api(
          h.request(
            "/api/characters",
            "POST",
            { ...draft, requestId: "forged", characterId: "character-lumen" },
            cookie,
          ),
        )
      ).status,
      400,
    );
  } finally {
    h.memory.close();
  }
});

test("profile endpoints require owner session, same origin and provider allowlist", async () => {
  const h = setup();
  try {
    for (const [path, method] of [
      ["/api/characters/authoring", "GET"],
      ["/api/characters/export?characterId=character-lumen", "GET"],
      ["/api/characters/import", "POST"],
      ["/api/characters/generate", "POST"],
    ])
      assert.equal(
        (
          await h.api(
            h.request(path!, method, method === "POST" ? {} : undefined),
          )
        ).status,
        401,
      );
    const cookie = await h.login();
    const metadata = (await (
      await h.api(
        h.request("/api/characters/authoring", "GET", undefined, cookie),
      )
    ).json()) as { library: unknown[]; prompt: string };
    assert.equal(metadata.library.length, 2);
    assert.match(metadata.prompt, /character-template/);
    const body = { requestId: "import-http", template: metadata.library[0] };
    assert.equal(
      (
        await h.api(
          h.request(
            "/api/characters/import",
            "POST",
            body,
            cookie,
            "https://evil.example",
          ),
        )
      ).status,
      403,
    );
    const imported = await h.api(
      h.request("/api/characters/import", "POST", body, cookie),
    );
    assert.equal(imported.status, 200);
    const value = (await imported.json()) as {
      value: { character: { characterId: string }; memories: unknown[] };
    };
    assert.equal(value.value.memories.length, 0);
    const exported = (await (
      await h.api(
        h.request(
          `/api/characters/export?characterId=${value.value.character.characterId}`,
          "GET",
          undefined,
          cookie,
        ),
      )
    ).json()) as { value: unknown };
    assert.deepEqual(exported.value, metadata.library[0]);
    const generated = await h.api(
      h.request(
        "/api/characters/generate",
        "POST",
        {
          requestId: "gen-http",
          brief: "Original clock",
          provider: "openai",
          model: "unknown",
        },
        cookie,
      ),
    );
    assert.equal(generated.status, 400);
    assert.equal(h.calls(), 0);
    const paired = (await (
      await h.api(
        h.request(
          `/api/snapshot?characterId=${value.value.character.characterId}&memoryCharacterId=character-lumen`,
          "GET",
          undefined,
          cookie,
        ),
      )
    ).json()) as {
      value: {
        character: { characterId: string };
        persona: { characterId: string };
      };
    };
    assert.equal(paired.value.character.characterId, "character-lumen");
    assert.equal(
      paired.value.persona.characterId,
      value.value.character.characterId,
    );
  } finally {
    h.memory.close();
  }
});

test("App CSP permits only the fixed consent-protected loopback companion", () => {
  const response = secured(new Response("ok"));
  const csp = response.headers.get("content-security-policy")!;
  assert(csp.includes("connect-src 'self' http://127.0.0.1:8811;"));
  assert(
    !csp.includes("http://127.0.0.1:*") && !csp.includes("http://localhost"),
  );
});
