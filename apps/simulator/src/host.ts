import type {
  PlanDecision,
  PlanProposal,
  TaskReport,
} from "@ifsoul/core/protocol";
import { IDS, SCENARIO_TIME } from "./scenario.js";

/** Host-owned abstract ledger. No locomotion, NPC logic, combat or pathfinding. */
export class SyntheticHost {
  private waterMl = 0;
  private uninspectedBeds = 2;
  private readonly accepted = new Set<string>();

  decide(plan: PlanProposal): PlanDecision {
    const taskDecisions: PlanDecision["taskDecisions"] = plan.tasks.map(
      (task) => {
        if (task.taskId === IDS.inspect && task.intentId === "inspect-area") {
          this.accepted.add(IDS.inspect);
          return { taskId: IDS.inspect, decision: "accepted" };
        }
        const argument = task.arguments.amount;
        const amount =
          argument?.type === "quantity" ? argument.value : undefined;
        if (
          task.taskId === IDS.water &&
          task.intentId === "water-plot" &&
          typeof amount === "number" &&
          amount <= this.waterMl
        ) {
          this.accepted.add(IDS.water);
          return { taskId: IDS.water, decision: "accepted" };
        }
        return {
          taskId: task.taskId,
          decision: "rejected",
          reason:
            task.taskId === IDS.water
              ? "The synthetic host ledger has 0 ml of water."
              : "Unknown abstract host task.",
        };
      },
    );
    const acceptedCount = taskDecisions.filter(
      (task) => task.decision === "accepted",
    ).length;
    return {
      schemaVersion: "0.4.0",
      kind: "plan-decision",
      binding: plan.binding,
      correlationId: plan.correlationId,
      planId: plan.planId,
      decisionId: "lab-decision-1",
      requestId: plan.requestId,
      contextRevision: plan.contextRevision,
      recordedAt: SCENARIO_TIME,
      status:
        acceptedCount === taskDecisions.length
          ? "accepted"
          : acceptedCount
            ? "partially-accepted"
            : "rejected",
      taskDecisions,
    };
  }

  inspect(plan: PlanProposal): TaskReport {
    if (!this.accepted.has(IDS.inspect))
      throw new Error("Host inspection was not accepted");
    const inspectedBeds = this.uninspectedBeds;
    this.uninspectedBeds = 0;
    return {
      schemaVersion: "0.4.0",
      kind: "task-report",
      binding: plan.binding,
      correlationId: plan.correlationId,
      planId: plan.planId,
      reportId: "lab-inspection-outcome-1",
      taskId: IDS.inspect,
      contextRevision: "lab-context-101",
      recordedAt: SCENARIO_TIME,
      status: "succeeded",
      summary: `The abstract host inspected ${inspectedBeds} herb beds.`,
      observedEffects: [
        `The host ledger changed uninspected beds from ${inspectedBeds} to ${this.uninspectedBeds}.`,
      ],
    };
  }

  snapshot() {
    return {
      availableWaterMl: this.waterMl,
      uninspectedBeds: this.uninspectedBeds,
    };
  }
}
