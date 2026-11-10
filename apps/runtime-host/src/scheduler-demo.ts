/** Autonomous synthetic host: pass NPC count 1 or 2; there are no player members. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createSchedulerClient } from "@ifsoul/adapter-sdk";
import { createParticipantRuntime } from "@ifsoul/core/runtime";
import type {
  PlanSchedule,
  GroupPlan,
  PlanningInput,
} from "@ifsoul/core/runtime";
import type { SQLDriver } from "@ifsoul/core/memory/sql";
import { createSQLParticipantStore } from "./participant-sessions.js";
import {
  createGroupSchedulerService,
  startGroupSchedulerRunner,
} from "./group-scheduler.js";

const count = Number(process.argv[2] ?? 2);
if (![1, 2].includes(count)) throw new RangeError("Choose 1 or 2 NPCs");
const npcIds = ["npc-a", "npc-b"].slice(0, count);
const db = new DatabaseSync(":memory:");
let runner: ReturnType<typeof startGroupSchedulerRunner> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  const driver: SQLDriver = {
    prepare: (sql) => db.prepare(sql),
    transaction(work) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const output = work();
        db.exec("COMMIT");
        return output;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const store = createSQLParticipantStore(driver);
  const participants = createParticipantRuntime(store);
  // A real host resolves authenticated subjects through its own trusted directory.
  const access = { principalId: "synthetic-owner", hostId: "orchard-host" };
  for (const npcId of npcIds)
    participants.register(access, {
      participantId: npcId,
      subjectId: `verified-${npcId}`,
      kind: "npc",
    });
  participants.transition(access, "join", 0, {
    sessionId: "orchard-session",
    revision: 1,
    hostId: access.hostId,
    worldId: "orchard",
    recallWorldIds: ["orchard"],
    members: npcIds.map((participantId) => ({ participantId, role: "npc" })),
    groups: [{ groupId: "orchard-team", participantIds: npcIds }],
    channels: [{ channelId: "observation", participantIds: npcIds }],
  });
  participants.append(access, {
    eventId: "private-a",
    sessionId: "orchard-session",
    revision: 1,
    channelId: "observation",
    senderId: "npc-a",
    recipientIds: [],
    observerIds: [],
    text: "private silver iris",
  });
  const config: PlanSchedule = {
    scheduleId: "survey",
    revision: 1,
    state: "running",
    spec: {
      sessionId: "orchard-session",
      sessionRevision: 1,
      ...(count > 1 ? { groupId: "orchard-team" } : {}),
      actors: npcIds.map((participantId) => ({
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
      objective: "Inspect the orchard",
      channelId: "observation",
      sharedEventIds: [],
    },
    clock: "world",
    interval: 10,
    nextDue: 10,
    maxRuns: 1,
  };
  const service = createGroupSchedulerService({
    store,
    access,
    workerId: "owned-demo-worker",
    clock: () => ({ wallTimeMs: Date.now(), worldTicks: { orchard: 10 } }),
    hostAvailable: () => true,
    budgets: { principalCalls: 1 },
    async controller(input: PlanningInput): Promise<GroupPlan> {
      assert(!JSON.stringify(input).includes("silver iris"));
      return {
        objective: input.spec.objective,
        assignments: input.spec.actors.map((actor) => ({
          assignmentId: `survey-${actor.participantId}`,
          actorId: actor.participantId,
          intentId: "survey",
          dependsOn: [],
        })),
      };
    },
  });
  const client = createSchedulerClient(service.port);
  await client.configure({ expectedRevision: 0, config });
  const proposal = await new Promise<
    Extract<
      Awaited<ReturnType<typeof client.runDue>>[number],
      { status: "proposed" }
    >
  >((resolve, reject) => {
    timer = setTimeout(() => reject(Error("Demo deadline")), 2000);
    runner = startGroupSchedulerRunner(service, {
      pulseMs: 10,
      onResult: (results) => {
        const result = results.find((x) => x.status === "proposed");
        if (result?.status === "proposed") resolve(result);
      },
      onError: () => reject(Error("Scheduler failed")),
    });
  });
  // This output is only a proposal. The host retains adoption and all mechanics.
  console.log(
    JSON.stringify(
      {
        status: proposal.status,
        objective: proposal.claim.plan!.objective,
        assignments: proposal.claim.plan!.assignments,
      },
      null,
      2,
    ),
  );
  await client.report({
    reportId: "host-declined",
    claimId: proposal.claim.claimId,
    status: "rejected",
    assignmentIds: [],
    summary: "Synthetic host declines execution; no world effects occurred",
  });
  assert.equal(
    participants.history(access, "orchard-session", "npc-a").length,
    1,
  );
  console.log(
    `${count} NPCs, 0 players: due runner proposed bounded work; no speech or effects were recorded.`,
  );
} finally {
  if (timer) clearTimeout(timer);
  await runner?.stop();
  db.close();
}
