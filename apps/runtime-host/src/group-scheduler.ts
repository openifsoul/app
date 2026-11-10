import {
  createGroupSchedulerRuntime,
  SessionError,
} from "@ifsoul/core/runtime";
import type {
  ParticipantStore,
  SessionAccess,
  PlanSchedule,
  PlanningTrigger,
  PlanningClaim,
  PlanHostReport,
  PlanningInput,
  PlanningClock,
  PlanningBudgets,
} from "@ifsoul/core/runtime";
import type { SchedulerHostPort } from "@ifsoul/adapter-sdk";

export type PlanningRunResult =
  | { scheduleId: string; status: "proposed"; claim: PlanningClaim }
  | {
      scheduleId: string;
      status:
        | "not-due"
        | "paused"
        | "policy-denied"
        | "host-unavailable"
        | "busy"
        | "budget"
        | "replay"
        | "unknown"
        | "failed"
        | "stale";
    };
/** Trusted host composition. No account, database, model, network or timer is created here. */
export function createGroupSchedulerService(options: {
  store: ParticipantStore;
  access: SessionAccess;
  workerId: string;
  clock: () => PlanningClock;
  hostAvailable: (sessionId: string) => boolean;
  controller: (input: PlanningInput, signal: AbortSignal) => Promise<unknown>;
  budgets?: Partial<PlanningBudgets>;
  budgetCeilings?: Partial<PlanningBudgets>;
  behaviorOperator?: import("@ifsoul/core/runtime").BehaviorOperatorPolicy;
  timeoutMs?: number;
  leaseMs?: number;
}) {
  const runtime = createGroupSchedulerRuntime(
    options.store,
    options.budgets,
    options.budgetCeilings,
    options.behaviorOperator,
  );
  const access = structuredClone(options.access);
  const leaseMs = options.leaseMs ?? 30000,
    timeoutMs = options.timeoutMs ?? Math.min(25000, leaseMs - 1);
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 2 ||
    leaseMs > 60000 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs >= leaseMs
  )
    throw new RangeError("Invalid scheduler lease/deadline");
  const available = (sessionId: string) => {
    try {
      return options.hostAvailable(sessionId) === true;
    } catch {
      return false;
    }
  };
  async function trigger(
    scheduleId: string,
    trigger: PlanningTrigger,
    signal?: AbortSignal,
  ): Promise<PlanningRunResult> {
    if (signal?.aborted)
      throw new DOMException("Scheduler stopped", "AbortError");
    const config = runtime
      .list(access)
      .find((x) => x.scheduleId === scheduleId);
    if (!config) throw new SessionError("unauthorized");
    const input = runtime.claim(
      access,
      scheduleId,
      trigger,
      options.clock(),
      options.workerId,
      leaseMs,
      available(config.spec.sessionId),
    );
    if (!("claim" in input)) return { scheduleId, status: input.status };
    const deadline = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    let abort = () => {};
    try {
      const output = await Promise.race([
        options.controller(structuredClone(input), deadline),
        new Promise<never>((_, reject) => {
          abort = () =>
            reject(
              new DOMException("Scheduler stopped or timed out", "AbortError"),
            );
          deadline.addEventListener("abort", abort, { once: true });
          if (deadline.aborted) abort();
        }),
      ]);
      if (deadline.aborted)
        throw new DOMException("Scheduler stopped or timed out", "AbortError");
      if (!available(input.spec.sessionId)) throw new SessionError("stale");
      const claim = runtime.complete(
        access,
        input.claim,
        output,
        options.clock(),
      );
      return { scheduleId, status: "proposed", claim };
    } catch (error) {
      const definite =
        error instanceof SessionError &&
        ["invalid", "stale", "unauthorized"].includes(error.code);
      try {
        runtime.fail(access, input.claim, !definite);
      } catch {
        /* A config revision or another fenced owner already settled this claim. */
      }
      return {
        scheduleId,
        status: definite
          ? error.code === "invalid"
            ? "failed"
            : "stale"
          : "unknown",
      };
    } finally {
      deadline.removeEventListener("abort", abort);
    }
  }
  async function runDue(signal?: AbortSignal): Promise<PlanningRunResult[]> {
    const results: PlanningRunResult[] = [];
    let started = 0;
    // One bounded scan, one controller start per host pulse. No missed-period replay.
    for (const config of runtime
      .list(access)
      .filter((c) => c.state === "running")
      .sort(
        (a, b) =>
          a.nextDue - b.nextDue || a.scheduleId.localeCompare(b.scheduleId),
      )) {
      if (signal?.aborted || started >= 1) break;
      const result = await trigger(config.scheduleId, { kind: "due" }, signal);
      results.push(result);
      if (["proposed", "failed", "unknown", "stale"].includes(result.status))
        started++;
    }
    return results;
  }
  type Inspection = ReturnType<typeof runtime.inspect>;
  const port: SchedulerHostPort<
    PlanSchedule,
    PlanningTrigger,
    PlanningClaim,
    PlanHostReport,
    Inspection,
    PlanningRunResult
  > = {
    async configure(request) {
      return runtime.configure(
        access,
        request.expectedRevision,
        request.config,
      );
    },
    async control(request) {
      return runtime.control(
        access,
        request.scheduleId,
        request.expectedRevision,
        request.action,
      );
    },
    runDue: () => runDue(),
    trigger: (request) => trigger(request.scheduleId, request.trigger),
    async report(report) {
      return runtime.report(access, report);
    },
    async reconcile(request) {
      return runtime.reconcile(access, request.claimId);
    },
    async inspect(request) {
      return runtime.inspect(access, request.scheduleId);
    },
  };
  return { port, runDue };
}
/** Optional owned pulse runner. Embedders may instead call service.runDue from host ticks. */
export function startGroupSchedulerRunner(
  service: Pick<ReturnType<typeof createGroupSchedulerService>, "runDue">,
  options: {
    pulseMs: number;
    onResult?: (results: PlanningRunResult[]) => void;
    onError?: () => void;
  },
) {
  if (
    !Number.isInteger(options.pulseMs) ||
    options.pulseMs < 10 ||
    options.pulseMs > 60000
  )
    throw new RangeError("Invalid scheduler pulse");
  const controller = new AbortController();
  let active: Promise<void> | undefined;
  const pulse = () => {
    if (controller.signal.aborted || active) return;
    active = service
      .runDue(controller.signal)
      .then(
        (results) => {
          try {
            options.onResult?.(results);
          } catch {
            /* Diagnostics grant no authority. */
          }
        },
        () => {
          try {
            options.onError?.();
          } catch {}
        },
      )
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(pulse, options.pulseMs);
  pulse();
  return {
    async stop() {
      clearInterval(timer);
      controller.abort();
      await active;
    },
  };
}
