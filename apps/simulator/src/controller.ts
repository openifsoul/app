import {
  IDS,
  SCENARIO_EXPIRES,
  SCENARIO_TIME,
  proposedPlan,
  type LabDocument,
} from "./scenario.js";

export function object(value: unknown): LabDocument {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as LabDocument)
    : {};
}

export function objects(value: unknown): LabDocument[] {
  return Array.isArray(value) ? value.map(object) : [];
}

/** Only received task reports and decisions support these claims. Plans never do. */
export function recalledOutcomes(
  memories: readonly { recordedPayload: unknown }[],
) {
  const reports = memories.map((memory) => object(memory.recordedPayload));
  const completed = reports.filter(
    (report) => report.kind === "task-report" && report.status === "succeeded",
  );
  const rejected = reports.flatMap((report) =>
    report.kind === "plan-decision"
      ? objects(report.taskDecisions).filter(
          (task) => task.decision === "rejected",
        )
      : [],
  );
  return { completed, rejected };
}

export function memoryGroundedReply(
  memories: readonly { recordedPayload: unknown }[],
): string {
  const { completed, rejected } = recalledOutcomes(memories);
  const inspection = completed.find((report) => report.taskId === IDS.inspect);
  const watering = completed.find((report) => report.taskId === IDS.water);
  const rejection = rejected.find((task) => task.taskId === IDS.water);
  const parts = [
    inspection
      ? `The host reports inspection completed: ${String(inspection.summary)}`
      : "I have no selected host report confirming a completed inspection.",
    watering
      ? `The host reports watering completed: ${String(watering.summary)}`
      : rejection
        ? `Watering was proposed and rejected, not completed: ${String(rejection.reason ?? "The host rejected it.")}`
        : "I have no selected host report confirming completed watering, or a selected rejection decision.",
  ];
  return parts.join(" ");
}

/** Deterministic authored scenario, not an LLM, rule inference engine or model API. */
export async function scenarioController(
  input: {
    operation: "plan" | "conversation";
    request: unknown;
    memories: readonly { recordedPayload: unknown }[];
  },
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new Error("Scenario cancelled");
  if (input.operation === "plan") return proposedPlan();
  const request = object(input.request);
  return {
    schemaVersion: "draft-0.2.0",
    kind: "conversation-response",
    binding: request.binding,
    requestId: request.requestId,
    correlationId: request.correlationId,
    channelId: request.channelId,
    speakerParticipantId: request.speakerParticipantId,
    recipientParticipantIds: request.recipientParticipantIds,
    responseId: String(request.requestId).replace("request", "response"),
    createdAt: SCENARIO_TIME,
    expiresAt: SCENARIO_EXPIRES,
    output: {
      type: "utterance",
      modality: "text",
      content: memoryGroundedReply(input.memories),
    },
  };
}
