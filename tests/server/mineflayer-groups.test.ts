import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { ParticipantState, ParticipantStore } from "@ifsoul/core/runtime";
import type { GameBinding } from "../../apps/server/src/game-connections.js";
import { createMineflayerGroups } from "../../apps/server/src/mineflayer-groups.js";

function fixture(providerUnavailable = false) {
  let clock = 100;
  const states = new Map<string, ParticipantState>();
  const store: ParticipantStore = {
    transact(principalId, work) {
      const state = structuredClone(
        states.get(principalId) ?? {
          format: "ifsoul-participants/0.4.0" as const,
          sessions: [],
          events: [],
          participants: [],
          transitions: [],
          turns: [],
        },
      );
      const result = work(state);
      states.set(principalId, state);
      return result;
    },
  };
  const bindings = ["fir", "ash", "pine"].map((id): GameBinding => ({
    connectionId: id,
    principalId: "owner",
    hostId: id,
    characterId: id,
    memoryId: "memory-" + id,
    character: { id, name: id, temperament: "curious" },
    revision: 1,
    expiresAt: 3600000,
    revoked: false,
    provider: "ollama",
    model: "owned-shared-model",
    actions: ["movement"],
  }));
  const prompts: unknown[] = [];
  const server = { host: "127.0.0.1", port: 25579 };
  const player = { name: "FieldTester", uuid: randomUUID() };
  const members = bindings.map((binding) => ({
    name: binding.character.name + "Bot",
    connectionId: binding.connectionId,
  }));
  const groups = createMineflayerGroups({
    principalId: "owner",
    store,
    bindings: () => bindings,
    now: () => clock,
    clientFor: async () => ({
      id: "ollama",
      generate: async (request) => {
        const input = JSON.parse(request.prompt);
        prompts.push(input);
        if (input.actorIds)
          return {
            ok: true,
            value: {
              assignments: input.actorIds.map((actorId: string, i: number) => ({
                actorId,
                intentId: input.intentIds[i],
              })),
            },
          };
        if (providerUnavailable)
          return {
            ok: false,
            error: { code: "timeout", message: "Synthetic provider deadline" },
          };
        return {
          ok: true,
          value: { speech: input.profile.name + " acknowledgment" },
        };
      },
    }),
  });
  const setup = {
    action: "configure",
    server,
    player,
    members,
    autonomous: true,
    consent: true,
  };
  return {
    groups,
    player,
    states,
    prompts,
    setup,
    bindings,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
type Grant = { revision: number; token: string; botNames: string[] };
type Proposal = {
  claimId: string;
  assignments: { id: string; name: string; direction: string }[];
};

test("targeted revocation preserves surviving group authority, original cadence and budget", async () => {
  const { groups, setup, states, prompts, advance } = fixture();
  const configured = groups.owner.change(setup);
  assert(configured.group && "code" in configured);
  const grant = (await groups.command(
    {
      operation: "redeem",
      code: configured.code,
      server: setup.server,
    },
    null,
  )) as Grant;
  const operation = (body: Record<string, unknown>) =>
    groups.command(
      { ...body, revision: grant.revision },
      "Bearer " + grant.token,
    );
  await assert.rejects(
    groups.command(
      { operation: "pulse", revision: grant.revision },
      "Bearer invalid",
    ),
  );
  assert.equal(
    (await operation({ operation: "pulse", readyNames: grant.botNames }))
      .canMove,
    true,
  );
  await setImmediate();
  const proposal = (await operation({ operation: "assignment" })) as Proposal;
  assert.deepEqual(
    proposal.assignments.map((a) => a.direction),
    ["north", "south", "east"],
  );
  assert.equal(new Set(proposal.assignments.map((a) => a.name)).size, 3);
  assert.deepEqual(
    (await operation({ operation: "assignment" })).assignments,
    [],
  );
  for (const assignment of proposal.assignments)
    await operation({
      operation: "outcome",
      claimId: proposal.claimId,
      assignmentId: assignment.id,
      status: "arrived",
    });
  assert.equal(prompts.length, 1);
  await operation({ operation: "pulse", readyNames: grant.botNames });
  await setImmediate();
  assert.deepEqual(
    (await operation({ operation: "assignment" })).assignments,
    [],
  );
  assert.equal(prompts.length, 1);
  assert.equal(
    states
      .get("owner")
      ?.events.filter((event) => event.eventId.startsWith("host-")).length,
    3,
  );
  assert.equal(states.size, 1);

  const status = groups.owner.change({
    action: "revoke-member",
    revision: grant.revision,
    connectionId: setup.members[1].connectionId,
  });
  assert.equal(status.group?.state, "connected");
  const survivors = ["firBot", "pineBot"];
  assert.deepEqual(
    status.group?.members.map((actor) => actor.name),
    survivors,
  );
  assert.deepEqual(
    groups.owner.change({
      action: "revoke-member",
      revision: grant.revision,
      connectionId: setup.members[1].connectionId,
    }),
    status,
  );
  await assert.rejects(operation({ operation: "assignment" }), /stale/);
  const bootstrap = await operation({
    operation: "pulse",
    readyNames: grant.botNames,
  });
  assert.deepEqual(bootstrap.botNames, survivors);
  const revised = (body: Record<string, unknown>) =>
    groups.command(
      {
        ...body,
        revision: status.group?.revision,
      },
      "Bearer " + grant.token,
    );
  await assert.rejects(
    revised({ operation: "pulse", readyNames: grant.botNames }),
  );
  for (let i = 0; i < 15; i++) {
    await revised({ operation: "pulse", readyNames: survivors });
    await setImmediate();
    assert.equal(prompts.length, 1);
    advance(2000);
  }
  await revised({ operation: "pulse", readyNames: survivors });
  await setImmediate();
  const reassigned = (await revised({ operation: "assignment" })) as Proposal;
  assert.deepEqual(
    reassigned.assignments.map((assignment) => assignment.name),
    survivors,
  );
  assert.equal(prompts.length, 2);
  assert.equal(states.get("owner")?.planning?.schedules.at(-1)?.maxRuns, 2);
  const singleton = groups.owner.change({
    action: "revoke-member",
    revision: status.group?.revision,
    connectionId: setup.members[0].connectionId,
  });
  assert.equal(singleton.group?.state, "connected");
  assert.deepEqual(
    singleton.group?.members.map((actor) => actor.name),
    ["pineBot"],
  );
  const terminal = (body: Record<string, unknown>) =>
    groups.command(
      {
        ...body,
        revision: singleton.group?.revision,
      },
      "Bearer " + grant.token,
    );
  await assert.rejects(
    revised({
      operation: "outcome",
      claimId: reassigned.claimId,
      assignmentId: reassigned.assignments[0].id,
      status: "arrived",
    }),
    /stale/,
  );
  await terminal({ operation: "pulse", readyNames: ["pineBot"] });
  assert.equal(states.get("owner")?.planning?.schedules.at(-1)?.maxRuns, 1);
  const empty = groups.owner.change({
    action: "revoke-member",
    revision: singleton.group?.revision,
    connectionId: setup.members[2].connectionId,
  });
  assert.equal(empty.group?.state, "stopped");
  await assert.rejects(
    terminal({ operation: "pulse", readyNames: ["pineBot"] }),
  );
});

test("group dialogue audiences preserve distinct NPC evidence and reject other owners", async () => {
  const { groups, setup, player, states, prompts, bindings } = fixture();
  bindings[0].principalId = "other";
  assert.throws(() => groups.owner.change(setup));
  bindings[0].principalId = "owner";
  const configured = groups.owner.change({ ...setup, autonomous: false });
  assert("code" in configured);
  const grant = (await groups.command(
    {
      operation: "redeem",
      code: configured.code,
      server: setup.server,
    },
    null,
  )) as Grant;
  await assert.rejects(
    groups.command(
      {
        operation: "redeem",
        code: configured.code,
        server: setup.server,
      },
      null,
    ),
  );
  const operation = (body: Record<string, unknown>) =>
    groups.command(
      { ...body, revision: grant.revision },
      "Bearer " + grant.token,
    );
  assert.equal(
    (await operation({ operation: "pulse", readyNames: grant.botNames }))
      .canMove,
    false,
  );
  await assert.rejects(
    operation({
      operation: "dialogue",
      addressedTo: "firBot",
      text: "unknown source",
      playerUuid: randomUUID(),
      eventId: randomUUID(),
    }),
  );
  const talk = (addressedTo: string, text: string) =>
    operation({
      operation: "dialogue",
      addressedTo,
      text,
      playerUuid: player.uuid,
      eventId: randomUUID(),
    });
  assert.equal((await talk("firBot", "Private amber spruce")).name, "firBot");
  assert.equal((await talk("group", "Shared silver iris")).name, "firBot");
  assert.equal(
    (await talk("ashBot", "Tell me what you remember")).name,
    "ashBot",
  );
  assert.match(JSON.stringify(prompts.at(-1)), /Shared silver iris/);
  assert.doesNotMatch(JSON.stringify(prompts.at(-1)), /Private amber spruce/);
  assert.equal(states.size, 1);
  await operation({ operation: "disconnect" });
  await assert.rejects(talk("firBot", "late reply"));
});

test("a group provider failure produces only a bounded unavailable result", async () => {
  const { groups, setup, player, states, prompts } = fixture(true);
  const configured = groups.owner.change({ ...setup, autonomous: false });
  assert("code" in configured);
  const grant = (await groups.command(
    {
      operation: "redeem",
      code: configured.code,
      server: setup.server,
    },
    null,
  )) as Grant;
  const call = (body: Record<string, unknown>) =>
    groups.command(
      { ...body, revision: grant.revision },
      "Bearer " + grant.token,
    );
  const playerTarget = { addressedTo: "firBot", playerUuid: player.uuid };
  assert.deepEqual(
    await call({
      operation: "dialogue",
      ...playerTarget,
      text: "hello",
      eventId: randomUUID(),
    }),
    { unavailable: true },
  );
  assert.deepEqual(
    await call({ operation: "dialogue-status", ...playerTarget }),
    { ok: true },
  );
  assert.equal(prompts.length, 1);
  assert.equal(states.get("owner")?.events.length, 1);
  assert.equal(states.get("owner")?.planning?.claims.length, 0);
  groups.owner.change({
    action: "revoke-member",
    revision: grant.revision,
    connectionId: setup.members[0].connectionId,
  });
  await assert.rejects(
    call({ operation: "dialogue-status", ...playerTarget }),
    /stale/,
  );
});
