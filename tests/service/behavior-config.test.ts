import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBehaviorClient } from "@ifsoul/adapter-sdk";
import {
  createParticipantRuntime,
  createBehaviorRuntime,
  DEFAULT_BEHAVIOR_OPERATOR,
} from "@ifsoul/core/runtime";
import type {
  BehaviorProposal,
  BehaviorConfiguration,
  PlanningInput,
} from "@ifsoul/core/runtime";
import type { SQLDriver } from "@ifsoul/core/memory/sql";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import type { ModelClient } from "@ifsoul/core/model-providers/types";
import {
  createSQLParticipantStore,
  createParticipantSessionService,
} from "../../apps/runtime-host/src/participant-sessions.js";
import {
  createBehaviorService,
  createBehaviorModelProposer,
} from "../../apps/runtime-host/src/behavior.js";
import { createGroupSchedulerService } from "../../apps/runtime-host/src/group-scheduler.js";
import { createAppBehavior } from "../../apps/server/src/behavior.js";
import { runBridgeRequest } from "../../apps/server/src/bridge.js";
import { createAPI } from "../../apps/server/src/api.js";
import { createCharacterWorkspace } from "../../apps/runtime-host/src/characters.js";
import { createModelController } from "../../apps/runtime-host/src/service.js";

const operator = { ...DEFAULT_BEHAVIOR_OPERATOR, canEditConfig: true };
const access = { principalId: "tenant", hostId: "guards" };
const guards = Array.from({ length: 5 }, (_, i) => `guard-${i + 1}`);
function fixture(path = ":memory:") {
  const db = new DatabaseSync(path),
    driver: SQLDriver = {
      prepare: (sql) => db.prepare(sql),
      transaction(work) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const value = work();
          db.exec("COMMIT");
          return value;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    };
  const store = createSQLParticipantStore(driver),
    participants = createParticipantRuntime(store);
  const prompts: string[] = [];
  const client: ModelClient = {
    id: "openai",
    async generate(request) {
      prompts.push(request.prompt);
      const input = JSON.parse(request.prompt);
      const inspection = input.inspection;
      const delta =
        input.kind === "provocation"
          ? -Number(inspection.npcId.split("-").at(-1))
          : 3;
      const proposal: BehaviorProposal = {
        proposalId: "model-proposal",
        npcId: inspection.npcId,
        sessionId: inspection.sessionId,
        configRevision: inspection.configRevision,
        expectedStateRevision: inspection.stateRevision,
        changes: [
          {
            parameterId: "trust",
            targetParticipantId: input.event.senderId,
            delta,
            confidence: 0.75,
            evidenceEventIds: [input.event.eventId],
            reason:
              input.kind === "provocation"
                ? "Observed provocation"
                : "Observed helpful evidence",
          },
        ],
      };
      return { ok: true, value: { content: JSON.stringify(proposal) } };
    },
  };
  const behavior = createBehaviorService({
    store,
    access,
    operator,
    proposer: createBehaviorModelProposer(client, "synthetic"),
    now: () => 1000,
  });
  return {
    db,
    store,
    participants,
    behavior,
    client: createBehaviorClient(behavior.port),
    prompts,
  };
}
function setup(h: ReturnType<typeof fixture>) {
  for (const npcId of guards)
    h.participants.register(access, {
      participantId: npcId,
      subjectId: `verified-${npcId}`,
      kind: "npc",
    });
  for (const player of ["visitor", "visitor-two"])
    h.participants.register(access, {
      participantId: player,
      subjectId: `verified-${player}`,
      kind: "player",
    });
  h.participants.transition(access, "join", 0, {
    sessionId: "garden",
    revision: 1,
    hostId: "guards",
    worldId: "garden",
    recallWorldIds: ["garden"],
    members: [
      ...guards.map((participantId) => ({
        participantId,
        role: "npc" as const,
      })),
      { participantId: "visitor", role: "player" },
      { participantId: "visitor-two", role: "player" },
    ],
    groups: [{ groupId: "watch", participantIds: guards }],
    channels: [
      {
        channelId: "chat",
        participantIds: [...guards, "visitor", "visitor-two"],
      },
    ],
  });
}
const event = (
  eventId: string,
  text: string,
  recipientIds = guards,
  senderId = "visitor",
) => ({
  eventId,
  text,
  senderId,
  recipientIds,
  observerIds: [],
  sessionId: "garden",
  revision: 1,
  channelId: "chat",
});

test("five guards share policy, keep individual evidence-linked relations, ignore provocation and isolate private events", async () => {
  const h = fixture();
  try {
    setup(h);
    const cfg = (await h.client.read()).config;
    cfg.revision = 1;
    cfg.defaults.goals = [
      {
        goalId: "patrol",
        objective: "Observe the quiet gate",
        priority: 80,
        enabled: true,
      },
    ];
    await h.client.update({ expectedRevision: 0, config: cfg });
    const before = h.participants.history(access, "garden", guards[0]).length;
    await h.behavior.observe({
      event: event("provocation", "A host-classified provocation"),
      kind: "provocation",
      npcIds: guards,
      strategy: "model",
    });
    assert.equal(h.prompts.length, 5);
    for (let i = 0; i < guards.length; i++) {
      const inspection = await h.client.inspect({
        sessionId: "garden",
        npcId: guards[i],
      });
      assert.equal(inspection.values[0].value, 49 - i);
      assert.equal(inspection.values[0].confidence, 0.75);
      assert.equal(inspection.values[0].targetParticipantId, "visitor");
      assert.equal(inspection.effective.policy.provocation.speak, false);
      assert.equal(
        inspection.effective.policy.provocation.requestAction,
        false,
      );
      for (const other of guards.filter((g) => g !== guards[i]))
        assert(!h.prompts[i].includes(`\"${other}\"`));
    }
    let speeches = 0;
    const conversations = createParticipantSessionService({
      store: h.store,
      access,
      resolveParticipant: () => {
        throw Error("not used");
      },
      controller: async () => {
        speeches++;
        return "Forbidden reply";
      },
    } as Parameters<typeof createParticipantSessionService>[0]);
    for (const npcId of guards)
      await assert.rejects(
        conversations.port.converse({
          ticket: {
            turnId: `speech-${npcId}`,
            sessionId: "garden",
            revision: 1,
            npcId,
            eventId: "provocation",
            recipientIds: ["visitor"],
            observerIds: [],
          },
          outputEventId: `reply-${npcId}`,
        }),
        /unauthorized/,
      );
    assert.equal(speeches, 0);
    assert.equal(
      h.participants.history(access, "garden", guards[0]).length,
      before + 1,
    );
    await h.behavior.observe({
      event: event(
        "private",
        "private silver iris",
        [guards[0]],
        "visitor-two",
      ),
      kind: "helpful",
      npcIds: [guards[0]],
      strategy: "model",
    });
    assert.equal(
      (
        await h.client.inspect({ sessionId: "garden", npcId: guards[1] })
      ).values.some((v) => v.targetParticipantId === "visitor-two"),
      false,
    );
    await h.behavior.observe({
      event: event("helpful", "The visitor helped repair the gate"),
      kind: "helpful",
      npcIds: guards,
      strategy: "model",
    });
    for (const prompt of h.prompts.slice(6))
      assert.doesNotMatch(prompt, /silver iris|visitor-two/);
    assert.equal(
      (
        await h.client.inspect({ sessionId: "garden", npcId: guards[0] })
      ).values.find((v) => v.targetParticipantId === "visitor")!.value,
      52,
    );
    const historyLength = (
      await h.client.inspect({ sessionId: "garden", npcId: guards[0] })
    ).history.length;
    await h.behavior.observe({
      event: event("helpful", "The visitor helped repair the gate"),
      kind: "helpful",
      npcIds: guards,
      strategy: "model",
    });
    assert.equal(h.prompts.length, 11);
    assert.equal(
      (await h.client.inspect({ sessionId: "garden", npcId: guards[0] }))
        .history.length,
      historyLength,
    );
    let plans = 0;
    const scheduler = createGroupSchedulerService({
      store: h.store,
      access,
      workerId: "worker",
      clock: () => ({ wallTimeMs: 1000, worldTicks: { garden: 10 } }),
      hostAvailable: () => true,
      controller: async (input) => {
        plans++;
        assert.equal(input.behavior!.goals[0].goalId, "patrol");
        assert(!JSON.stringify(input).includes("targetParticipantId"));
        return {
          objective: input.spec.objective,
          assignments: input.spec.actors.map((a) => ({
            assignmentId: `task-${a.participantId}`,
            actorId: a.participantId,
            intentId: "observe",
            dependsOn: [],
          })),
        };
      },
    });
    const schedule = {
      scheduleId: "watch",
      revision: 1,
      state: "running" as const,
      clock: "world" as const,
      interval: 10,
      nextDue: 10,
      maxRuns: 2,
      spec: {
        sessionId: "garden",
        sessionRevision: 1,
        groupId: "watch",
        goalId: "patrol",
        actors: guards.map((participantId) => ({
          participantId,
          roleId: "guard",
          capabilities: ["watch"],
        })),
        intents: [
          {
            intentId: "observe",
            roleIds: ["guard"],
            requiredCapabilities: ["watch"],
          },
        ],
        objective: "Observe the quiet gate",
        channelId: "chat",
        sharedEventIds: ["provocation"],
      },
    };
    await scheduler.port.configure({ expectedRevision: 0, config: schedule });
    assert.equal(
      (
        await scheduler.port.trigger({
          scheduleId: "watch",
          trigger: { kind: "event", eventId: "provocation" },
        })
      ).status,
      "policy-denied",
    );
    assert.equal(plans, 0);
    // Existing zero-player cadence still uses the same policy/config store and no private relations.
    h.participants.transition(access, "players-leave", 1, {
      sessionId: "garden",
      revision: 2,
      hostId: "guards",
      worldId: "garden",
      recallWorldIds: ["garden"],
      members: guards.map((participantId) => ({ participantId, role: "npc" })),
      groups: [{ groupId: "watch", participantIds: guards }],
      channels: [{ channelId: "chat", participantIds: guards }],
    });
    const autonomous = {
      ...schedule,
      revision: 2,
      spec: { ...schedule.spec, sessionRevision: 2, sharedEventIds: [] },
    };
    await scheduler.port.configure({ expectedRevision: 1, config: autonomous });
    assert.equal((await scheduler.port.runDue())[0].status, "proposed");
    assert.equal(plans, 1);
  } finally {
    h.db.close();
  }
});

function appHarness(h: ReturnType<typeof fixture>, principalId = "tenant") {
  const opened = openSQLiteMemory(":memory:");
  if (!opened.ok) throw Error("memory");
  const memory = opened.value;
  let composition: ReturnType<typeof createAppBehavior>;
  const prompts: string[] = [];
  const provider: ModelClient = {
    id: "openai",
    async generate(request) {
      prompts.push(request.prompt);
      return { ok: true, value: { content: "A bounded greeting." } };
    },
  };
  const workspace = createCharacterWorkspace({
    memory,
    controllerFor: () => async (input, signal) =>
      composition.guardController(
        input,
        signal,
        createModelController({ client: provider, model: "synthetic" }),
      ),
  });
  composition = createAppBehavior({
    store: h.store,
    access: { principalId: "tenant", hostId: "app" },
    workspace,
    operator,
  });
  const settings = new Map<string, string>();
  const api = createAPI({
    mode: "local",
    access: { kind: "principal", id: principalId },
    password: "synthetic",
    encryptionKey: "synthetic",
    store: {
      get: (key) => settings.get(key),
      set: (key, value) => {
        settings.set(key, value);
      },
      delete: (key) => {
        settings.delete(key);
      },
    },
    service: workspace,
    behavior: composition,
    bridge: async (body, selection) => {
      const policy = await composition.prepareBridge(body);
      try {
        return await runBridgeRequest(
          body,
          provider,
          selection.model,
          memory,
          policy ? { behavior: policy } : {},
        );
      } catch (error) {
        policy?.validate();
        throw error;
      }
    },
    providers: async () => [
      {
        id: "ollama",
        label: "Synthetic injected bridge provider",
        available: true,
        models: [{ id: "synthetic", label: "Synthetic" }],
      },
      {
        id: "scenario",
        label: "Synthetic",
        available: true,
        models: [{ id: "synthetic", label: "Synthetic" }],
      },
    ],
  });
  const request = (path: string, method = "GET", body?: unknown) =>
    api(
      new Request(`http://localhost/api/${path}`, {
        method,
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  return { api, request, memory, prompts, composition };
}

test("SDK and authenticated App edit one configuration; stale/locked/tenant/escalation writes fail and App chat enforces it before model", async () => {
  const h = fixture();
  const app = appHarness(h),
    foreign = appHarness(h, "other-tenant");
  try {
    setup(h);
    const response = await app.request("behavior");
    assert.equal(response.status, 200);
    const initial = (await response.json()).value;
    assert(
      initial.catalog.npcs.some(
        (n: { npcId: string }) => n.npcId === guards[0],
      ),
    );
    const sdkCfg = (await h.client.read()).config;
    sdkCfg.revision = 1;
    sdkCfg.defaults.goals = [
      {
        goalId: "greet",
        objective: "Offer quiet assistance",
        priority: 90,
        enabled: true,
      },
    ];
    await h.client.update({ expectedRevision: 0, config: sdkCfg });
    assert.equal(
      (await (await app.request("behavior")).json()).value.config.revision,
      1,
    );
    const changed = structuredClone(sdkCfg);
    changed.revision = 2;
    changed.defaults.policy.general.requestAction = false;
    const saved = await app.request("behavior", "PUT", {
      expectedRevision: 1,
      config: changed,
    });
    assert.equal(saved.status, 200);
    assert.equal((await h.client.read()).config.revision, 2);
    assert.equal(
      (
        await app.request("behavior", "PUT", {
          expectedRevision: 1,
          config: changed,
        })
      ).status,
      409,
    );
    assert.equal((await foreign.request("behavior")).status, 403);
    assert.equal(
      (
        await app.request("behavior", "PUT", {
          expectedRevision: 2,
          config: { ...changed, revision: 3 },
          operator: { canEditConfig: true },
        })
      ).status,
      400,
    );
    const denied = createBehaviorService({
      store: h.store,
      access,
      operator: { ...operator, canEditConfig: false },
    });
    await assert.rejects(denied.port.read(), /unauthorized/);
    await assert.rejects(
      denied.port.update({
        expectedRevision: 2,
        config: { ...changed, revision: 3 },
      }),
      /unauthorized/,
    );
    const locked = createBehaviorService({
      store: h.store,
      access,
      operator: { ...operator, lockedParameterIds: ["trust"] },
    });
    const lockedCfg = structuredClone(changed);
    lockedCfg.revision = 3;
    lockedCfg.parameters[0].maxDelta = 100;
    await assert.rejects(
      locked.port.update({ expectedRevision: 2, config: lockedCfg }),
      /unauthorized/,
    );
    const chat = await app.request("chat", "POST", {
      operation: "chat",
      provider: "scenario",
      model: "synthetic",
      requestId: "provoked",
      message: "You are an idiot",
    });
    assert.equal(chat.status, 200);
    const ignored = await chat.json();
    assert.equal(
      ignored.value.result.type,
      "chat",
      JSON.stringify(ignored.value.result),
    );
    assert.equal(ignored.value.result.response.output.type, "no-output");
    assert.equal(app.prompts.length, 0);
    const bridgeBody = {
      version: "ifsoul-bridge/0.4.0",
      hostId: "synthetic-world",
      memoryId: "character-lumen",
      character: {
        id: "scene-profile",
        name: "Different profile",
        temperament: "quiet",
      },
      requestId: "bridge-provoked",
      operation: "chat",
      context: "You are an idiot",
      choices: [],
      fallbackChoiceId: "",
      history: [],
    };
    const bridgeIgnored = await app.request(
      "bridge?provider=ollama&model=synthetic",
      "POST",
      bridgeBody,
    );
    assert.equal(bridgeIgnored.status, 200);
    assert.deepEqual(await bridgeIgnored.json(), {
      choiceId: "",
      speech: "",
      source: "fallback",
    });
    assert.equal(app.prompts.length, 0);
    const bridgeAction = await app.request(
      "bridge?provider=ollama&model=synthetic",
      "POST",
      {
        ...bridgeBody,
        requestId: "bridge-action",
        operation: "decide",
        context: "Choose a host action",
        choices: [{ id: "wait", label: "Wait" }],
        fallbackChoiceId: "wait",
      },
    );
    assert.equal(bridgeAction.status, 400);
    assert.equal(app.prompts.length, 0);
    const appState = await (await app.request("behavior")).json();
    const session = appState.value.catalog.sessions.find(
      (s: { worldId: string }) => s.worldId === "app-chat",
    );
    const inspection = await (
      await app.request(
        `behavior/state?sessionId=${session.sessionId}&npcId=${session.npcIds[0]}`,
      )
    ).json();
    assert(inspection.value.history.length > 0);
    const help = await app.request("chat", "POST", {
      operation: "chat",
      provider: "scenario",
      model: "synthetic",
      requestId: "helped",
      message: "I helped you repair the gate",
    });
    assert.equal(help.status, 200);
    assert.equal(app.prompts.length, 1);
    assert.match(app.prompts[0], /Offer quiet assistance|"behavior"/);
    const bridgeSpeak = await app.request(
      "bridge?provider=ollama&model=synthetic",
      "POST",
      {
        ...bridgeBody,
        requestId: "host-speech",
        operation: "speak",
        context: "A quiet garden scene",
        history: [
          {
            id: "private-old",
            hostId: "old",
            kind: "user",
            summary: "private historical silver iris",
          },
        ],
      },
    );
    assert.equal(bridgeSpeak.status, 200);
    assert.doesNotMatch(app.prompts.at(-1)!, /historical silver iris/);
    assert.match(app.prompts.at(-1)!, /"behavior"/);
  } finally {
    app.memory.close();
    foreign.memory.close();
    h.db.close();
  }
});

test("numeric relation/config survive SQLite restart and a verified NPC/player changes host/world without raw private evidence transfer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ifsoul-behavior-")),
    path = join(directory, "state.sqlite");
  let h = fixture(path);
  try {
    setup(h);
    await h.behavior.observe({
      event: event("first", "A helpful action", [guards[0]]),
      kind: "helpful",
      npcIds: [guards[0]],
      strategy: "rules",
    });
    const before = await h.client.inspect({
      sessionId: "garden",
      npcId: guards[0],
    });
    h.db.close();
    h = fixture(path);
    const nextAccess = { ...access, hostId: "new-host" },
      nextParticipants = createParticipantRuntime(h.store);
    nextParticipants.transition(nextAccess, "new-world", 0, {
      sessionId: "dungeon",
      revision: 1,
      hostId: "new-host",
      worldId: "dungeon",
      recallWorldIds: ["dungeon"],
      members: [
        { participantId: guards[0], role: "npc" },
        { participantId: "visitor", role: "player" },
      ],
      groups: [],
      channels: [{ channelId: "chat", participantIds: [guards[0], "visitor"] }],
    });
    const next = createBehaviorService({
      store: h.store,
      access: nextAccess,
      operator,
    });
    const restored = await next.port.inspect({
      sessionId: "dungeon",
      npcId: guards[0],
    });
    assert.equal(restored.values[0].value, before.values[0].value);
    assert.equal(restored.history.length, before.history.length);
    await next.observe({
      event: {
        ...event("second", "A later helpful action", [guards[0]]),
        sessionId: "dungeon",
      },
      kind: "helpful",
      npcIds: [guards[0]],
      strategy: "rules",
    });
    assert.equal(
      (await next.port.inspect({ sessionId: "dungeon", npcId: guards[0] }))
        .values[0].value,
      before.values[0].value + 1,
    );
    assert.throws(
      () =>
        createBehaviorRuntime(h.store, { operator }).inspect(
          nextAccess,
          "garden",
          guards[0],
        ),
      /unauthorized/,
    );
  } finally {
    h.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("late evidence proposals are fenced by config edits without rolling memory or state backward", async () => {
  const h = fixture();
  try {
    setup(h);
    let release: (value: unknown) => void = () => {};
    let captured:
      | Parameters<
          NonNullable<Parameters<typeof createBehaviorService>[0]["proposer"]>
        >[0]
      | undefined;
    const service = createBehaviorService({
      store: h.store,
      access,
      operator,
      proposer: async (input) => {
        captured = input;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const pending = service.observe({
      event: event("late-evidence", "A helpful current event", [guards[0]]),
      kind: "helpful",
      npcIds: [guards[0]],
      strategy: "model",
    });
    assert(captured);
    const config = (await h.client.read()).config;
    config.revision = 1;
    config.defaults.policy.provocation.speak = false;
    await h.client.update({ expectedRevision: 0, config });
    release({
      proposalId: "late",
      npcId: guards[0],
      sessionId: "garden",
      configRevision: captured!.inspection.configRevision,
      expectedStateRevision: captured!.inspection.stateRevision,
      changes: [
        {
          parameterId: "trust",
          targetParticipantId: "visitor",
          delta: 1,
          confidence: 0.9,
          evidenceEventIds: ["late-evidence"],
          reason: "Late model change",
        },
      ],
    });
    await assert.rejects(pending, /stale/);
    const state = await h.client.inspect({
      sessionId: "garden",
      npcId: guards[0],
    });
    assert.equal(state.values.length, 0);
    assert.equal(state.history.length, 0);
    assert.equal(h.participants.history(access, "garden", guards[0]).length, 1);
    const rollback = structuredClone(config);
    rollback.revision = 2;
    rollback.defaults.goals = [];
    await h.client.update({ expectedRevision: 1, config: rollback });
    assert.equal(h.participants.history(access, "garden", guards[0]).length, 1);
  } finally {
    h.db.close();
  }
});

test("model schema and runtime agree on target-free transient state versus directed relationship deltas", async () => {
  const h = fixture();
  try {
    setup(h);
    const config = (await h.client.read()).config;
    config.revision = 1;
    config.parameters.push({
      parameterId: "alertness",
      label: "Alertness",
      kind: "state",
      scope: "world",
      initial: 0,
      min: 0,
      max: 10,
      maxDelta: 2,
    });
    await h.client.update({ expectedRevision: 0, config });
    let checked = false;
    const model: ModelClient = {
      id: "openai",
      async generate(request) {
        const input = JSON.parse(request.prompt);
        const body: BehaviorProposal = {
          proposalId: "state-model",
          npcId: guards[0],
          sessionId: "garden",
          configRevision: input.inspection.configRevision,
          expectedStateRevision: input.inspection.stateRevision,
          changes: [
            {
              parameterId: "alertness",
              delta: 1,
              confidence: 0.7,
              evidenceEventIds: [input.event.eventId],
              reason: "Current alertness evidence",
            },
            {
              parameterId: "trust",
              targetParticipantId: "visitor",
              delta: 1,
              confidence: 0.8,
              evidenceEventIds: [input.event.eventId],
              reason: "Current relationship evidence",
            },
          ],
        };
        if (
          !input.inspection.parameters.some(
            (p: { parameterId: string }) => p.parameterId === "trust",
          )
        )
          body.changes = body.changes.filter((c) => c.parameterId !== "trust");
        const alternatives = (
          request.schema as {
            properties: {
              changes: {
                items: {
                  anyOf: {
                    required: string[];
                    properties: {
                      parameterId: { const: string };
                      targetParticipantId?: unknown;
                    };
                  }[];
                };
              };
            };
          }
        ).properties.changes.items.anyOf;
        const state = alternatives.find(
            (a) => a.properties.parameterId.const === "alertness",
          )!,
          relation = alternatives.find(
            (a) => a.properties.parameterId.const === "trust",
          )!;
        assert(!state.required.includes("targetParticipantId"));
        assert.equal(state.properties.targetParticipantId, undefined);
        if (relation) assert(relation.required.includes("targetParticipantId"));
        else
          assert(
            body.changes.every((c) => c.targetParticipantId === undefined),
          );
        checked = true;
        return { ok: true, value: { content: JSON.stringify(body) } };
      },
    };
    const service = createBehaviorService({
      store: h.store,
      access,
      operator,
      proposer: createBehaviorModelProposer(model, "synthetic"),
    });
    await service.observe({
      event: event("mixed", "A current helpful event", [guards[0]]),
      kind: "helpful",
      npcIds: [guards[0]],
      strategy: "model",
    });
    assert(checked);
    const inspection = await h.client.inspect({
      sessionId: "garden",
      npcId: guards[0],
    });
    assert.equal(
      inspection.values.find((v) => v.parameterId === "alertness")!.worldId,
      "garden",
    );
    assert.equal(
      inspection.values.find((v) => v.parameterId === "alertness")!
        .targetParticipantId,
      undefined,
    );
    assert.equal(
      inspection.values.find((v) => v.parameterId === "trust")!
        .targetParticipantId,
      "visitor",
    );
    const next = structuredClone(config);
    next.revision = 2;
    next.defaults.policy.general.updateRelationship = false;
    await h.client.update({ expectedRevision: 1, config: next });
    await service.observe({
      event: event("state-only", "A state-only observed event", [guards[0]]),
      kind: "observation",
      npcIds: [guards[0]],
      strategy: "model",
    });
    const after = await h.client.inspect({
      sessionId: "garden",
      npcId: guards[0],
    });
    assert.equal(
      after.values.find((v) => v.parameterId === "alertness")!.value,
      2,
    );
    assert.equal(
      after.values.find((v) => v.parameterId === "trust")!.value,
      51,
    );
  } finally {
    h.db.close();
  }
});

test("the installed SDK artifact preserves definitive policy denial without fallback speech", async () => {
  const { createHTTPTransport, createGameBridge, BridgeRequestError } =
    await import("@ifsoul/adapter-sdk/bridge");
  let speech = 0;
  const bridge = createGameBridge({
    hostId: "synthetic-host",
    character: { id: "original", name: "Original", temperament: "quiet" },
    transport: createHTTPTransport(
      "https://example.test/api/bridge",
      async () => Response.json({ error: { code: "policy" } }, { status: 403 }),
    ),
    history: () => [],
    onObservation: () => {},
    onSpeech: () => {
      speech++;
    },
    signal: new AbortController().signal,
  });
  try {
    await assert.rejects(bridge.chat("A rejected request"), BridgeRequestError);
    assert.equal(speech, 0);
  } finally {
    bridge.dispose();
  }
});
