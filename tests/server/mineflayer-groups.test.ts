import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { ParticipantState, ParticipantStore } from "@ifsoul/core/runtime";
import type { GameBinding } from "../../apps/server/src/game-connections.js";
import {
  adventureFactLine,
  clippedAdventureSpeech,
} from "../../apps/server/src/adventure-dialogue.js";
import { createMineflayerGroups } from "../../apps/server/src/mineflayer-groups.js";

function fixture(
  providerUnavailable = false,
  unavailableCharacter?: string,
  malformedCharacter?: string,
  malformedSpeech = "",
) {
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
        if (input.facts)
          return {
            ok: true,
            value: { tone: "playful", speech: "Я собрал четыре бревна." },
          };
        if (input.choices) {
          const schema = request.schema as {
            properties: Record<string, unknown>;
            required: string[];
          };
          assert.deepEqual(schema.required, Object.keys(schema.properties));
          return {
            ok: true,
            value: {
              kind:
                input.playerMessage === "Поговорите друг с другом"
                  ? "exchange"
                  : input.playerMessage === "Как у вас дела со сбором?"
                    ? "status"
                    : "reply",
            },
          };
        }
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
        if (
          malformedCharacter &&
          input.profile?.name === malformedCharacter &&
          !request.system.includes("at most 100 characters")
        )
          return { ok: true, value: { speech: malformedSpeech } };
        if (
          providerUnavailable ||
          (input.profile?.name === unavailableCharacter &&
            unavailableCharacter !== undefined)
        )
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

test("the addressed adventure fans out a player greeting, persists a finite NPC exchange and fences private evidence", async () => {
  const { groups, setup, player, prompts } = fixture();
  const configured = groups.owner.change({ ...setup, publicChat: true });
  assert("code" in configured && typeof configured.code === "string");
  const grant = await groups.command(
    { operation: "redeem", code: configured.code, server: setup.server },
    null,
  );
  const command = (body: Record<string, unknown>) =>
    groups.command(
      { ...body, revision: grant.revision },
      "Bearer " + grant.token,
    );
  const utterance = (
    text: string,
    audience = "group",
    addressedTo?: string,
  ) => ({
    operation: "adventure-dialogue",
    eventId: randomUUID(),
    playerUuid: player.uuid,
    text,
    audience,
    addressedTo,
  });
  const greeting = utterance("Привет всем!");
  const response = await command(greeting);
  assert.equal(response.replies?.length, 3);
  assert.equal(new Set(response.replies?.map((reply) => reply.name)).size, 3);
  assert.deepEqual((await command(greeting)).replies, []);
  await command(
    utterance("Private amber spruce", "private", setup.members[0].name),
  );
  await command(utterance("Что мы видели?", "public"));
  assert.doesNotMatch(
    JSON.stringify(prompts.slice(-3)),
    /Private amber spruce/,
  );
  const exchange = await command(utterance("Поговорите друг с другом"));
  assert.deepEqual(
    exchange.replies?.map((reply) => [reply.name, reply.recipient]),
    [
      [setup.members[0].name, setup.members[1].name],
      [setup.members[1].name, setup.members[0].name],
    ],
  );
  assert.equal(
    groups.owner
      .adventure()
      .events.filter((event) => event.text === "Привет всем!").length,
    1,
  );
  assert.equal(
    (await command({ operation: "adventure-stop", playerUuid: player.uuid }))
      .cancelled,
    true,
  );
  await assert.rejects(
    command({ ...greeting, playerUuid: randomUUID(), eventId: randomUUID() }),
    /unauthorized/,
  );
});

test("an unavailable third group reply preserves earlier replies and names the failed actor", async () => {
  const { groups, setup, player } = fixture(false, "pine");
  const configured = groups.owner.change(setup);
  assert("code" in configured && typeof configured.code === "string");
  const grant = await groups.command(
    { operation: "redeem", code: configured.code, server: setup.server },
    null,
  );
  const result = await groups.command(
    {
      operation: "adventure-dialogue",
      revision: grant.revision,
      playerUuid: player.uuid,
      eventId: randomUUID(),
      text: "Привет всем!",
      audience: "group",
    },
    "Bearer " + grant.token,
  );
  assert.deepEqual(
    result.replies?.map(({ name }) => name),
    ["firBot", "ashBot"],
  );
  assert.deepEqual(result.replyFailures, [
    { name: "pineBot", reason: "timeout" },
  ]);
  assert.equal(groups.owner.adventure().events.length, 3);
});

test("public listen-only actors stay silent and a private fallback requires current delivery permission", async () => {
  const { groups, setup, player, bindings, prompts } = fixture();
  for (const [index, binding] of bindings.entries()) {
    binding.capability = {
      providerId: "live-" + index,
      manifest: {
        revision: "1",
        worldId: "forest",
        embodimentId: binding.characterId,
        capabilities: [],
      },
      policyRevision: 1,
      expiresAt: binding.expiresAt,
      allowedIntentIds: [],
      channelPolicy: {
        fallback: "private",
        channels: [
          { channel: "private", listen: true, react: true, speak: true },
          { channel: "public", listen: true, react: index === 0, speak: false },
        ],
      },
    };
  }
  const configured = groups.owner.change({ ...setup, publicChat: true });
  assert("code" in configured && typeof configured.code === "string");
  const grant = await groups.command(
    { operation: "redeem", code: configured.code, server: setup.server },
    null,
  );
  const send = (body: Record<string, unknown>) =>
    groups.command(
      { ...body, revision: grant.revision, playerUuid: player.uuid },
      "Bearer " + grant.token,
    );
  const eventId = randomUUID();
  const response = await send({
    operation: "adventure-dialogue",
    audience: "public",
    eventId,
    text: "Привет всем!",
  });
  assert.deepEqual(
    response.replies?.map(({ name, destination }) => [name, destination]),
    [["firBot", "private"]],
  );
  assert.equal(
    prompts.filter(
      (input) => typeof input === "object" && input && "profile" in input,
    ).length,
    1,
  );
  const events = groups.owner.adventure().events;
  const reply = events.find((event) => event.eventId.startsWith("reply-"));
  assert.notEqual(reply?.channelId, "public");
  assert.equal(reply?.observerIds.length, 0);
  bindings[0].capability!.policyRevision++;
  await assert.rejects(
    send({
      operation: "adventure-delivery-check",
      eventId,
      name: "firBot",
      destination: "private",
    }),
    /stale/,
  );
});

test("group delivery restricts fanout to the issued audience and current listeners", async () => {
  const { groups, setup, player, bindings } = fixture();
  for (const [index, binding] of bindings.entries()) {
    binding.capability = {
      providerId: "group-provider-" + index,
      manifest: {
        revision: "1",
        worldId: "forest",
        embodimentId: binding.characterId,
        capabilities: [],
      },
      policyRevision: 1,
      expiresAt: binding.expiresAt,
      allowedIntentIds: [],
      channelPolicy: {
        fallback: "silence",
        channels: [
          {
            channel: "group",
            listen: index !== 2,
            react: index === 0,
            speak: index === 0,
          },
        ],
      },
    };
  }
  const configured = groups.owner.change(setup);
  assert("code" in configured && typeof configured.code === "string");
  const grant = await groups.command(
    { operation: "redeem", code: configured.code, server: setup.server },
    null,
  );
  const send = (body: Record<string, unknown>) =>
    groups.command(
      { ...body, revision: grant.revision, playerUuid: player.uuid },
      "Bearer " + grant.token,
    );
  const eventId = randomUUID();
  const response = await send({
    operation: "adventure-dialogue",
    audience: "group",
    eventId,
    text: "Привет всем!",
  });
  assert.deepEqual(
    response.replies?.map(({ name, destination }) => [name, destination]),
    [["firBot", "group"]],
  );
  bindings[2].capability!.channelPolicy!.channels[0].listen = true;
  const delivery = {
    operation: "adventure-delivery-check",
    eventId,
    name: "firBot",
    destination: "group",
  };
  assert.deepEqual(await send(delivery), {
    authorized: true,
    listeners: ["ashBot"],
  });
  await assert.rejects(send(delivery), /stale/);
});

test("one bounded repair recovers malformed model speech without replacing earlier actor replies", async () => {
  const { groups, setup, player, prompts } = fixture(false, undefined, "pine");
  const configured = groups.owner.change(setup);
  assert("code" in configured && typeof configured.code === "string");
  const grant = await groups.command(
    { operation: "redeem", code: configured.code, server: setup.server },
    null,
  );
  const result = await groups.command(
    {
      operation: "adventure-dialogue",
      revision: grant.revision,
      playerUuid: player.uuid,
      eventId: randomUUID(),
      text: "Привет всем!",
      audience: "group",
    },
    "Bearer " + grant.token,
  );
  assert.deepEqual(
    result.replies?.map(({ name }) => name),
    ["firBot", "ashBot", "pineBot"],
  );
  assert.equal(result.replyFailures, undefined);
  assert.equal(
    prompts.filter((entry) => JSON.stringify(entry).includes('"name":"pine"'))
      .length,
    2,
  );
});

test("grounded group status with no host report keeps the genuine tone and discards false model facts", async () => {
  const { groups, setup, player } = fixture();
  const configured = groups.owner.change(setup);
  assert("code" in configured && typeof configured.code === "string");
  const grant = await groups.command(
    { operation: "redeem", code: configured.code, server: setup.server },
    null,
  );
  const response = await groups.command(
    {
      operation: "adventure-dialogue",
      revision: grant.revision,
      playerUuid: player.uuid,
      eventId: randomUUID(),
      text: "Как у вас дела со сбором?",
      audience: "group",
    },
    "Bearer " + grant.token,
  );
  assert.equal(response.replies?.length, 3);
  assert(
    response.replies?.every((reply) =>
      /Хи-хи.*результат неизвестен, число брёвен неизвестно/.test(reply.speech),
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(groups.owner.adventure().events),
    /собрал четыре/,
  );
});

test("factual projection keeps explicit zero and a later operation unknown when old results arrive late", () => {
  const base = {
    intentId: "minecraft.gather-logs",
    operationId: "previous",
    at: 1,
  };
  assert.match(
    adventureFactLine(
      [{ ...base, status: "failed", count: 0 }],
      "direct",
      true,
    ),
    /не удалось, собрано брёвен: 0/,
  );
  assert.match(
    adventureFactLine(
      [
        { ...base, status: "offered" },
        { ...base, operationId: "new", at: 10, status: "offered" },
        {
          ...base,
          at: 20,
          issuedAt: 1,
          status: "partial",
          count: 4,
          late: true,
        },
      ],
      "direct",
      true,
    ),
    /результат неизвестен, число брёвен неизвестно/,
  );
  assert.doesNotMatch(
    adventureFactLine(
      [
        { ...base, status: "failed", count: 0 },
        { ...base, at: 20, status: "progress", count: 4, late: true },
      ],
      "direct",
      true,
    ),
    /брёвен: 4/,
  );
});

test("a cutoff at the speech boundary triggers one real repair and preserves short utterances", async () => {
  const truncated = "Я".repeat(180);
  assert(clippedAdventureSpeech(truncated, truncated, 180));
  assert(
    clippedAdventureSpeech("  " + truncated.slice(2), truncated.slice(2), 180),
  );
  assert(
    !clippedAdventureSpeech(
      truncated.slice(2) + "!»",
      truncated.slice(2) + "!»",
      180,
    ),
  );
  assert(!clippedAdventureSpeech("Привет", "Привет", 180));
  const { groups, setup, player, prompts } = fixture(
    false,
    undefined,
    "pine",
    truncated,
  );
  const configured = groups.owner.change(setup);
  assert("code" in configured && typeof configured.code === "string");
  const grant = await groups.command(
    { operation: "redeem", code: configured.code, server: setup.server },
    null,
  );
  const result = await groups.command(
    {
      operation: "adventure-dialogue",
      revision: grant.revision,
      playerUuid: player.uuid,
      eventId: randomUUID(),
      text: "Привет всем!",
      audience: "group",
    },
    "Bearer " + grant.token,
  );
  assert.deepEqual(
    result.replies?.map(({ name }) => name),
    ["firBot", "ashBot", "pineBot"],
  );
  assert.equal(
    prompts.filter((entry) => JSON.stringify(entry).includes('"name":"pine"'))
      .length,
    2,
  );
  assert(
    !groups.owner.adventure().events.some((event) => event.text === truncated),
  );
});

test("a mixed courtesy and return request cannot claim a return if the model chooses ordinary reply", async () => {
  const { groups, setup, player } = fixture();
  const configured = groups.owner.change(setup);
  assert("code" in configured && typeof configured.code === "string");
  const grant = await groups.command(
    { operation: "redeem", code: configured.code, server: setup.server },
    null,
  );
  const response = await groups.command(
    {
      operation: "adventure-dialogue",
      revision: grant.revision,
      playerUuid: player.uuid,
      eventId: randomUUID(),
      text: "Спасибо за разговор. Попробуйте вернуться из леса.",
      audience: "group",
    },
    "Bearer " + grant.token,
  );
  assert.equal(response.replies?.length, 3);
  assert.deepEqual(response.assignments, []);
  assert(
    response.replies?.every((reply) =>
      /Моё возвращение — результат неизвестен/.test(reply.speech),
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(groups.owner.adventure().events),
    /собрал четыре/,
  );
});
