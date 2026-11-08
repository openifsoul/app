import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRuntime, exchangeKey } from "@ifsoul/core/runtime";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import type { Result } from "@ifsoul/core/memory/port";
import type { MemoryEvent, ConversationResponse } from "@ifsoul/core/protocol";
import { scenarioController, object } from "../../simulator/src/controller.js";
import { SyntheticHost } from "../../simulator/src/host.js";
import {
  character,
  context,
  conversationRequest,
  IDS,
  localAccess,
  profile,
  SCENARIO_LABEL,
  SCENARIO_TIME,
} from "../../simulator/src/scenario.js";

export class LaboratoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new LaboratoryError(result.error.code, result.error.message);
  return result.value;
}

export interface LabOptions {
  command: "demo" | "inspect" | "chat";
  db: string;
  message?: string;
  full?: boolean;
}

/** The composition root alone opens SQLite and asserts these synthetic local mappings. */
export async function runLaboratory(options: LabOptions) {
  if (options.command === "inspect" && !existsSync(options.db)) {
    throw new LaboratoryError(
      "not-found",
      "The laboratory database does not exist. Run demo or chat first.",
    );
  }
  const memory = unwrap(openSQLiteMemory(options.db));
  try {
    if (
      options.command === "inspect" &&
      !unwrap(memory.getCharacter(IDS.character))
    ) {
      throw new LaboratoryError(
        "not-found",
        "This database has no laboratory character.",
      );
    }
    const stages: { stage: string; [key: string]: unknown }[] = [];
    let selectedMemoryIds: string[] = [];
    const runtime = createRuntime({
      memory,
      now: () => new Date(SCENARIO_TIME),
      limits: { maxMemoryRecords: 100, maxMemoryBytes: 200_000 },
      controller: async (input, signal) => {
        selectedMemoryIds = input.memories.map((event) => event.memoryId);
        stages.push({
          stage: "selected-memory",
          operation: input.operation,
          memoryIds: selectedMemoryIds,
        });
        return scenarioController(input, signal);
      },
    });
    const session = (medium: "game" | "chat") => {
      unwrap(
        runtime.setSession({
          character: character(),
          profile: profile(medium),
          context: context(medium),
          access: localAccess(medium),
        }),
      );
      stages.push({
        stage: "context",
        environmentId: medium === "game" ? IDS.garden : IDS.chat,
        trustedMapping: "synthetic local composition root",
      });
    };
    const history = () =>
      options.command === "inspect"
        ? unwrap(
            memory.recall({
              characterId: IDS.character,
              audienceParticipantIds: [
                IDS.characterParticipant,
                IDS.localParticipant,
              ],
              environmentIds: localAccess("chat").recallEnvironmentIds,
              limit: 100,
              maxBytes: 200_000,
            }),
          )
        : unwrap(runtime.history({ limit: 100, maxBytes: 200_000 }));
    let response: ConversationResponse | undefined;
    let reused = false;
    if (options.command !== "inspect")
      session(options.command === "demo" ? "game" : "chat");
    if (options.command === "demo") {
      const prior = unwrap(
        memory.getExchange(
          exchangeKey(IDS.character, "task-report", "lab-inspection-outcome-1"),
        ),
      );
      if (prior) {
        reused = true;
        stages.push({
          stage: "resume",
          status: "existing-run",
          reportId: "lab-inspection-outcome-1",
          hostWorkRepeated: false,
        });
      } else {
        const plan = unwrap(await runtime.plan());
        stages.push({
          stage: "proposal",
          planId: plan.planId,
          tasks: plan.tasks.map((task) => ({
            taskId: task.taskId,
            state: "proposed",
          })),
        });
        const host = new SyntheticHost();
        const decision = host.decide(plan);
        unwrap(runtime.recordDecision(decision));
        stages.push({
          stage: "host-acceptance",
          status: decision.status,
          tasks: decision.taskDecisions,
        });
        const report = host.inspect(plan);
        unwrap(runtime.recordReport(report));
        stages.push({
          stage: "host-outcome",
          taskId: report.taskId,
          status: report.status,
          ledger: host.snapshot(),
        });
      }
      stages.push({
        stage: "memory",
        memoryIds: history().map((event) => event.memoryId),
      });
      session("chat");
    }
    if (options.command !== "inspect") {
      const message =
        options.message ??
        "What did you complete, and what happened to watering?";
      const historyIds = history().map((event) => event.memoryId);
      const id =
        options.command === "demo"
          ? "demo-recall-1"
          : createHash("sha256")
              .update(JSON.stringify({ message, historyIds }))
              .digest("hex")
              .slice(0, 24);
      const request = conversationRequest(message, id);
      const conversation = await runtime.conversation(request);
      response = unwrap(conversation);
      stages.push({
        stage: "dialogue",
        responseId: response.responseId,
        state: "proposed",
        selectedMemoryIds,
        ...(conversation.ok && conversation.reused
          ? {
              reused: true,
              memorySelection:
                "cached reply; controller selection was not rerun",
            }
          : {}),
      });
      const delivery = {
        schemaVersion: "0.3.0" as const,
        kind: "conversation-delivery" as const,
        binding: response.binding,
        requestId: response.requestId,
        responseId: response.responseId,
        correlationId: response.correlationId,
        channelId: response.channelId,
        deliveryId: `lab-delivery-${id}`,
        recordedAt: SCENARIO_TIME,
        status: "delivered" as const,
      };
      unwrap(runtime.recordDelivery(delivery));
      stages.push({
        stage: "delivery",
        responseId: response.responseId,
        status: "delivered",
        target: "local laboratory transcript",
      });
    }
    const events = history();
    if (options.command === "inspect") {
      selectedMemoryIds = events.map((event) => event.memoryId);
      stages.push({
        stage: "inspection",
        status: "listed-existing-records",
        memoryIds: selectedMemoryIds,
        contextWritten: false,
      });
    }
    return {
      ok: true as const,
      command: options.command,
      controller: SCENARIO_LABEL,
      clock: { mode: "fixed-simulation" as const, now: SCENARIO_TIME },
      characterId: IDS.character,
      reused,
      stages,
      selectedMemoryIds,
      ...(response
        ? {
            response: {
              responseId: response.responseId,
              output: response.output,
              delivery: "delivered",
            },
          }
        : {}),
      memories: events.map((event) =>
        memoryListing(event, options.full ?? false),
      ),
      limitations: [
        "Synthetic trusted local identities only; no network authentication or real provider.",
        "Host adoption, observed completion and dialogue delivery remain separate states.",
      ],
    };
  } finally {
    unwrap(memory.close());
  }
}

export function memoryListing(event: MemoryEvent, full: boolean) {
  const payload = event.recordedPayload;
  return {
    memoryId: event.memoryId,
    eventType: event.eventType,
    environmentId: event.environmentId,
    sourceKind: payload.kind,
    sourceId:
      payload.reportId ??
      payload.decisionId ??
      payload.planId ??
      payload.requestId,
    ...(payload.kind === "plan-proposal" ? { state: "proposed" } : {}),
    ...(payload.kind === "plan-decision"
      ? {
          state: "adoption",
          status: payload.status,
          tasks: payload.taskDecisions,
        }
      : {}),
    ...(payload.kind === "task-report"
      ? {
          state: "host-observed",
          taskId: payload.taskId,
          status: payload.status,
        }
      : {}),
    ...(payload.kind === "conversation-response"
      ? { state: "dialogue-proposed", outputType: object(payload.output).type }
      : {}),
    ...(payload.kind === "conversation-delivery"
      ? { state: "dialogue-delivery", status: payload.status }
      : {}),
    ...(full ? { recordedPayload: payload } : {}),
  };
}
