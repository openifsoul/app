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
  const store = createSQLParticipantStore(
    {
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
    },
    true,
  );
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

test("owner inspection requires explicit authenticated player grant for the exact connection and memory", async () => {
  const f = fixture();
  try {
    const grant = f.grant();
    const device = f.broker.redeem(grant.code);
    const binding = f.broker.ready(device.token, player);
    const inspect = () =>
      f.broker.inspection("owner", binding.connectionId, binding.memoryId);
    assert.throws(inspect);
    const consent = (allowed: boolean) =>
      gameDeviceRequest(
        new Request("http://localhost/api/game/device/history-consent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${device.token}`,
          },
          body: JSON.stringify({ allowed }),
        }),
        f.broker,
        async () => {
          throw Error("Consent must bypass model generation");
        },
      );
    assert.equal((await consent(true)).status, 200);
    assert.equal(inspect().player?.uuid, player.uuid);
    assert.throws(() =>
      f.broker.inspection("other", binding.connectionId, binding.memoryId),
    );
    assert.throws(() =>
      f.broker.inspection("owner", binding.connectionId, "other-memory"),
    );
    assert.equal((await consent(false)).status, 200);
    assert.throws(inspect);
    await consent(true);
    f.broker.revoke("owner", binding.connectionId);
    assert.throws(inspect);
  } finally {
    f.db.close();
  }
});

test("private text index scopes exact owner and session with transactional writes", () => {
  const f = fixture();
  try {
    for (const principal of ["owner", "other"]) {
      f.store.transact(principal, (state) => {
        for (let n = 0; n < 200; n++)
          state.events.push({
            eventId: `event-${n}`,
            sessionId: n % 2 ? "session-one" : "session-two",
            revision: 1,
            channelId: "private",
            senderId: "player",
            recipientIds: ["npc"],
            observerIds: [],
            text: "Synthetic copper orchard",
          });
      });
    }
    const matches = f.store.searchHistory(
      "owner",
      "session-one",
      "copper orchard",
    );
    assert.equal(matches.size, 100);
    assert.ok(matches.has("event-1") && !matches.has("event-2"));
    assert.equal(
      f.store.searchHistory("missing", "session-one", "copper orchard").size,
      0,
    );
    assert.throws(() =>
      f.store.transact("owner", (state) => {
        state.events.splice(0);
        throw Error("fixture rollback");
      }),
    );
    assert.equal(
      f.store.searchHistory("owner", "session-one", "copper orchard").size,
      100,
    );
  } finally {
    f.db.close();
  }
});

test("server connector handshake is bound to the owner's exact compatibility target", async () => {
  const { broker, db, grant: createLegacy } = fixture();
  const target = {
    connector: "minecraft-citizens" as const,
    npcId: "22222222-2222-2222-2222-222222222222",
    playerId: player.uuid,
  };
  const resolved = {
    characterId: "profile",
    memoryId: "memory",
    provider: "scenario" as const,
    model: "synthetic",
    character: { id: "profile", name: "Lumen", temperament: "Calm" },
    minecraftTarget: target,
  };
  const easy = broker.create("easy-owner", {
    ...resolved,
    minecraftTarget: { ...target, connector: "minecraft-easy-npc" },
    actions: ["movement"],
  });
  const { token: easyToken } = broker.redeem(easy.code);
  const runtime = {
    connector: "minecraft-easy-npc",
    version: "1.21.1",
    loader: "NeoForge",
    upstream: "6.0.2",
    npcId: target.npcId,
  };
  assert.deepEqual(broker.ready(easyToken, player, runtime).activeActions, []);
  assert.deepEqual(
    broker.ready(easyToken, player, runtime, ["movement"]).activeActions,
    ["movement"],
  );
  const send = (
    action: string,
    body: unknown,
    token?: string,
    fromBrowser = false,
  ) =>
    gameDeviceRequest(
      new Request(`http://127.0.0.1/api/game/device/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(fromBrowser ? { origin: "http://127.0.0.1" } : {}),
        },
        body: JSON.stringify(body),
      }),
      broker,
      async () => ({ speech: "Private reply" }),
      true,
    );
  try {
    const legacy = createLegacy();
    assert.equal((await send("redeem", { code: legacy.code })).status, 403);
    assert.ok(broker.redeem(legacy.code).token);
    const grant = broker.create("owner", resolved);
    assert.equal(
      (await send("redeem", { code: grant.code }, undefined, true)).status,
      403,
    );
    const { token } = await (await send("redeem", { code: grant.code })).json();
    const hello = {
      connector: target.connector,
      loader: "Paper",
      version: "1.21.4",
      upstream: "2.0.37-b3763",
      npcId: target.npcId,
    };
    assert.equal((await send("ready", { player }, token)).status, 403);
    assert.equal(
      (
        await send(
          "ready",
          { player, minecraft: { ...hello, version: "1.21.5" } },
          token,
        )
      ).status,
      403,
    );
    assert.equal(
      (await send("ready", { player, minecraft: hello }, token)).status,
      200,
    );
    assert.equal(
      (await send("dialogue", { requestId: "hello", text: "Hi" }, token))
        .status,
      200,
    );
    assert.throws(() =>
      broker.create(
        "owner",
        { ...resolved, minecraftTarget: { ...target, npcId: player.uuid } },
        grant.connection.connectionId,
      ),
    );
    const renewal = broker.create(
      "owner",
      resolved,
      grant.connection.connectionId,
    );
    assert.equal(renewal.connection.hostId, grant.connection.hostId);
    assert.equal(renewal.connection.player, undefined);
    assert.equal(
      (await send("dialogue", { requestId: "old-grant", text: "Hi" }, token))
        .status,
      403,
    );
  } finally {
    db.close();
  }
});

test("action grants require explicit profile approval and current ready capabilities", async () => {
  const f = fixture();
  try {
    const make = (actions?: ("movement" | "defense" | "colony")[]) =>
      f.broker.create("owner", {
        characterId: "profile",
        memoryId: "memory",
        provider: "openai",
        model: "synthetic",
        character: { id: "profile", name: "Lumen", temperament: "Calm" },
        ...(actions ? { actions } : {}),
      });
    assert.throws(() => make(["colony"]));
    const oldToken = f.broker.redeem(f.grant().code).token;
    assert.equal(
      f.broker.ready(oldToken, player, undefined, ["movement"]).activeActions,
      undefined,
    );
    const grant = make(["movement", "defense"]);
    const { token } = f.broker.redeem(grant.code);
    let last: Record<string, unknown> | undefined;
    const request = (credential: string, body: unknown) =>
      gameDeviceRequest(
        new Request("http://127.0.0.1/api/game/device/dialogue", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + credential,
          },
          body: JSON.stringify(body),
        }),
        f.broker,
        async (_binding, input) => {
          last = input;
          return {
            choiceId: "follow",
            speech: "The host will check this action.",
            source: "llm",
          };
        },
      );
    const check = { operation: "action-check" };
    assert.equal((await request(oldToken, check)).status, 403);
    assert.deepEqual(f.broker.ready(token, player).activeActions, []);
    assert.throws(() => f.broker.ready(token, player, undefined, ["anything"]));
    assert.equal((await request(token, check)).status, 403);
    const started = f.broker.ready(token, player, undefined, ["movement"]);
    assert.deepEqual(started.activeActions, ["movement"]);
    assert.deepEqual(await (await request(token, check)).json(), {
      authorized: true,
      revision: started.revision,
    });
    const decide = {
      operation: "decide",
      requestId: "first",
      text: "Follow me",
      choices: [
        { id: "none", label: "No action" },
        { id: "follow", label: "Follow player" },
      ],
    };
    assert.equal((await request(token, decide)).status, 200);
    assert.deepEqual(last, decide);
    assert.equal(
      (
        await request(token, {
          ...decide,
          choices: [...decide.choices, { id: "defend", label: "Defend" }],
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(token, {
          operation: "action-outcome",
          id: "id",
          action: "follow",
          result: "arrived",
        })
      ).status,
      200,
    );
    const replacement = f.broker.ready(token, player, undefined, [
      "movement",
      "defense",
    ]);
    assert.throws(() => f.broker.current(started));
    assert.ok(replacement.revision > started.revision);
    f.broker.revoke("owner", grant.connection.connectionId);
    assert.equal((await request(token, check)).status, 403);
  } finally {
    f.db.close();
  }
});

test("structured device decisions never certify model speech as an action outcome", async () => {
  const f = fixture();
  const prompts: string[] = [];
  const executor = createGameExecutor({
    store: f.store,
    validate: async (binding) => f.broker.current(binding),
    clientFor: async () => ({
      id: "openai",
      generate: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          ok: true,
          value: {
            content: '{"choiceId":"east","speech":"I arrived already."}',
          },
        };
      },
    }),
  });
  try {
    const approved = f.broker.create("owner", {
      characterId: "profile",
      memoryId: "memory",
      provider: "openai",
      model: "synthetic",
      character: { id: "profile", name: "Lumen", temperament: "Calm" },
      actions: ["movement"],
    });
    const { token } = f.broker.redeem(approved.code);
    const send = async (body: unknown) => {
      const result = await gameDeviceRequest(
        new Request("http://127.0.0.1/api/game/device/dialogue", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + token,
          },
          body: JSON.stringify(body),
        }),
        f.broker,
        executor.execute,
      );
      assert.equal(result.status, 200);
      return result.json();
    };
    const binding = f.broker.ready(token, player, undefined, ["movement"]);
    const decision = {
      operation: "decide",
      requestId: "move-1",
      text: "Walk east",
      choices: [
        { id: "none", label: "No action" },
        { id: "east", label: "Walk east" },
      ],
    };
    const selected = await send(decision);
    assert.equal(selected.choiceId, "east");
    assert.doesNotMatch(selected.speech, /arrived/);
    assert.equal((await send(decision)).choiceId, "none");
    assert.equal(prompts.length, 1);
    assert.equal(
      executor.history(binding).some((entry) => entry.text.includes("arrived")),
      false,
    );
    const outcome = {
      operation: "action-outcome",
      id: "outcome-1",
      action: "east",
      result: "arrived",
    };
    await send(outcome);
    await send(outcome);
    assert.equal(
      executor
        .history(binding)
        .filter((entry) => entry.text.includes("ended east: arrived")).length,
      1,
    );
    await send({ ...decision, requestId: "move-2" });
    assert.match(prompts.at(-1)!, /Minecraft host ended east: arrived/);
  } finally {
    f.db.close();
  }
});
