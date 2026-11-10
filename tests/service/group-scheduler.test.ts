import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSchedulerClient } from "@ifsoul/adapter-sdk";
import {
  createParticipantRuntime,
  createGroupSchedulerRuntime,
} from "@ifsoul/core/runtime";
import type {
  PlanningInput,
  GroupPlan,
  PlanSchedule,
  ParticipantSession,
  PlanningClock,
  PlanningBudgets,
} from "@ifsoul/core/runtime";
import type { SQLDriver } from "@ifsoul/core/memory/sql";
import type { ModelClient } from "@ifsoul/core/model-providers/types";
import { createSQLParticipantStore } from "../../apps/runtime-host/src/participant-sessions.js";
import {
  createGroupSchedulerService,
  startGroupSchedulerRunner,
} from "../../apps/runtime-host/src/group-scheduler.js";

const access = { principalId: "owner", hostId: "host" };
const session: ParticipantSession = {
  sessionId: "s",
  revision: 1,
  worldId: "orchard",
  hostId: "host",
  recallWorldIds: ["orchard"],
  members: [
    { participantId: "a", role: "npc" },
    { participantId: "b", role: "npc" },
  ],
  groups: [{ groupId: "party", participantIds: ["a", "b"] }],
  channels: [{ channelId: "chat", participantIds: ["a", "b"] }],
};
const config = (scheduleId = "group", solo = false): PlanSchedule => ({
  scheduleId,
  revision: 1,
  state: "running",
  clock: "world",
  interval: 10,
  nextDue: 10,
  maxRuns: 8,
  spec: {
    sessionId: "s",
    sessionRevision: 1,
    ...(!solo ? { groupId: "party" } : {}),
    actors: (solo ? ["a"] : ["a", "b"]).map((participantId) => ({
      participantId,
      roleId: "grower",
      capabilities: ["observe"],
    })),
    intents: [
      {
        intentId: "survey",
        roleIds: ["grower"],
        requiredCapabilities: ["observe"],
      },
    ],
    objective: solo ? "Inspect one tree" : "Inspect the orchard together",
    channelId: "chat",
    sharedEventIds: solo ? [] : ["shared"],
  },
});
const proposed = (input: PlanningInput): GroupPlan => ({
  objective: input.spec.objective,
  assignments: input.spec.actors.map((a, i) => ({
    assignmentId: `assignment-${a.participantId}`,
    actorId: a.participantId,
    intentId: "survey",
    dependsOn: i
      ? [`assignment-${input.spec.actors[i - 1].participantId}`]
      : [],
  })),
});
function fixture(
  options: {
    path?: string;
    workerId?: string;
    time?: PlanningClock;
    budget?: number;
    concurrency?: number;
    budgetCeilings?: Partial<PlanningBudgets>;
    generate?: (input: PlanningInput) => Promise<unknown>;
  } = {},
) {
  const db = new DatabaseSync(options.path ?? ":memory:");
  const driver: SQLDriver = {
    prepare: (sql) => db.prepare(sql),
    transaction(work) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const store = createSQLParticipantStore(driver),
    participants = createParticipantRuntime(store);
  const time = options.time ?? { wallTimeMs: 100, worldTicks: { orchard: 10 } };
  let online = true;
  const prompts: string[] = [];
  const provider: ModelClient = {
    id: "openai",
    async generate(request) {
      prompts.push(request.prompt);
      return {
        ok: true,
        value: options.generate
          ? await options.generate(JSON.parse(request.prompt))
          : proposed(JSON.parse(request.prompt)),
      };
    },
  };
  const scheduler = createGroupSchedulerService({
    store,
    access,
    workerId: options.workerId ?? "worker-a",
    clock: () => structuredClone(time),
    hostAvailable: () => online,
    budgets: {
      principalCalls: options.budget ?? 64,
      ...(options.concurrency ? { concurrentPlans: options.concurrency } : {}),
    },
    budgetCeilings: options.budgetCeilings,
    controller: async (input, signal) => {
      const output = await provider.generate({
        model: "synthetic",
        system:
          "Propose only allowed high-level assignments; no speech or execution.",
        prompt: JSON.stringify(input),
        schema: {},
        signal,
      });
      if (!output.ok) throw Error("synthetic provider failed");
      return output.value;
    },
  });
  return {
    db,
    store,
    participants,
    scheduler,
    client: createSchedulerClient(scheduler.port),
    time,
    prompts,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}
function setup(h: ReturnType<typeof fixture>) {
  for (const participantId of ["a", "b"])
    h.participants.register(access, {
      participantId,
      subjectId: `verified-${participantId}`,
      kind: "npc",
    });
  h.participants.transition(access, "join", 0, session);
  h.participants.append(access, {
    eventId: "secret",
    sessionId: "s",
    revision: 1,
    channelId: "chat",
    senderId: "a",
    recipientIds: [],
    observerIds: [],
    text: "private silver iris",
  });
  h.participants.append(access, {
    eventId: "shared",
    sessionId: "s",
    revision: 1,
    channelId: "chat",
    senderId: "a",
    recipientIds: ["b"],
    observerIds: [],
    text: "The orchard gate is open",
  });
}
async function settle(
  h: ReturnType<typeof fixture>,
  claimId: string,
  assignmentIds: string[],
) {
  await h.client.report({
    reportId: `adopt-${claimId}`,
    claimId,
    status: "adopted",
    assignmentIds,
    summary: "Host accepted the declared assignments",
  });
  return h.client.report({
    reportId: `complete-${claimId}`,
    claimId,
    status: "completed",
    assignmentIds,
    summary: "Host reports the accepted survey completed",
  });
}

test("zero-player solo/group due planning uses shared model input, coalesces ticks and charges hard budgets without speech/effects", async () => {
  const h = fixture({ budget: 2 });
  try {
    setup(h);
    await h.client.configure({
      expectedRevision: 0,
      config: config("solo", true),
    });
    h.time.wallTimeMs = 10000;
    h.time.worldTicks.orchard = 9;
    assert.equal((await h.client.runDue())[0].status, "not-due");
    assert.equal(h.prompts.length, 0);
    h.setOnline(false);
    h.time.worldTicks.orchard = 100;
    assert.equal((await h.client.runDue())[0].status, "host-unavailable");
    assert.equal(
      (await h.client.inspect({ scheduleId: "solo" })).cursor.runs,
      0,
    );
    h.setOnline(true);
    const solo = (await h.client.runDue())[0];
    assert.equal(solo.status, "proposed");
    if (solo.status !== "proposed") throw Error("solo proposal missing");
    assert.equal(solo.claim.plan!.assignments.length, 1);
    assert.equal(
      (await h.client.inspect({ scheduleId: "solo" })).config.nextDue,
      110,
    );
    await h.client.report({
      reportId: "decline-solo",
      claimId: solo.claim.claimId,
      status: "rejected",
      assignmentIds: [],
      summary: "Host declines optional work",
    });
    const groupConfig = config();
    groupConfig.nextDue = 100;
    await h.client.configure({ expectedRevision: 0, config: groupConfig });
    const group = (await h.client.runDue()).find(
      (x) => x.status === "proposed",
    );
    assert(group && group.status === "proposed");
    assert.equal(group.claim.plan!.assignments.length, 2);
    assert.doesNotMatch(h.prompts[1], /silver iris/);
    assert.match(h.prompts[1], /orchard gate/);
    assert.equal("speech" in group.claim.plan!, false);
    assert.equal(h.participants.history(access, "s", "a").length, 2);
    assert.equal(
      (await h.client.inspect({ scheduleId: "group" })).reports.length,
      0,
    );
    await assert.rejects(
      h.client.report({
        reportId: "fake",
        claimId: group.claim.claimId,
        status: "completed",
        assignmentIds: ["assignment-a", "assignment-b"],
        summary: "No host adoption",
      }),
      /conflict/,
    );
    await settle(h, group.claim.claimId, ["assignment-a", "assignment-b"]);
    h.time.worldTicks.orchard = 110;
    assert((await h.client.runDue()).every((x) => x.status === "budget"));
    assert.equal(h.prompts.length, 2);
    assert.equal(h.participants.history(access, "s", "a").length, 2);
  } finally {
    h.db.close();
  }
});

test("two workers, pause/resume/cancel and SQLite reopen keep claims fenced and host reports idempotent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ifsoul-scheduler-")),
    path = join(directory, "synthetic.sqlite");
  let release: (value: unknown) => void = () => {};
  const time = { wallTimeMs: 100, worldTicks: { orchard: 10 } };
  const first = fixture({
    path,
    time,
    generate: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  let second: ReturnType<typeof fixture> | undefined;
  try {
    setup(first);
    await first.client.configure({ expectedRevision: 0, config: config() });
    const pending = first.client.runDue();
    second = fixture({ path, time, workerId: "worker-b" });
    time.worldTicks.orchard = 20;
    assert.equal((await second.client.runDue())[0].status, "busy");
    assert.equal(second.prompts.length, 0);
    assert.throws(
      () =>
        second!.participants.begin(access, {
          turnId: "conversation",
          sessionId: "s",
          revision: 1,
          npcId: "a",
          eventId: "secret",
          recipientIds: [],
          observerIds: [],
        }),
      /busy/,
    );
    const paused = await second.client.control({
      scheduleId: "group",
      expectedRevision: 1,
      action: "pause",
    });
    assert.equal(paused.revision, 2);
    release(proposed(JSON.parse(first.prompts[0])));
    assert.equal((await pending)[0].status, "stale");
    assert.equal(
      (await second.client.inspect({ scheduleId: "group" })).claims[0].plan,
      undefined,
    );
    assert.deepEqual(await second.client.runDue(), []);
    await second.client.control({
      scheduleId: "group",
      expectedRevision: 2,
      action: "resume",
    });
    const proposal = (await second.client.runDue())[0];
    assert.equal(proposal.status, "proposed");
    if (proposal.status !== "proposed") throw Error("proposal");
    second.db.close();
    second = fixture({ path, time, workerId: "worker-reopened" });
    time.worldTicks.orchard = 30;
    assert.equal((await second.client.runDue())[0].status, "busy");
    assert.equal(second.prompts.length, 0);
    await settle(second, proposal.claim.claimId, [
      "assignment-a",
      "assignment-b",
    ]);
    await second.client.report({
      reportId: `complete-${proposal.claim.claimId}`,
      claimId: proposal.claim.claimId,
      status: "completed",
      assignmentIds: ["assignment-a", "assignment-b"],
      summary: "Host reports the accepted survey completed",
    });
    assert.equal(
      (await second.client.inspect({ scheduleId: "group" })).reports.length,
      2,
    );
    await second.client.control({
      scheduleId: "group",
      expectedRevision: 3,
      action: "cancel",
    });
    time.worldTicks.orchard = 100;
    assert.deepEqual(await second.client.runDue(), []);
    assert.equal(second.prompts.length, 0);
    await assert.rejects(
      second.client.control({
        scheduleId: "group",
        expectedRevision: 4,
        action: "resume",
      }),
      /conflict/,
    );
  } finally {
    first.db.close();
    second?.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("crash/reopen expires wall leases without advancing world time or blindly retrying an unknown model call", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ifsoul-scheduler-crash-")),
    path = join(directory, "synthetic.sqlite");
  const time = { wallTimeMs: 100, worldTicks: { orchard: 10 } };
  let h = fixture({ path, time });
  try {
    setup(h);
    await h.client.configure({ expectedRevision: 0, config: config() });
    const runtime = createGroupSchedulerRuntime(h.store);
    const claim = runtime.claim(
      access,
      "group",
      { kind: "due" },
      time,
      "crashed-worker",
      10,
      true,
    ) as PlanningInput;
    h.db.close();
    h = fixture({ path, time, workerId: "new-worker" });
    time.wallTimeMs = 1000;
    assert.equal((await h.client.runDue())[0].status, "not-due");
    assert.equal(
      (await h.client.inspect({ scheduleId: "group" })).claims[0].status,
      "unknown",
    );
    assert.equal(h.prompts.length, 0);
    time.worldTicks.orchard = 20;
    assert.equal((await h.client.runDue())[0].status, "unknown");
    assert.equal(h.prompts.length, 0);
    assert.throws(
      () =>
        createGroupSchedulerRuntime(h.store).complete(
          access,
          claim.claim,
          proposed(claim),
          time,
        ),
      /stale/,
    );
    await h.client.reconcile({ claimId: claim.claim.claimId });
    const next = (await h.client.runDue())[0];
    assert.equal(next.status, "proposed");
    assert.equal(h.prompts.length, 1);
  } finally {
    h.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("membership changes fence in-flight plans and one invalid assignment cannot yield partial action authority", async () => {
  let release: (value: unknown) => void = () => {};
  let invalid = false;
  const h = fixture({
    generate: (input) =>
      invalid
        ? Promise.resolve({
            ...proposed(input),
            assignments: [
              ...proposed(input).assignments,
              {
                assignmentId: "bad",
                actorId: "b",
                intentId: "ungranted-combat",
                dependsOn: [],
              },
            ],
          })
        : new Promise((resolve) => {
            release = resolve;
          }),
  });
  try {
    setup(h);
    await h.client.configure({ expectedRevision: 0, config: config() });
    const pending = h.client.runDue();
    h.participants.transition(access, "leave", 1, {
      ...session,
      revision: 2,
      members: [{ participantId: "a", role: "npc" }],
      groups: [{ groupId: "party", participantIds: ["a"] }],
      channels: [{ channelId: "chat", participantIds: ["a"] }],
    });
    release(proposed(JSON.parse(h.prompts[0])));
    assert.equal((await pending)[0].status, "stale");
    const updated = config("group", true);
    updated.revision = 2;
    updated.spec.sessionRevision = 2;
    updated.nextDue = 20;
    await h.client.configure({ expectedRevision: 1, config: updated });
    h.time.worldTicks.orchard = 20;
    invalid = true;
    assert.equal((await h.client.runDue())[0].status, "failed");
    const inspection = await h.client.inspect({ scheduleId: "group" });
    assert.equal(inspection.claims[1].plan, undefined);
    assert.equal(inspection.calls, 2);
    assert.equal(h.participants.history(access, "s", "a").length, 2);
  } finally {
    h.db.close();
  }
});

test("owned pulse runner plans without player calls and stops its own work", async () => {
  const h = fixture();
  let runner: ReturnType<typeof startGroupSchedulerRunner> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    setup(h);
    await h.client.configure({
      expectedRevision: 0,
      config: config("solo", true),
    });
    const result = await new Promise<unknown>((resolve, reject) => {
      deadline = setTimeout(() => reject(Error("runner deadline")), 2000);
      runner = startGroupSchedulerRunner(h.scheduler, {
        pulseMs: 10,
        onResult: (results) => {
          if (results.some((x) => x.status === "proposed")) resolve(results);
        },
        onError: () => reject(Error("runner failed")),
      });
    });
    assert(result);
    assert.equal(h.prompts.length, 1);
    await runner!.stop();
    runner = undefined;
    assert.equal(
      (await h.client.inspect({ scheduleId: "solo" })).claims.length,
      1,
    );
  } finally {
    if (deadline) clearTimeout(deadline);
    await runner?.stop();
    h.db.close();
  }
});

test("event/manual triggers share wall-clock cooldown and duplicate IDs cannot create a chatter loop", async () => {
  const h = fixture();
  try {
    setup(h);
    const wall = config();
    wall.clock = "wall";
    wall.nextDue = 100;
    await h.client.configure({ expectedRevision: 0, config: wall });
    await assert.rejects(
      h.client.trigger({
        scheduleId: "group",
        trigger: { kind: "event", eventId: "secret" },
      }),
      /unauthorized/,
    );
    assert.equal(h.prompts.length, 0);
    const event = await h.client.trigger({
      scheduleId: "group",
      trigger: { kind: "event", eventId: "shared" },
    });
    assert.equal(event.status, "proposed");
    if (event.status !== "proposed") throw Error("proposal");
    await h.client.report({
      reportId: "decline-event",
      claimId: event.claim.claimId,
      status: "rejected",
      assignmentIds: [],
      summary: "Host declines optional work",
    });
    assert.equal(
      (
        await h.client.trigger({
          scheduleId: "group",
          trigger: { kind: "event", eventId: "shared" },
        })
      ).status,
      "replay",
    );
    h.time.worldTicks.orchard = 1000;
    assert.equal(
      (
        await h.client.trigger({
          scheduleId: "group",
          trigger: { kind: "manual", triggerId: "manual" },
        })
      ).status,
      "not-due",
    );
    h.time.wallTimeMs = 110;
    assert.equal(
      (
        await h.client.trigger({
          scheduleId: "group",
          trigger: { kind: "manual", triggerId: "manual" },
        })
      ).status,
      "proposed",
    );
    assert.equal(h.prompts.length, 2);
    assert.equal(h.participants.history(access, "s", "a").length, 2);
  } finally {
    h.db.close();
  }
});

test("trusted App ceilings permit two independent NPC proposals, never request/model capacity overrides", async () => {
  const h = fixture({
    budget: 65,
    concurrency: 2,
    budgetCeilings: { principalCalls: 65, concurrentPlans: 2 },
  });
  try {
    setup(h);
    const a = config("solo-a", true),
      b = config("solo-b", true);
    b.spec.actors = [
      { participantId: "b", roleId: "grower", capabilities: ["observe"] },
    ];
    await assert.rejects(
      h.client.configure({
        expectedRevision: 0,
        config: { ...a, budgets: { principalCalls: 1000 } } as PlanSchedule,
      }),
      /invalid/,
    );
    await h.client.configure({ expectedRevision: 0, config: a });
    await h.client.configure({ expectedRevision: 0, config: b });
    assert.equal((await h.client.runDue())[0].status, "proposed");
    assert((await h.client.runDue()).some((r) => r.status === "proposed"));
    assert.equal(h.prompts.length, 2);
    assert.equal(
      (await h.client.inspect({ scheduleId: "solo-a" })).claims[0].actorIds[0],
      "a",
    );
    assert.equal(
      (await h.client.inspect({ scheduleId: "solo-b" })).claims[0].actorIds[0],
      "b",
    );
  } finally {
    h.db.close();
  }
});
