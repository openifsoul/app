# Autonomous host planning

`@ifsoul/app/server` exports `createGroupSchedulerService` and
`startGroupSchedulerRunner`. They compose the public Core group scheduler with
an injected atomic participant store, verified host access, worker ID, clock,
host-availability check and bounded controller. No HTTP route, account service,
model client or database is implicitly created.

Run the complete standalone synthetic host from this checkout:

```sh
pnpm exec tsx apps/runtime-host/src/scheduler-demo.ts 1
pnpm exec tsx apps/runtime-host/src/scheduler-demo.ts 2
```

The [executable source](../apps/runtime-host/src/scheduler-demo.ts) supplies actual
verified NPC mappings, sessions, roles/capabilities, allowed intents, schedules and
proposals. Both commands have zero player members. The owned pulse runner invokes
due planning without a player call; its deterministic controller receives no
private memory. The synthetic host declines execution, so no world effects or
speech are recorded. The runner, timer and in-memory SQLite database close in
`finally`.

A host may instead invoke `service.runDue(signal)` from its own simulation ticks.
`startGroupSchedulerRunner` accepts `pulseMs` and returns `stop(): Promise<void>`.
It never overlaps its own pulses; separate workers coordinate through the durable
Core claims. Always await `stop` before closing the host-owned database.
The clock callback returns wall milliseconds and explicit per-world tick values.
The availability callback must reflect whether the host can currently process
plans; exceptions block planning. A pulse does not invent world ticks or catch up
historical actions.

`service.port` implements the SDK `SchedulerHostPort`. `configure`, `control`,
`trigger`, `runDue`, `report`, `reconcile` and `inspect` remain trusted host
operations. Authenticate/authorize the host before constructing or exposing this
port. Schedule bodies and model outputs cannot supply trusted identity or raise
budgets. Service options `budgets` and `budgetCeilings` use Core's existing
trusted resource resolver; for example, explicitly request and permit
`{ principalCalls: 128, concurrentPlans: 2 }` in both options. NPC writer and
per-group fences still apply when principal concurrency is raised.

The SQL participant store persists schedule configuration, cursors, call
reservations, fenced claims, proposals and idempotent host reports in the same
principal transaction as session/writer state. An unfinished expired request is
unknown after restart, rather than automatically retried. Persist host adoption
before starting any host mechanics. Report actual outcomes separately; only
explicit reconciliation can release uncertain unadopted work. Local cancellation
does not guarantee provider-side work or charges have stopped.

See [Core contracts and diagrams](https://github.com/openifsoul/core/blob/main/docs/group-scheduler.md)
for shared-context filtering, capability/DAG checks, clock domains, limits,
revision fencing and restart semantics. Existing solitary bridge and session
conversation interfaces remain unchanged.
