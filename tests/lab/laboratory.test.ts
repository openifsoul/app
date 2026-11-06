import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import {
  invokeLab,
  withLabDirectory,
} from "../../packages/testing/src/laboratory.js";
import { memoryGroundedReply } from "../../apps/simulator/src/controller.js";
import { proposedPlan, IDS } from "../../apps/simulator/src/scenario.js";
import { SyntheticHost } from "../../apps/simulator/src/host.js";
import { createRuntime } from "@ifsoul/core/runtime";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import {
  character,
  context,
  localAccess,
  profile,
  SCENARIO_TIME,
} from "../../apps/simulator/src/scenario.js";
import { scenarioController } from "../../apps/simulator/src/controller.js";

test("scenario dialogue uses supplied outcomes rather than inventing completed work", () => {
  const empty = memoryGroundedReply([]);
  assert.match(
    empty,
    /no selected host report confirming a completed inspection/,
  );
  assert.doesNotMatch(empty, /inspection completed:/);
  const host = new SyntheticHost();
  const plan = proposedPlan();
  const decision = host.decide(plan);
  const report = host.inspect(plan);
  const remembered = memoryGroundedReply([
    { recordedPayload: decision },
    { recordedPayload: report },
  ]);
  assert.match(remembered, /inspected 2 herb beds/);
  assert.match(remembered, /proposed and rejected, not completed/);
  const changed = memoryGroundedReply([
    {
      recordedPayload: {
        ...report,
        summary: "The host inspected 7 synthetic beds.",
      },
    },
  ]);
  assert.match(changed, /7 synthetic beds/);
  assert.doesNotMatch(changed, /2 herb beds/);
  const onlyProposal = memoryGroundedReply([{ recordedPayload: plan }]);
  assert.match(onlyProposal, /no selected host report/);
  const failed = memoryGroundedReply([
    { recordedPayload: { ...report, status: "failed" } },
  ]);
  assert.doesNotMatch(failed, /inspection completed:/);
});

test("host owns partial acceptance and updates only its accepted abstract task", () => {
  const host = new SyntheticHost();
  const plan = proposedPlan();
  assert.throws(() => host.inspect(plan), /not accepted/);
  assert.equal(host.decide(plan).status, "partially-accepted");
  assert.equal(host.snapshot().uninspectedBeds, 2);
  assert.equal(host.inspect(plan).status, "succeeded");
  assert.deepEqual(host.snapshot(), {
    availableWaterMl: 0,
    uninspectedBeds: 0,
  });
});

test("CLI runs real runtime/SQLite, survives restart and resumes demo without repeating work", async () => {
  await withLabDirectory(async (_directory, db) => {
    const demo = await invokeLab(["demo", "--db", db, "--json"]);
    assert.equal(demo.exitCode, 0, demo.stderr);
    const first = JSON.parse(demo.stdout);
    assert.equal(first.characterId, IDS.character);
    assert.equal(first.clock.mode, "fixed-simulation");
    assert.match(first.controller, /deterministic synthetic/);
    assert.equal(
      first.stages.find(
        (stage: { stage: string }) => stage.stage === "host-acceptance",
      ).status,
      "partially-accepted",
    );
    assert.match(first.response.output.content, /inspected 2 herb beds/);
    assert.match(
      first.response.output.content,
      /proposed and rejected, not completed/,
    );
    assert.ok(first.selectedMemoryIds.length > 0);
    const reportId = first.memories.find(
      (memory: { sourceKind: string }) => memory.sourceKind === "task-report",
    ).memoryId;
    assert.ok(first.selectedMemoryIds.includes(reportId));
    await assert.rejects(access(`${db}.lock`));

    const inspect = await invokeLab(["inspect", "--db", db, "--json"]);
    assert.equal(inspect.exitCode, 0, inspect.stderr);
    const listing = JSON.parse(inspect.stdout);
    assert.equal(listing.memories.length, first.memories.length);
    assert.ok(
      listing.memories.some(
        (memory: { memoryId: string }) => memory.memoryId === reportId,
      ),
    );
    assert.ok(
      listing.memories.every(
        (memory: object) => !("recordedPayload" in memory),
      ),
    );

    const chat = await invokeLab([
      "chat",
      "--message",
      "What happened this morning?",
      "--db",
      db,
      "--json",
    ]);
    assert.equal(chat.exitCode, 0, chat.stderr);
    const reply = JSON.parse(chat.stdout);
    assert.match(reply.response.output.content, /inspected 2 herb beds/);
    assert.match(
      reply.response.output.content,
      /proposed and rejected, not completed/,
    );
    assert.ok(reply.selectedMemoryIds.includes(reportId));

    const repeat = await invokeLab(["demo", "--db", db, "--json"]);
    assert.equal(repeat.exitCode, 0, repeat.stderr);
    const repeated = JSON.parse(repeat.stdout);
    assert.equal(repeated.reused, true);
    assert.equal(repeated.memories.length, reply.memories.length);
    assert.equal(
      repeated.stages.find(
        (stage: { stage: string }) => stage.stage === "resume",
      ).hostWorkRepeated,
      false,
    );
    assert.equal(
      repeated.memories.filter(
        (memory: { sourceKind: string }) => memory.sourceKind === "task-report",
      ).length,
      1,
    );
    await assert.rejects(access(`${db}.lock`));
  });
});

test("new database chat preserves unknown outcomes; usage errors are nonzero and safe", async () => {
  await withLabDirectory(async (_directory, db) => {
    const absent = await invokeLab(["inspect", "--db", db, "--json"]);
    assert.equal(absent.exitCode, 1);
    assert.match(absent.stderr, /not-found/);
    await assert.rejects(access(db));
    const chat = await invokeLab([
      "chat",
      "--message",
      "Did you complete inspection?",
      "--db",
      db,
      "--json",
    ]);
    assert.equal(chat.exitCode, 0, chat.stderr);
    assert.match(
      JSON.parse(chat.stdout).response.output.content,
      /no selected host report confirming a completed inspection/,
    );
    const missing = await invokeLab(["chat", "--json"]);
    assert.equal(missing.exitCode, 2);
    assert.match(missing.stderr, /chat requires/);
    const help = await invokeLab(["--help"]);
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /pnpm lab inspect/);
  });
});

test("a restarted CLI reply reflects changed authoritative persisted report content", async () => {
  await withLabDirectory(async (_directory, db) => {
    const opened = openSQLiteMemory(db);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const memory = opened.value;
    try {
      const runtime = createRuntime({
        memory,
        controller: scenarioController,
        now: () => new Date(SCENARIO_TIME),
      });
      assert.equal(
        runtime.setSession({
          character: character(),
          profile: profile("game"),
          context: context("game"),
          access: localAccess("game"),
        }).ok,
        true,
      );
      const planned = await runtime.plan();
      assert.equal(planned.ok, true);
      if (!planned.ok) return;
      const host = new SyntheticHost();
      assert.equal(runtime.recordDecision(host.decide(planned.value)).ok, true);
      const report = host.inspect(planned.value);
      // A distinct authorized host observation proves the reply is read from the DB.
      report.summary = "The synthetic host inspected 7 alternate test beds.";
      report.observedEffects = ["Seven alternate test beds were inspected."];
      assert.equal(runtime.recordReport(report).ok, true);
    } finally {
      assert.equal(memory.close().ok, true);
    }
    const chat = await invokeLab([
      "chat",
      "--message",
      "What is recorded?",
      "--db",
      db,
      "--json",
    ]);
    assert.equal(chat.exitCode, 0, chat.stderr);
    const content = JSON.parse(chat.stdout).response.output.content;
    assert.match(content, /7 alternate test beds/);
    assert.doesNotMatch(content, /2 herb beds/);
  });
});

test("CLI reports writer ownership safely without touching another writer's lock", async () => {
  await withLabDirectory(async (_directory, db) => {
    const opened = openSQLiteMemory(db);
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    try {
      const rejected = await invokeLab(["demo", "--db", db, "--json"]);
      assert.equal(rejected.exitCode, 1);
      assert.match(rejected.stderr, /database-owned/);
      await access(`${db}.lock`);
    } finally {
      assert.equal(opened.value.close().ok, true);
    }
    await assert.rejects(access(`${db}.lock`));
  });
});
