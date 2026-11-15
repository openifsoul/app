import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import {
  createBehaviorRuntime,
  createParticipantRuntime,
} from "@ifsoul/core/runtime";
import { createSQLParticipantStore } from "../../apps/runtime-host/src/participant-sessions.js";
import { createBehaviorService } from "../../apps/runtime-host/src/behavior.js";
import { createCharacterWorkspace } from "../../apps/runtime-host/src/characters.js";
import {
  createModelController,
  fitModelPrompt,
} from "../../apps/runtime-host/src/service.js";
import { createAppBehavior } from "../../apps/server/src/behavior.js";
import { createGameExecutor } from "../../apps/server/src/game-executor.js";
import { createAPI } from "../../apps/server/src/api.js";
import { createBridgeSourcePolicy } from "../../apps/server/src/bridge-source-access.js";
import {
  createGameConnectionBroker,
  gameDeviceRequest,
} from "../../apps/server/src/game-connections.js";
import {
  createGameContinuity,
  projectLinkedRelationshipTransition,
} from "../../apps/server/src/game-continuity.js";
import type {
  GenerationInput,
  ModelClient,
} from "@ifsoul/core/model-providers/types";

const owner = "linked-owner";
const player = {
  name: "Visitor",
  uuid: "11111111-1111-4111-8111-111111111111",
};
const outsider = {
  name: "Outsider",
  uuid: "22222222-2222-4222-8222-222222222222",
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const playerId = "player-" + digest([owner, player.uuid]);

async function fixture({
  reflectionTimeoutMs = 5000,
  reflectionMode = "normal",
  explanationMode = "valid",
  secondInvalid = false,
  deltaIntent = "+25%",
  recallMode = "ordinary",
}: {
  reflectionTimeoutMs?: number;
  explanationMode?: "valid" | "missing" | "forged";
  secondInvalid?: boolean;
  deltaIntent?: string;
  recallMode?:
    | "bypass-attempt"
    | "ordinary"
    | "supported"
    | "forged"
    | "wrong-source"
    | "insufficient"
    | "pruned"
    | "revoked";
  reflectionMode?: "normal" | "missing-current" | "failed" | "hang";
} = {}) {
  const db = new DatabaseSync(":memory:");
  const transaction = <T>(work: () => T) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const store = createSQLParticipantStore({
    prepare: (sql) => db.prepare(sql),
    transaction,
  });
  const privateSettings = new Map<string, string>();
  const settings = {
    get: (key: string) => privateSettings.get(key),
    set: (key: string, value: string) => {
      privateSettings.set(key, value);
    },
    delete: (key: string) => {
      privateSettings.delete(key);
    },
  };
  const memory = openSQLiteMemory(":memory:");
  assert(memory.ok);
  const broker = createGameConnectionBroker({ store: settings, transaction });
  const policy = createBridgeSourcePolicy(settings);
  const participants = createParticipantRuntime(store);
  const prompts: Record<string, any>[] = [];
  let onGenerate: ((prompt: Record<string, any>) => void) | undefined;
  let changeRelation = true;
  const client: ModelClient = {
    id: "ollama",
    async generate(input: GenerationInput) {
      const prompt = JSON.parse(input.prompt);
      if (Object.hasOwn(prompt, "currentUtterance"))
        return {
          ok: true,
          value: {
            recallIntent:
              recallMode === "ordinary"
                ? "general-or-creative"
                : "factual-recall",
          },
        };
      prompts.push(prompt);
      onGenerate?.(prompt);
      if (!prompt.inspection)
        return {
          ok: true,
          value: {
            content:
              recallMode === "ordinary" || recallMode === "supported"
                ? "Обе версии услышаны. Подтверждения нет."
                : "Недостоверный текст модели не должен сохраниться.",
            ...(prompt.recallEvidence && {
              answerability:
                recallMode === "ordinary" || recallMode === "bypass-attempt"
                  ? "ordinary"
                  : recallMode === "insufficient"
                    ? "insufficient-evidence"
                    : "supported-recall",
              evidenceRefs:
                recallMode === "ordinary" ||
                recallMode === "bypass-attempt" ||
                recallMode === "insufficient"
                  ? []
                  : [
                      {
                        ref:
                          recallMode === "forged"
                            ? "event:fake"
                            : "event:sad-1",
                        source:
                          recallMode === "wrong-source"
                            ? "host-observation"
                            : "participant-claim",
                      },
                    ],
            }),
            ...(prompt.linkedGameEvidence?.proposedRelationships &&
              explanationMode !== "missing" && {
                relationshipExplanations:
                  prompt.linkedGameEvidence.proposedRelationships.map(
                    ({ proposalRef }: { proposalRef: string }) => ({
                      proposalRef:
                        explanationMode === "forged" ? "forged" : proposalRef,
                      reason: "Игрок исправил версию. Подтверждения нет.",
                    }),
                  ),
              }),
          },
        };
      if (reflectionMode === "failed")
        return {
          ok: false,
          error: { code: "unavailable", message: "Synthetic provider failure" },
        };
      if (reflectionMode === "hang") return await new Promise<never>(() => {});
      const sources = prompt.priorEvidence
        .filter((entry: { eventId: string }) =>
          ["sad-1", "podval-2"].includes(entry.eventId),
        )
        .map((entry: { eventId: string }) => entry.eventId);
      return {
        ok: true,
        value: {
          changes:
            changeRelation && sources.length === 2
              ? Array.from({ length: secondInvalid ? 2 : 1 }, () => ({
                  parameterId: "trust",
                  targetParticipantId: playerId,
                  deltaIntent,
                  confidence: 0.4,
                  ...(reflectionMode !== "missing-current" && {
                    currentEventId: prompt.event.eventId,
                  }),
                  priorEvidenceIds: sources,
                }))
              : [],
        },
      };
    },
  };
  let ordinaryBehavior: ReturnType<typeof createAppBehavior>;
  const workspace = createCharacterWorkspace({
    memory: memory.value,
    chatEnvironment: "app",
    controllerFor: () => (input, signal) =>
      ordinaryBehavior.guardController(
        input,
        signal,
        createModelController({ client, model: "test-local" }),
      ),
  });
  const continuity = createGameContinuity({
    principalId: owner,
    broker,
    store,
    workspace,
    clientFor: async () => client,
    timeoutMs: 10000,
    reflectionTimeoutMs,
    sourceAccess: policy.snapshot,
    ...(recallMode === "pruned" && {
      promptBudgetFor: () => ({
        bytes: 21000,
        ceiling: 21000,
        fitsModelInput({ prompt }: { prompt: string }) {
          const packed = JSON.parse(prompt);
          return !packed.linkedGameEvidence?.participantClaims.some(
            (event: { eventId: string }) => event.eventId === "sad-1",
          );
        },
      }),
    }),
  });
  ordinaryBehavior = createAppBehavior({
    store,
    access: { principalId: owner, hostId: "app" },
    workspace,
  });
  const api = createAPI({
    mode: "local",
    access: { kind: "principal", id: owner },
    password: "synthetic",
    encryptionKey: "synthetic",
    store: settings,
    service: workspace,
    gameContinuity: continuity,
    behavior: ordinaryBehavior,
    providers: async () => [
      {
        id: "ollama",
        label: "Test",
        available: true,
        models: [{ id: "test-local", label: "Test" }],
      },
    ],
  });
  const call = (path: string, body?: unknown) =>
    api(
      new Request("http://localhost/api/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const profile = await call("characters", {
    requestId: "linked-npc",
    name: "Страж",
    description: "Вымышленный собеседник",
    biography: "Стоит у ворот.",
    speechStyle: "Говорит кратко.",
  });
  assert.equal(profile.status, 200);
  const memoryId = (await profile.json()).value.character.characterId as string;
  const npcId = "npc-" + digest(memoryId);
  const { config: initialBehavior } = await ordinaryBehavior.read(memoryId);
  await ordinaryBehavior.update({
    expectedRevision: initialBehavior.revision,
    config: { ...initialBehavior, revision: initialBehavior.revision + 1 },
  });
  function connection(actor: typeof player, principalId = owner) {
    const created = broker.create(principalId, {
      memoryId,
      characterId: memoryId,
      provider: "ollama",
      model: "test-local",
      actions: ["movement"],
      character: { id: memoryId, name: "Страж", temperament: "Спокоен." },
    });
    const { token } = broker.redeem(created.code);
    const binding = broker.ready(token, actor, undefined, ["movement"]);
    return { token, binding };
  }
  const first = connection(player),
    second = connection(player),
    other = connection(outsider);
  const foreign = connection(player, "another-owner");
  const sourceGrants = [first, second, other] as const;
  const contents = [
    "В Саду я закрыл восточные ворота.",
    "В Подвале я исправился: их закрыла Лада. Подтверждений нет.",
    "УЛЬТРАМАРИН — чужой приватный рассказ.",
  ];
  for (const [index, { binding }] of sourceGrants.entries()) {
    const senderId = "player-" + digest([owner, binding.player!.uuid]);
    const access = { principalId: owner, hostId: binding.hostId };
    participants.register(access, {
      participantId: npcId,
      subjectId: "memory-" + digest(memoryId),
      kind: "npc",
    });
    participants.register(access, {
      participantId: senderId,
      subjectId: "verified-game-" + digest([owner, binding.player!.uuid]),
      kind: "player",
    });
    const sessionId = "session-" + binding.connectionId;
    for (const session of [
      sessionId,
      ...(index === 0 ? ["same-host-sibling"] : []),
    ]) {
      participants.transition(access, "bind-" + session, 0, {
        sessionId: session,
        revision: 1,
        hostId: binding.hostId,
        worldId: binding.hostId,
        recallWorldIds: [binding.hostId],
        members: [
          { participantId: npcId, role: "npc" },
          { participantId: senderId, role: "player" },
        ],
        groups: [],
        channels: [{ channelId: "private", participantIds: [npcId, senderId] }],
      });
      await createBehaviorService({ store, access }).observe({
        event: {
          eventId:
            session === "same-host-sibling"
              ? "sibling-private"
              : ["sad-1", "podval-2", "other-private"][index],
          sessionId: session,
          revision: 1,
          channelId: "private",
          senderId,
          recipientIds: [npcId],
          observerIds: [],
          text:
            session === "same-host-sibling"
              ? "СЕКРЕТ СОСЕДНЕЙ СЕССИИ"
              : contents[index],
        },
        kind: "observation",
        npcIds: [npcId],
        strategy: "rules",
      });
    }
  }
  const consent = (
    token: string,
    scope: "history-consent" | "continuity-consent",
    allowed = true,
  ) =>
    gameDeviceRequest(
      new Request("http://localhost/api/game/device/" + scope, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ allowed }),
      }),
      broker,
      async () => {},
      false,
      true,
    );
  const executor = createGameExecutor({
    store,
    validate: async (binding) => broker.current(binding),
    clientFor: async () => client,
  });
  const sendOutcome = (token: string, id: string, result = "arrived") =>
    gameDeviceRequest(
      new Request("http://localhost/api/game/device/dialogue", {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operation: "action-outcome",
          id,
          action: "come",
          result,
        }),
      }),
      broker,
      executor.execute,
    );
  const originalBytes = () =>
    store.transact(owner, (state) =>
      JSON.stringify(
        state.events.filter((event) =>
          ["sad-1", "podval-2", "other-private", "sibling-private"].includes(
            event.eventId,
          ),
        ),
      ),
    );
  const chat = (
    requestId: string,
    gameContext?: { anchor: string; sources: string[] },
    extra: Record<string, unknown> = {},
  ) =>
    call("chat", {
      requestId,
      characterId: memoryId,
      memoryCharacterId: memoryId,
      operation: "chat",
      provider: "ollama",
      model: "test-local",
      message: "Кто закрыл восточные ворота?",
      ...(gameContext ? { gameContext } : {}),
      ...extra,
    });
  return {
    db,
    async seedTrust(sourceId = "sad-1", delta = 4) {
      if (sourceId !== "sad-1") {
        await createBehaviorService({
          store,
          access: { principalId: owner, hostId: first.binding.hostId },
        }).observe({
          event: {
            eventId: sourceId,
            sessionId: "session-" + first.binding.connectionId,
            revision: 1,
            channelId: "private",
            senderId: playerId,
            recipientIds: [npcId],
            observerIds: [],
            text: "Старый отдельный источник.",
          },
          kind: "observation",
          npcIds: [npcId],
        });
      }
      createBehaviorRuntime(store).apply(
        { principalId: owner, hostId: first.binding.hostId },
        {
          npcId,
          sessionId: "session-" + first.binding.connectionId,
          proposalId: "seed-trust",
          configRevision: initialBehavior.revision + 1,
          expectedStateRevision: 0,
          changes: [
            {
              parameterId: "trust",
              targetParticipantId: playerId,
              delta,
              confidence: 0.7,
              reason: "Первая оценка",
              evidenceEventIds: [sourceId],
            },
          ],
        },
        1000,
      );
    },
    sendOutcome,
    async reportLookalikes() {
      const access = { principalId: owner, hostId: first.binding.hostId };
      const instance = createBehaviorService({ store, access });
      for (const record of [
        {
          eventId: "host-aaaaaaaaaaaaaaaaaaaaaaaa",
          senderId: playerId,
          recipientIds: [npcId],
        },
        {
          eventId: "host-bbbbbbbbbbbbbbbbbbbbbbbb",
          senderId: npcId,
          recipientIds: [playerId],
        },
      ]) {
        await instance.observe({
          event: {
            ...record,
            sessionId: "session-" + first.binding.connectionId,
            revision: 1,
            channelId: "private",
            observerIds: [],
            text: "Minecraft host ended come: arrived.",
          },
          kind: "observation",
          npcIds: [npcId],
        });
      }
    },
    close: () => {
      db.close();
      if (memory.ok) memory.value.close();
    },
    broker,
    policy,
    store,
    first,
    second,
    other,
    foreign,
    prompts,
    consent,
    chat,
    memoryId,
    npcId,
    originalBytes,
    list: () => continuity.list(memoryId),
    behaviorConfig: () => call("behavior?characterId=" + memoryId),
    behaviorState: (sessionId: string, actor = npcId) =>
      call(
        `behavior/state?sessionId=${encodeURIComponent(sessionId)}&npcId=${encodeURIComponent(actor)}`,
      ),
    snapshot: () =>
      call("snapshot?characterId=" + encodeURIComponent(memoryId)),
    hook: (value: typeof onGenerate) => {
      onGenerate = value;
    },
    disableChanges: () => {
      changeRelation = false;
    },
  };
}

test("App Conversation requires independent native consent and projects only explicitly linked game sources", async () => {
  const f = await fixture();
  try {
    const originals = f.originalBytes();
    assert.equal(
      (await f.consent(f.first.token, "history-consent")).status,
      200,
    );
    assert.deepEqual(f.list(), []);
    for (const item of [f.first, f.second, f.other, f.foreign])
      assert.equal(
        (await f.consent(item.token, "continuity-consent")).status,
        200,
      );
    const approved = f.list();
    assert.equal(approved.length, 3);
    const first = approved.find(
      (item) => item.worldId === f.first.binding.hostId,
    )!;
    const second = approved.find(
      (item) => item.worldId === f.second.binding.hostId,
    )!;
    const other = approved.find(
      (item) => item.worldId === f.other.binding.hostId,
    )!;
    assert.equal(
      (await f.chat("other-player", { anchor: first.id, sources: [other.id] }))
        .status,
      400,
    );
    assert.equal(f.prompts.length, 0);

    const scope = { anchor: first.id, sources: [second.id] };
    const reply = await f.chat("linked", scope);
    const delivery = await reply.json();
    assert.equal(reply.status, 200, JSON.stringify(delivery));
    assert.equal(
      delivery.value.run.result.response.output.content,
      "Обе версии услышаны. Подтверждения нет.",
    );
    assert.equal(f.prompts.length, 2);
    const [reflection, conversation] = f.prompts;
    assert.deepEqual(
      new Set(
        reflection.priorEvidence.map(
          (event: { eventId: string; worldId: string }) =>
            [event.eventId, event.worldId].join(":"),
        ),
      ),
      new Set([
        "sad-1:" + f.first.binding.hostId,
        "podval-2:" + f.second.binding.hostId,
      ]),
    );
    const evidence = conversation.linkedGameEvidence;
    assert.deepEqual(
      new Set(
        evidence.participantClaims.map(
          (event: { eventId: string }) => event.eventId,
        ),
      ),
      new Set(["sad-1", "podval-2"]),
    );
    assert(
      evidence.participantClaims.every(
        (event: { reporterId: string }) => event.reporterId === playerId,
      ),
    );
    assert.deepEqual(evidence.companionDialogue, []);
    assert.deepEqual(evidence.verifiedHostObservations, []);
    assert.deepEqual(evidence.relationships, []);
    assert.equal(
      evidence.proposedRelationships[0].targetParticipantId,
      playerId,
    );
    assert.deepEqual(
      new Set(evidence.proposedRelationships[0].evidenceEventIds),
      new Set(["sad-1", "podval-2", evidence.currentEventId]),
    );
    const committed = f.store.transact(owner, (state) =>
      state.behavior?.history.at(-1),
    );
    assert.equal(
      committed?.reason,
      "Игрок исправил версию. Подтверждения нет.",
    );
    assert.equal(committed?.targetParticipantId, playerId);
    assert.doesNotMatch(
      JSON.stringify(f.prompts),
      /ультрамарин|соседней сессии/iu,
    );
    assert.equal(f.originalBytes(), originals);
    assert.equal((await f.chat("linked", scope)).status, 200);
    assert.equal(f.prompts.length, 2);
    const ordinarySnapshot = await (await f.snapshot()).json();
    assert.doesNotMatch(
      JSON.stringify(ordinarySnapshot),
      /Обе версии услышаны|app-linked-output/iu,
    );
    assert.equal((await f.chat("ordinary")).status, 200);
    assert.equal(f.prompts.at(-1)!.linkedGameEvidence, undefined);
    assert.doesNotMatch(
      JSON.stringify(f.prompts.at(-1)),
      /подтверждения нет|podval-2|app-linked-output/iu,
    );
    assert.equal(
      (await f.consent(f.second.token, "continuity-consent", false)).status,
      200,
    );
    assert.equal((await f.chat("linked", scope)).status, 400);
    assert.equal(f.prompts.length, 3);
    const reduced = await f.chat("linked", { anchor: first.id, sources: [] });
    assert.equal(reduced.status, 200, JSON.stringify(await reduced.json()));
    const [reducedReflection, reducedConversation] = f.prompts.slice(3);
    assert.equal(f.prompts.length, 5);
    assert.equal(
      reducedConversation.linkedGameEvidence.relationships.length,
      0,
    );
    assert.deepEqual(
      reducedConversation.linkedGameEvidence.participantClaims.map(
        (event: { eventId: string }) => event.eventId,
      ),
      ["sad-1"],
    );
    assert.doesNotMatch(
      JSON.stringify([reducedReflection, reducedConversation]),
      /podval-2|Игрок исправил версию|Обе версии услышаны/iu,
    );
    assert.equal(f.originalBytes(), originals);
    const config = (await (await f.behaviorConfig()).json()).value;
    const ordinarySession = "app-" + digest(f.memoryId);
    assert(
      config.catalog.sessions.some(
        (session: { sessionId: string }) =>
          session.sessionId === ordinarySession,
      ),
    );
    const ordinary = await f.behaviorState(ordinarySession);
    assert.equal(ordinary.status, 200);
    const state = (await ordinary.json()).value;
    assert(
      state.parameters.some(
        (parameter: { parameterId: string }) =>
          parameter.parameterId === "trust",
      ),
    );
    assert(
      !state.values.some(
        (value: { targetParticipantId?: string }) =>
          value.targetParticipantId === playerId,
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(state.history),
      /podval-2|Игрок исправил версию/iu,
    );
    assert.equal(
      (await f.behaviorState(ordinarySession, "npc-wrong")).status,
      403,
    );
    const foreignSessions = config.catalog.sessions.filter(
      (session: { sessionId: string }) => session.sessionId !== ordinarySession,
    );
    assert(foreignSessions.length > 0);
    for (const session of foreignSessions) {
      const result = await f.behaviorState(session.sessionId);
      assert.equal(result.status, 403);
      assert.match(
        JSON.stringify(await result.json()),
        /Select an App Conversation session/u,
      );
    }
    assert.equal((await f.chat("after-revoke")).status, 200);
    assert.equal(f.prompts.at(-1)!.linkedGameEvidence, undefined);
    assert.doesNotMatch(
      JSON.stringify(f.prompts.at(-1)),
      /podval-2|Игрок исправил версию/u,
    );
    await f.consent(f.second.token, "continuity-consent");
    const renewed = f
      .list()
      .find((item) => item.worldId === f.second.binding.hostId)!;
    assert.notEqual(renewed.id, second.id);
    assert.equal((await f.chat("linked", scope)).status, 400);
    const ready = f.broker.ready(f.first.token, player);
    assert.notEqual(ready.revision, f.first.binding.revision);
    assert(!f.list().some((item) => item.id === first.id));
    assert.equal(f.prompts.length, 6);
  } finally {
    f.close();
  }
});

test("linked conversation fences reflection and delivered speech on grant and same-host source revocation", async () => {
  for (const boundary of ["reflection", "reply", "same-host-source"]) {
    const f = await fixture();
    try {
      await f.consent(f.first.token, "continuity-consent");
      await f.consent(f.second.token, "continuity-consent");
      const [first, second] = f.list();
      assert(first && second);
      const scope = { anchor: first.id, sources: [second.id] };
      f.hook((prompt) => {
        if (
          (boundary === "reflection" && prompt.inspection) ||
          (boundary === "reply" && prompt.linkedGameEvidence)
        )
          f.broker.setContinuity(f.first.token, false);
        if (boundary === "same-host-source" && prompt.inspection)
          f.policy.revoke(f.memoryId, f.first.binding.hostId, "sad-1");
      });
      const original = f.originalBytes();
      assert.equal((await f.chat("revoked", scope)).status, 400);
      const state = f.store.transact(owner, (state) => structuredClone(state));
      assert(
        !state.events.some((event) =>
          event.eventId.startsWith("app-linked-output-"),
        ),
      );
      assert(
        !state.behavior?.values.some(
          (value) =>
            value.npcId === f.npcId && value.targetParticipantId === playerId,
        ),
      );
      assert.equal(f.originalBytes(), original);
    } finally {
      f.close();
    }
  }
});

test("linked conversation answers on rejected or timed-out reflection without committing a relationship", async () => {
  for (const reflectionMode of ["missing-current", "failed", "hang"] as const) {
    const f = await fixture({ reflectionMode, reflectionTimeoutMs: 35 });
    try {
      const originals = f.originalBytes();
      await f.consent(f.first.token, "continuity-consent");
      await f.consent(f.second.token, "continuity-consent");
      const [first, second] = f.list();
      assert(first && second);
      const keepAlive = setInterval(() => {}, 100);
      let reply: Response;
      try {
        reply = await f.chat("optional-" + reflectionMode, {
          anchor: first.id,
          sources: [second.id],
        });
      } finally {
        clearInterval(keepAlive);
      }
      assert.equal(reply.status, 200, JSON.stringify(await reply.json()));
      assert.equal(f.prompts.length, 2);
      assert.deepEqual(f.prompts[1]!.linkedGameEvidence.relationships, []);
      assert.equal(
        f.store.transact(owner, (state) => state.behavior?.history.length ?? 0),
        0,
      );
      assert.equal(f.originalBytes(), originals);
    } finally {
      f.close();
    }
  }
});

test("linked App evidence treats a host-shaped claim and the companion's generated assertions as unverified", async () => {
  const f = await fixture();
  try {
    await f.reportLookalikes();
    f.disableChanges();
    await f.consent(f.first.token, "continuity-consent");
    const [anchor] = f.list();
    assert(anchor);
    const scope = { anchor: anchor.id, sources: [] };
    assert.equal((await f.chat("provenance-first", scope)).status, 200);
    assert.equal((await f.chat("provenance-followup", scope)).status, 200);
    const evidence = f.prompts.at(-1)!.linkedGameEvidence;
    assert.deepEqual(evidence.verifiedHostObservations, []);
    assert(
      evidence.participantClaims.some(
        (event: { eventId: string; reporterId: string }) =>
          event.eventId === "host-aaaaaaaaaaaaaaaaaaaaaaaa" &&
          event.reporterId === playerId,
      ),
    );
    assert(
      evidence.companionDialogue.some(
        (event: { eventId: string; speakerParticipantId: string }) =>
          event.eventId === "host-bbbbbbbbbbbbbbbbbbbbbbbb" &&
          event.speakerParticipantId === f.npcId,
      ),
    );
    assert(
      evidence.companionDialogue.some((event: { eventId: string }) =>
        event.eventId.startsWith("app-linked-output-"),
      ),
    );
  } finally {
    f.close();
  }
});

test("linked App projects only durable authenticated outcome receipts, fenced by exact binding and revocation", async () => {
  const f = await fixture();
  try {
    const first = f.first;
    const access = { principalId: owner, hostId: first.binding.hostId };
    const eventId =
      "host-" + digest([first.binding.connectionId, "native-receipt"]);
    assert.equal(
      (await f.sendOutcome("invalid-token", "native-receipt")).status,
      403,
    );
    assert.equal(
      (await f.sendOutcome(first.token, "native-receipt")).status,
      200,
    );
    assert.equal(
      (await f.sendOutcome(first.token, "native-receipt")).status,
      200,
    );
    assert.equal(
      (await f.sendOutcome(first.token, "native-receipt", "interrupted"))
        .status,
      403,
    );
    const event = f.store.transact(owner, (state) =>
      state.events.find((item) => item.eventId === eventId),
    );
    assert(event);
    const connection = first.binding.connectionId;
    assert.deepEqual(f.store.gameOutcome(access, connection, event), {
      action: "come",
      result: "arrived",
    });
    assert.equal(
      f.store.gameOutcome(
        { ...access, principalId: "another-owner" },
        connection,
        event,
      ),
      undefined,
    );
    assert.equal(
      f.store.gameOutcome(
        { ...access, hostId: "another-host" },
        connection,
        event,
      ),
      undefined,
    );
    assert.equal(
      f.store.gameOutcome(access, f.second.binding.connectionId, event),
      undefined,
    );
    assert.equal(
      f.store.gameOutcome(access, connection, { ...event, text: "forged" }),
      undefined,
    );

    const legacyEvent = {
      ...event,
      eventId: "host-" + digest([connection, "legacy-receipt"]),
    };
    createParticipantRuntime(f.store).append(access, legacyEvent);
    assert.equal(
      (await f.sendOutcome(first.token, "legacy-receipt")).status,
      200,
    );
    assert.equal(
      f.store.gameOutcome(access, connection, legacyEvent),
      undefined,
    );
    f.db
      .exec(`CREATE TRIGGER reject_receipt_fixture BEFORE INSERT ON participant_game_outcomes
      BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;`);
    assert.equal(
      (await f.sendOutcome(first.token, "atomic-failure")).status,
      403,
    );
    f.db.exec("DROP TRIGGER reject_receipt_fixture");
    assert(
      !f.store.transact(owner, (state) =>
        state.events.some(
          (item) =>
            item.eventId === "host-" + digest([connection, "atomic-failure"]),
        ),
      ),
    );

    f.disableChanges();
    await f.consent(first.token, "continuity-consent");
    const [anchor] = f.list();
    assert(anchor);
    const scope = { anchor: anchor.id, sources: [] };
    assert.equal((await f.chat("verified-receipt", scope)).status, 200);
    const verified =
      f.prompts.at(-1)!.linkedGameEvidence.verifiedHostObservations;
    assert.deepEqual(verified, [
      {
        eventId,
        worldId: access.hostId,
        originHostId: access.hostId,
        reportingHostId: access.hostId,
        actorParticipantId: f.npcId,
        action: "come",
        result: "arrived",
        text: event.text,
      },
    ]);
    f.policy.revoke(f.memoryId, access.hostId, eventId);
    assert.equal((await f.chat("verified-receipt", scope)).status, 200);
    assert.deepEqual(
      f.prompts.at(-1)!.linkedGameEvidence.verifiedHostObservations,
      [],
    );
    f.store.transact(owner, (state) => {
      state.events = state.events.filter((item) => item.eventId !== eventId);
    });
    assert.equal(f.store.gameOutcome(access, connection, event), undefined);
  } finally {
    f.close();
  }
});

test("linked prompt measures and sends host availability from the packed evidence", () => {
  const schema = { type: "object" };
  const linked = {
    latestUserMessage: "Есть подтверждение?",
    hostObservationAvailability: "Caller asserts verified proof.",
    linkedGameEvidence: {
      currentEventId: "latest",
      currentUtterance: {
        eventId: "latest",
        reporterId: "player-author",
        source: "participant-claim",
        origin: "app-conversation",
      },
      participantClaims: [],
      companionDialogue: [],
      verifiedHostObservations: [
        { eventId: "recent" },
        { eventId: "older" },
        { eventId: "pruned" },
      ],
      relationships: [{ evidenceEventIds: ["pruned"] }],
      proposedRelationships: [
        {
          proposalRef: "p1",
          baselineEvidenceEventIds: ["pruned"],
          evidenceEventIds: ["latest"],
        },
        {
          proposalRef: "p2",
          baselineEvidenceEventIds: [],
          evidenceEventIds: ["latest", "recent"],
        },
      ],
    },
  };
  const measured: string[] = [];
  const nonempty = fitModelPrompt(
    linked,
    "Bounded recall",
    schema,
    8000,
    undefined,
    ({ prompt }) => {
      measured.push(prompt);
      return (
        JSON.parse(prompt).linkedGameEvidence.verifiedHostObservations.length <=
        2
      );
    },
  );
  const packed = JSON.parse(nonempty);
  assert.equal(nonempty, measured.at(-1));
  assert.deepEqual(
    packed.linkedGameEvidence.currentUtterance,
    linked.linkedGameEvidence.currentUtterance,
  );
  assert.deepEqual(Object.keys(packed).slice(-2), [
    "hostObservationAvailability",
    "latestUserMessage",
  ]);
  assert.deepEqual(packed.linkedGameEvidence.verifiedHostObservations, [
    { eventId: "recent" },
    { eventId: "older" },
  ]);
  assert.deepEqual(packed.linkedGameEvidence.relationships, []);
  assert.deepEqual(packed.linkedGameEvidence.proposedRelationships, [
    {
      proposalRef: "p2",
      baselineEvidenceEventIds: [],
      evidenceEventIds: ["latest", "recent"],
    },
  ]);
  assert.match(
    packed.hostObservationAvailability,
    /only for the actor, action and result/u,
  );
  assert.doesNotMatch(nonempty, /Caller asserts/u);

  const empty = {
    ...linked,
    linkedGameEvidence: {
      ...linked.linkedGameEvidence,
      verifiedHostObservations: [],
    },
  };
  const emptyPrompt = fitModelPrompt(empty, "Bounded recall", schema);
  const noObservation = JSON.parse(emptyPrompt);
  assert.match(
    noObservation.hostObservationAvailability,
    /No independently authenticated host observations are available in this context/u,
  );
  assert.match(
    noObservation.hostObservationAvailability,
    /claim has not been proven false/u,
  );
  const exactBytes = Buffer.byteLength(
    JSON.stringify({
      messages: [
        { role: "system", content: "Bounded recall" },
        { role: "user", content: emptyPrompt },
      ],
      stream: false,
      max_tokens: 1024,
      response_format: { type: "json_schema", json_schema: schema },
    }),
  );
  assert.equal(
    fitModelPrompt(empty, "Bounded recall", schema, exactBytes, exactBytes),
    emptyPrompt,
  );
  assert.throws(() =>
    fitModelPrompt(empty, "Bounded recall", schema, exactBytes - 1, exactBytes),
  );
  assert.deepEqual(
    JSON.parse(
      fitModelPrompt(
        { latestUserMessage: "Ordinary" },
        "Bounded recall",
        schema,
      ),
    ),
    { latestUserMessage: "Ordinary" },
  );
});

test("linked explanation is optional and an invalid second change leaves no partial relation", async () => {
  for (const failed of ["missing", "forged", "second-change"] as const) {
    const f = await fixture({
      explanationMode: failed === "second-change" ? "valid" : failed,
      secondInvalid: failed === "second-change",
    });
    try {
      await f.consent(f.first.token, "continuity-consent");
      await f.consent(f.second.token, "continuity-consent");
      const [first, second] = f.list();
      assert(first && second);
      const reply = await f.chat("optional-explanation", {
        anchor: first.id,
        sources: [second.id],
      });
      assert.equal(reply.status, 200, JSON.stringify(await reply.json()));
      assert.equal(f.prompts.length, 2);
      assert.equal(
        f.prompts[1]!.linkedGameEvidence.proposedRelationships.length,
        failed === "second-change" ? 2 : 1,
      );
      const { events, behavior } = f.store.transact(owner, (state) =>
        structuredClone(state),
      );
      assert.equal(behavior?.history.length, 0);
      assert.equal(behavior?.values.length, 0);
      assert.equal(
        events.filter((event) => event.eventId.startsWith("app-linked-output-"))
          .length,
        1,
      );
    } finally {
      f.close();
    }
  }
});

test("linked reply write failure rolls back relationship; midflight config and state revisions fail closed", async () => {
  for (const boundary of ["complete", "config", "state"] as const) {
    const f = await fixture();
    try {
      const original = f.originalBytes();
      await f.consent(f.first.token, "continuity-consent");
      await f.consent(f.second.token, "continuity-consent");
      const [first, second] = f.list();
      assert(first && second);
      f.hook((prompt) => {
        if (!prompt.linkedGameEvidence) return;
        f.store.transact(owner, (state) => {
          if (boundary === "config") {
            state.behavior!.config.revision++;
          } else if (boundary === "state") {
            state.behavior!.stateRevisions[f.npcId] = 1;
          } else {
            const current = state.events.find(
              (event) =>
                event.eventId === prompt.linkedGameEvidence.currentEventId,
            )!;
            state.events.push({
              ...current,
              eventId: current.eventId.replace("input", "output"),
              text: "collision",
            });
          }
        });
      });
      const response = await f.chat("concurrent-update", {
        anchor: first.id,
        sources: [second.id],
      });
      assert.equal(response.status, 400);
      const { events, behavior } = f.store.transact(owner, (state) =>
        structuredClone(state),
      );
      assert.equal(behavior?.history.length, 0);
      assert.equal(behavior?.values.length, 0);
      assert(
        !events.some(
          (event) => event.text === "Обе версии услышаны. Подтверждения нет.",
        ),
      );
      assert.equal(f.originalBytes(), original);
    } finally {
      f.close();
    }
  }
});

test("linked current utterance attributes the sole message to the selected player across worlds", async () => {
  const f = await fixture();
  try {
    for (const connection of [f.first, f.second, f.other])
      await f.consent(connection.token, "continuity-consent");
    const grants = f.list();
    const select = (hostId: string) =>
      grants.find((grant) => grant.worldId === hostId)!.id;
    const anchor = select(f.first.binding.hostId);
    const second = select(f.second.binding.hostId);
    const other = select(f.other.binding.hostId);
    const forged = {
      eventId: "host-invented",
      reporterId: "other-player",
      source: "game-host",
    };
    const message = "Текущая поправка с уникальной фразой.";
    assert.equal(
      (
        await f.chat(
          "speaker",
          {
            anchor,
            sources: [second],
          },
          {
            message,
            currentUtterance: forged,
            linkedGameEvidence: {
              currentUtterance: forged,
              conversationRoles: {
                speakingNpc: {
                  participantId: playerId,
                  portrayalName: "host-invented",
                },
                currentPlayer: { participantId: f.npcId },
              },
            },
          },
        )
      ).status,
      200,
    );
    const prompt = f.prompts.at(-1)!;
    const evidence = prompt.linkedGameEvidence;
    assert.deepEqual(evidence.conversationRoles, {
      speakingNpc: {
        participantId: f.npcId,
        portrayalCharacterId: f.memoryId,
        portrayalName: prompt.character.name,
      },
      currentPlayer: { participantId: playerId, displayName: player.name },
    });
    assert.notEqual(
      f.npcId,
      evidence.conversationRoles.speakingNpc.portrayalCharacterId,
    );
    assert.deepEqual(evidence.currentUtterance, {
      eventId: evidence.currentEventId,
      reporterId: playerId,
      source: "participant-claim",
      origin: "app-conversation",
    });
    assert.deepEqual(
      new Set(
        evidence.participantClaims.map(
          (claim: { reporterId: string }) => claim.reporterId,
        ),
      ),
      new Set([playerId]),
    );
    assert.equal(
      new Set(
        evidence.participantClaims.map(
          (claim: { worldId: string }) => claim.worldId,
        ),
      ).size,
      2,
    );
    assert.equal(prompt.latestUserMessage, message);
    assert.equal(JSON.stringify(prompt).split(message).length, 2);
    assert.doesNotMatch(JSON.stringify(prompt), /host-invented|УЛЬТРАМАРИН/iu);

    assert.equal(
      (await f.chat("different-speaker", { anchor: other, sources: [] }))
        .status,
      200,
    );
    const outsiderEvidence = f.prompts.at(-1)!.linkedGameEvidence;
    const outsiderId = "player-" + digest([owner, outsider.uuid]);
    assert.equal(outsiderEvidence.currentUtterance.reporterId, outsiderId);
    assert.deepEqual(outsiderEvidence.conversationRoles.currentPlayer, {
      participantId: outsiderId,
      displayName: outsider.name,
    });
    assert.equal(
      outsiderEvidence.conversationRoles.speakingNpc.participantId,
      f.npcId,
    );
    assert.deepEqual(
      outsiderEvidence.participantClaims.map(
        (claim: { reporterId: string }) => claim.reporterId,
      ),
      [outsiderId],
    );
  } finally {
    f.close();
  }
});

test("linked preview preserves current value for confidence-only revision and excludes hidden baseline", async () => {
  for (const hidden of [false, true]) {
    const f = await fixture({ deltaIntent: "0%" });
    try {
      await f.seedTrust(hidden ? "historical-baseline" : "sad-1");
      if (!hidden)
        f.store.transact(owner, ({ behavior }) => {
          const history = behavior!.history;
          const original = history[0]!;
          history.push(
            {
              ...original,
              npcId: "another-npc",
              reason: "another-holder-canary",
            },
            {
              ...original,
              targetParticipantId: f.npcId,
              reason: "reversed-direction-canary",
            },
          );
        });
      await f.consent(f.first.token, "continuity-consent");
      await f.consent(f.second.token, "continuity-consent");
      const [first, second] = f.list();
      assert(first && second);
      if (hidden)
        f.policy.revoke(
          f.memoryId,
          f.first.binding.hostId,
          "historical-baseline",
        );
      const response = await f.chat("confidence", {
        anchor: first.id,
        sources: [second.id],
      });
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
      const evidence = f.prompts.at(-1)!.linkedGameEvidence;
      const state = f.store.transact(owner, (state) => state.behavior!);
      if (hidden) {
        assert.deepEqual(
          f.prompts[0]!.priorEvidence.map(
            (entry: { eventId: string }) => entry.eventId,
          ).sort(),
          ["podval-2", "sad-1"],
        );
        assert.equal(evidence.proposedRelationships, undefined);
        assert.deepEqual(evidence.relationships, []);
        assert.equal(state.history.length, 1);
      } else {
        const [preview] = evidence.proposedRelationships;
        assert.deepEqual(
          evidence.relationships.map(
            (change: { subjectNpcId: string; targetParticipantId: string }) => [
              change.subjectNpcId,
              change.targetParticipantId,
            ],
          ),
          [[f.npcId, playerId]],
        );
        assert.doesNotMatch(
          JSON.stringify(evidence),
          /another-holder-canary|reversed-direction-canary/u,
        );
        assert.deepEqual(preview.before, {
          value: 54,
          confidence: 0.7,
          valueRevision: 1,
        });
        assert.deepEqual(preview.proposedAfter, { value: 54, confidence: 0.4 });
        assert.equal(preview.stateRevision, 1);
        assert.equal(preview.proposedStateRevision, 2);
        assert.deepEqual(preview.baselineEvidenceEventIds, ["sad-1"]);
        assert.equal(preview.status, "uncommitted");
        assert.equal(preview.subjectNpcId, f.npcId);
        assert.equal(preview.targetParticipantId, playerId);
        assert.equal(state.history.at(-1)!.before, 54);
        assert.equal(state.history.at(-1)!.after, 54);
        assert.equal(state.history.at(-1)!.confidence, 0.4);
      }
    } finally {
      f.close();
    }
  }
});

test("linked transition preview uses Core rounding for fractional deltas", async () => {
  const f = await fixture();
  try {
    await f.seedTrust();
    const inspection = createBehaviorRuntime(f.store).inspect(
      { principalId: owner, hostId: f.first.binding.hostId },
      "session-" + f.first.binding.connectionId,
      f.npcId,
    );
    const projected = projectLinkedRelationshipTransition(
      inspection,
      {
        parameterId: "trust",
        targetParticipantId: playerId,
        delta: 0.333333392,
        confidence: 0.75,
        evidenceEventIds: ["sad-1"],
      },
      "p1",
      playerId,
      new Set(["trust"]),
      new Set(["sad-1"]),
    );
    assert.equal(projected?.proposedAfter.value, 54.333333);
  } finally {
    f.close();
  }
});

test("linked recall validates source-type refs and rejected content cannot update memory or relationships", async () => {
  for (const recallMode of [
    "supported",
    "bypass-attempt",
    "forged",
    "wrong-source",
    "insufficient",
    "pruned",
    "revoked",
  ] as const) {
    const f = await fixture({ recallMode });
    try {
      if (recallMode === "pruned") await f.reportLookalikes();
      if (recallMode === "revoked")
        f.policy.revoke(f.memoryId, f.first.binding.hostId, "sad-1");
      const original = f.originalBytes();
      await f.consent(f.first.token, "continuity-consent");
      await f.consent(f.second.token, "continuity-consent");
      const [first, second] = f.list();
      assert(first && second);
      const response = await f.chat("fixed-recall", {
        anchor: first.id,
        sources: [second.id],
      });
      const received = await response.json();
      if (recallMode === "supported") {
        assert.equal(response.status, 200);
      } else {
        assert.equal(response.status, 400);
        assert.equal(received.error.code, "insufficient-evidence");
        const state = f.store.transact(owner, (value) =>
          structuredClone(value),
        );
        assert(
          !state.events.some((event) =>
            event.eventId.startsWith("app-linked-output-"),
          ),
        );
        assert(
          state.events.some((event) =>
            event.eventId.startsWith("app-linked-input-"),
          ),
        );
        assert.equal(state.behavior?.history.length, 0);
      }
      assert.doesNotMatch(JSON.stringify(received), /Недостоверный текст/u);
      const offered = f.prompts.at(-1)!.recallEvidence;
      assert(
        offered.some(
          (entry: { ref: string; source: string }) =>
            entry.ref === "event:podval-2" &&
            entry.source === "participant-claim",
        ),
      );
      assert.equal(
        offered.some((entry: { ref: string }) => entry.ref === "event:sad-1"),
        recallMode !== "revoked" && recallMode !== "pruned",
      );
      assert.equal(f.originalBytes(), original);
    } finally {
      f.close();
    }
  }
});
