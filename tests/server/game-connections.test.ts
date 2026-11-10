import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createGameConnectionBroker,
  gameDeviceRequest,
} from "../../apps/server/src/game-connections.js";
import { createGameExecutor } from "../../apps/server/src/game-executor.js";
import { createSQLParticipantStore } from "../../apps/runtime-host/src/participant-sessions.js";
const player = { name: "Tester", uuid: "11111111-1111-1111-1111-111111111111" };
function fixture() {
  const data = new Map<string, string>();
  let at = 1000;
  const broker = createGameConnectionBroker({
    store: {
      get: (k) => data.get(k),
      set: (k, v) => {
        data.set(k, v);
      },
      delete: (k) => {
        data.delete(k);
      },
    },
    transaction: (f) => f(),
    now: () => at,
  });
  const db = new DatabaseSync(":memory:");
  const store = createSQLParticipantStore({
    prepare: (q) => db.prepare(q),
    transaction: (f) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const x = f();
        db.exec("COMMIT");
        return x;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  });
  const grant = () =>
    broker.create("owner", {
      characterId: "profile",
      memoryId: "memory",
      provider: "openai",
      model: "synthetic",
      character: { id: "profile", name: "Lumen", temperament: "Calm" },
    });
  return { broker, db, store, grant, advance: () => (at += 301000) };
}
test("single-use expiring code, native-only bearer, owner revoke and no token in owner views", async () => {
  const f = fixture();
  try {
    const grant = f.grant();
    assert(!JSON.stringify(f.broker.list("owner")).includes(grant.code));
    assert.equal(f.broker.list("other").length, 0);
    const native = f.broker.redeem(grant.code);
    assert.throws(() => f.broker.redeem(grant.code));
    assert(!JSON.stringify(f.broker.list("owner")).includes(native.token));
    assert.throws(() =>
      f.broker.revoke("other", grant.connection.connectionId),
    );
    const binding = f.broker.ready(native.token, player);
    assert.equal(binding.player!.uuid, player.uuid);
    assert.throws(() =>
      f.broker.ready(native.token, {
        ...player,
        uuid: "22222222-2222-2222-2222-222222222222",
      }),
    );
    const request = (path: string, headers: Record<string, string> = {}) =>
      new Request("http://127.0.0.1:8788" + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + native.token,
          ...headers,
        },
        body: JSON.stringify({ requestId: "hi", text: "hello" }),
      });
    assert.equal(
      (
        await gameDeviceRequest(
          request("/api/game/device/dialogue", {
            origin: "http://evil.invalid",
          }),
          f.broker,
          async () => ({}),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await gameDeviceRequest(
          request("/foo/dialogue"),
          f.broker,
          async () => ({}),
        )
      ).status,
      404,
    );
    f.broker.revoke("owner", binding.connectionId);
    assert.throws(() => f.broker.authenticate(native.token));
    const exp = f.grant();
    f.advance();
    assert.throws(() => f.broker.redeem(exp.code));
  } finally {
    f.db.close();
  }
});
test("actual participant runtime preserves private memory, replay and revocation fences late model storage", async () => {
  const f = fixture();
  let resolve: (v: any) => void = () => {},
    pending = false,
    calls = 0;
  const callCount = () => calls;
  const executor = createGameExecutor({
    store: f.store,
    validate: async (b) => f.broker.current(b),
    clientFor: async () => ({
      id: "openai",
      generate: async () => {
        calls++;
        if (pending)
          return new Promise((r) => {
            resolve = r;
          });
        return {
          ok: true,
          value: { content: '{"speech":"A private reply."}' },
        };
      },
    }),
  });
  try {
    const n = f.broker.redeem(f.grant().code),
      b = f.broker.ready(n.token, player);
    const first = await executor.execute(b, {
      requestId: "first",
      text: "private red flower",
    });
    assert.equal(first.speech, "A private reply.");
    assert.deepEqual(
      await executor.execute(b, {
        requestId: "first",
        text: "private red flower",
      }),
      first,
    );
    assert.equal(callCount(), 1);
    assert.equal(executor.history(b).length, 2);
    pending = true;
    const late = executor.execute(b, {
      requestId: "late",
      text: "second private event",
    });
    for (let i = 0; i < 20 && callCount() !== 2; i++)
      await new Promise((r) => setImmediate(r));
    assert.equal(callCount(), 2);
    f.broker.revoke("owner", b.connectionId);
    resolve({
      ok: true,
      value: { content: '{"speech":"Must not be stored."}' },
    });
    await assert.rejects(late);
    const state = f.store.transact("owner", (s) => s.events);
    assert(!JSON.stringify(state).includes("Must not be stored"));
    assert.equal(state.filter((e) => e.senderId.startsWith("npc-")).length, 1);
  } finally {
    f.db.close();
  }
});

test("provider renewal preserves the approved host memory, rotates credentials and cannot reuse foreign ownership", async () => {
  const f = fixture(),
    prompts: string[] = [];
  const executor = createGameExecutor({
    store: f.store,
    validate: async (b) => f.broker.current(b),
    clientFor: async () => ({
      id: "openai",
      generate: async (input) => {
        prompts.push(input.prompt);
        return {
          ok: true,
          value: { content: '{"speech":"A private answer."}' },
        };
      },
    }),
  });
  try {
    const n = f.broker.redeem(f.grant().code),
      b = f.broker.ready(n.token, player);
    await executor.execute(b, {
      requestId: "old",
      text: "Remember my synthetic silver acorn",
    });
    const renewed = f.broker.create(
      "owner",
      {
        characterId: b.characterId,
        memoryId: b.memoryId,
        provider: "ollama",
        model: "another-model",
        character: b.character,
      },
      b.connectionId,
    );
    assert.equal(renewed.connection.hostId, b.hostId);
    assert.throws(() => f.broker.authenticate(n.token));
    const next = f.broker.redeem(renewed.code),
      active = f.broker.ready(next.token, player);
    await executor.execute(active, {
      requestId: "new",
      text: "What do you remember?",
    });
    assert(prompts.at(-1)!.includes("synthetic silver acorn"));
    assert.equal(executor.history(active).length, 4);
    assert.throws(() =>
      f.broker.create(
        "foreign",
        {
          characterId: b.characterId,
          memoryId: b.memoryId,
          provider: "ollama",
          model: "another-model",
          character: b.character,
        },
        b.connectionId,
      ),
    );
    const other = f.broker.redeem(f.grant().code),
      otherBinding = f.broker.ready(other.token, player);
    await executor.execute(otherBinding, {
      requestId: "isolated",
      text: "A different approved world",
    });
    assert(!prompts.at(-1)!.includes("synthetic silver acorn"));
  } finally {
    f.db.close();
  }
});
test("scenario game dialogue is deterministic and does not call a billable model", async () => {
  const f = fixture();
  try {
    const grant = f.broker.create("owner", {
        characterId: "profile",
        memoryId: "memory",
        provider: "scenario",
        model: "synthetic-v1",
        character: { id: "profile", name: "Lumen", temperament: "Calm" },
      }),
      n = f.broker.redeem(grant.code),
      b = f.broker.ready(n.token, player);
    const executor = createGameExecutor({
      store: f.store,
      validate: async (b) => f.broker.current(b),
      clientFor: async () => {
        throw Error("Must not call provider");
      },
    });
    const result = await executor.execute(b, {
      requestId: "scenario",
      text: "Hello",
    });
    assert.equal(result.source, "scenario");
    assert(result.speech);
    assert.equal(executor.history(b).length, 2);
  } finally {
    f.db.close();
  }
});

test("inactive grant metadata is bounded per owner without evicting active tokens or durable dialogue", async () => {
  const f = fixture();
  try {
    const active = f.broker.redeem(f.grant().code),
      binding = f.broker.ready(active.token, player);
    for (let i = 0; i < 100; i++) {
      const g = f.grant();
      f.broker.revoke("owner", g.connection.connectionId);
    }
    assert.equal(f.broker.list("owner").length, 64);
    assert.equal(f.broker.authenticate(active.token).hostId, binding.hostId);
    const other = f.broker.create("another-owner", {
      characterId: "profile",
      memoryId: "memory",
      provider: "scenario",
      model: "synthetic-v1",
      character: binding.character,
    });
    assert.equal(other.connection.principalId, "another-owner");
  } finally {
    f.db.close();
  }
});

test("renewing an inactive connection cannot exceed the active grant ceiling", () => {
  const f = fixture();
  try {
    const old = f.grant();
    f.broker.revoke("owner", old.connection.connectionId);
    for (let i = 0; i < 16; i++) f.grant();
    assert.throws(() =>
      f.broker.create(
        "owner",
        {
          characterId: "profile",
          memoryId: "memory",
          provider: "openai",
          model: "synthetic",
          character: old.connection.character,
        },
        old.connection.connectionId,
      ),
    );
    assert.equal(f.broker.list("owner").filter((r) => !r.revoked).length, 16);
  } finally {
    f.db.close();
  }
});

test("one-use owner proof authorizes only the authenticated tenant's stored binding, including read-only expired metadata", () => {
  const f = fixture();
  try {
    const owner = f.grant(),
      native = f.broker.redeem(owner.code),
      ownProof = f.broker.controlProof("owner"),
      foreign = f.broker.controlProof("foreign");
    assert.throws(() =>
      f.broker.confirmOwner(foreign.code, owner.connection.connectionId),
    );
    assert.equal(
      f.broker.confirmOwner(ownProof.code, owner.connection.connectionId)
        .principalId,
      "owner",
    );
    assert.throws(() =>
      f.broker.confirmOwner(ownProof.code, owner.connection.connectionId),
    );
    const expired = f.broker.controlProof("owner");
    f.advance();
    assert.throws(() =>
      f.broker.confirmOwner(expired.code, owner.connection.connectionId),
    );
    assert(f.broker.authenticate(native.token));
  } finally {
    f.db.close();
  }
});

test("present empty connection and proof documents fail without replacement", () => {
  for (const key of ["game-connections-v1", "game-owner-proofs-v1"]) {
    const data = new Map([[key, ""]]);
    const broker = createGameConnectionBroker({
      store: {
        get: (key) => data.get(key),
        set: (key, value) => {
          data.set(key, value);
        },
        delete: (key) => {
          data.delete(key);
        },
      },
      transaction: (work) => work(),
    });
    const before = [...data];
    assert.throws(() =>
      key === "game-connections-v1"
        ? broker.list("owner")
        : broker.controlProof("owner"),
    );
    assert.deepEqual([...data], before);
  }
});
