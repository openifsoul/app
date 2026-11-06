/** Original synthetic lab inputs. Normative schema/example files are never modified. */
import type {
  CharacterInstance,
  ContextReport,
  ConversationRequest,
  EnvironmentProfile,
  PlanProposal,
} from "@ifsoul/core/protocol";
export type LabDocument = Record<string, unknown>;

export const SCENARIO_TIME = "2026-11-05T08:00:00.000Z";
export const SCENARIO_EXPIRES = "2026-11-05T08:05:00.000Z";
export const SCENARIO_LABEL = "deterministic synthetic scenario controller";
export const IDS = {
  character: "character-lumen",
  characterParticipant: "participant-lumen",
  localParticipant: "participant-local",
  garden: "lab-garden",
  chat: "lab-chat",
  inspect: "lab-task-inspect",
  water: "lab-task-water",
} as const;

const envelope = { schemaVersion: "draft-0.2.0" as const };
export const gardenBinding = {
  environmentId: IDS.garden,
  sessionId: "lab-garden-session-1",
  characterId: IDS.character,
  embodimentId: "lab-gardener-1",
};
export const chatBinding = {
  environmentId: IDS.chat,
  sessionId: "lab-chat-session-1",
  characterId: IDS.character,
  embodimentId: "lab-terminal-1",
};
const horizon = {
  basis: "world-ticks" as const,
  timelineId: "lab-morning-1",
  fromTick: 100,
  toTick: 600,
};

export function character(): CharacterInstance & {
  template: { templateId: string; revision: number };
} {
  return {
    ...envelope,
    kind: "character-instance",
    characterId: IDS.character,
    participantId: IDS.characterParticipant,
    createdAt: SCENARIO_TIME,
    template: { templateId: "lab-lumen-original", revision: 1 },
    profile: {
      name: "Lumen Reed",
      description:
        "An original synthetic character used only by the local laboratory.",
      traits: { careful: true },
      preferences: [],
      speechStyle: {
        description: "Concise factual replies.",
        languages: ["en"],
        habits: [],
      },
      goals: [
        {
          goalId: "lab-care",
          description: "Learn about herb beds.",
          priority: "normal",
          status: "desired",
        },
      ],
      authoredBiography: {
        text: "Lumen is authored fiction, not a real person or lived history.",
        fictional: true,
      },
    },
    memoryRecordIds: [],
    relationshipMemoryIds: [],
  };
}

export function profile(medium: "game" | "chat"): EnvironmentProfile {
  const chat = medium === "chat";
  const binding = chat ? chatBinding : gardenBinding;
  const hostId = chat ? "lab-chat-host" : "lab-garden-host";
  return {
    ...envelope,
    kind: "environment-profile",
    binding,
    hostId,
    revision: chat ? "lab-chat-profile-1" : "lab-garden-profile-1",
    medium,
    embodiment: {
      form: chat ? "computer" : "human",
      description: "Synthetic abstract lab representation.",
      modalities: chat ? ["text", "status"] : ["speech", "status"],
    },
    participantLinks: [
      {
        claimId: `${medium}-lumen-link`,
        participantId: IDS.characterParticipant,
        environmentSubjectId: binding.embodimentId,
        issuerId: hostId,
      },
      {
        claimId: `${medium}-local-link`,
        participantId: IDS.localParticipant,
        environmentSubjectId: `${medium}-local-subject`,
        issuerId: hostId,
      },
    ],
    planning: { cadence: chat ? "host-requested" : "daily", maxTasks: 4 },
    communication: {
      mode: chat ? "live-channel" : "host-requested",
      availability: "persistent",
      allowUnrequestedMessages: false,
      channelIds: [chat ? "lab-room" : "lab-nearby"],
    },
    hostIntents: chat
      ? []
      : [
          {
            intentId: "inspect-area",
            description: "Inspect an abstract bed ledger.",
            parameters: [{ name: "area", type: "entity-ref", required: true }],
            cancellable: false,
          },
          {
            intentId: "water-plot",
            description: "Consume water in the abstract host ledger.",
            parameters: [
              { name: "plot", type: "entity-ref", required: true },
              {
                name: "amount",
                type: "quantity",
                required: true,
                unit: "ml",
                minimum: 1,
                maximum: 100,
              },
            ],
            cancellable: false,
          },
        ],
    ...(!chat ? { worldTime: { timelineId: "lab-morning-1", tick: 100 } } : {}),
  };
}

export function context(medium: "game" | "chat"): ContextReport {
  const chat = medium === "chat";
  const base: ContextReport = {
    ...envelope,
    kind: "context-report",
    reportId: chat ? "lab-chat-context" : "lab-morning-context",
    contextRevision: chat ? "lab-chat-context-1" : "lab-context-100",
    environmentRevision: chat ? "lab-chat-profile-1" : "lab-garden-profile-1",
    correlationId: chat ? "lab-chat-context-cycle" : "lab-morning-cycle",
    binding: chat ? chatBinding : gardenBinding,
    recordedAt: SCENARIO_TIME,
    period: {
      basis: "utc",
      startAt: "2026-11-05T07:00:00.000Z",
      endAt: SCENARIO_TIME,
    },
    observedState: {
      summary: chat
        ? "A synthetic local participant requests a text reply; historical outcomes must come from selected memory."
        : "The abstract host ledger contains two uninspected beds, a dry plot and zero water.",
      properties: chat
        ? []
        : [
            {
              subjectId: "lab-plot",
              propertyId: "available-water-ml",
              value: 0,
            },
            {
              subjectId: "lab-area",
              propertyId: "uninspected-bed-count",
              value: 2,
            },
          ],
    },
    priorNeeds: chat
      ? []
      : [
          {
            needId: "lab-care",
            description: "Yesterday's dry plot still needs assessment.",
            priority: "normal",
            status: "current",
          },
        ],
    priorPlans: [],
    changes: chat
      ? []
      : [
          {
            changeId: "lab-dry-weather",
            kind: "event",
            recordedAt: SCENARIO_TIME,
            summary: "The synthetic host reports a dry morning.",
          },
        ],
  };
  if (!chat)
    base.planningRequest = {
      requestId: "lab-daily-request-1",
      cadence: "daily",
      horizon,
      maxTasks: 4,
      allowedIntentIds: ["inspect-area", "water-plot"],
    };
  return base;
}

/** Trust is asserted by this local composition root, not inferred from wire claims. */
export function localAccess(medium: "game" | "chat") {
  return {
    hostId: medium === "chat" ? "lab-chat-host" : "lab-garden-host",
    characterParticipantId: IDS.characterParticipant,
    verifiedParticipantIds: [IDS.characterParticipant, IDS.localParticipant],
    authorizedChannelIds: [medium === "chat" ? "lab-room" : "lab-nearby"],
    recallEnvironmentIds: [IDS.garden, IDS.chat],
    memoryScope: {
      audience: "participants" as const,
      participantIds: [IDS.characterParticipant, IDS.localParticipant],
      export: "forbidden" as const,
    },
    visibleEntityIds: ["lab-area", "lab-plot"],
  };
}

export function proposedPlan(): PlanProposal {
  return {
    ...envelope,
    kind: "plan-proposal",
    binding: gardenBinding,
    correlationId: "lab-morning-cycle",
    planId: "lab-plan-1",
    requestId: "lab-daily-request-1",
    contextReportId: "lab-morning-context",
    contextRevision: "lab-context-100",
    environmentRevision: "lab-garden-profile-1",
    createdAt: SCENARIO_TIME,
    expiresAt: SCENARIO_EXPIRES,
    horizon,
    tasks: [
      {
        taskId: IDS.inspect,
        intentId: "inspect-area",
        arguments: { area: { type: "entity-ref", entityId: "lab-area" } },
        priority: "normal",
        dependsOnTaskIds: [],
        explanation: "Synthetic scenario: assess the beds first.",
      },
      {
        taskId: IDS.water,
        intentId: "water-plot",
        arguments: {
          plot: { type: "entity-ref", entityId: "lab-plot" },
          amount: { type: "quantity", value: 100, unit: "ml" },
        },
        priority: "low",
        dependsOnTaskIds: [IDS.inspect],
        explanation:
          "Synthetic proposal; the host must check its water ledger.",
      },
    ],
  };
}

export function conversationRequest(
  message: string,
  id: string,
): ConversationRequest {
  return {
    ...envelope,
    kind: "conversation-request",
    binding: chatBinding,
    requestId: `lab-chat-request-${id}`,
    correlationId: `lab-chat-cycle-${id}`,
    channelId: "lab-room",
    speakerParticipantId: IDS.characterParticipant,
    recipientParticipantIds: [IDS.localParticipant],
    environmentRevision: "lab-chat-profile-1",
    contextRevision: "lab-chat-context-1",
    mode: "live-channel",
    trigger: "incoming-message",
    requestedModality: "text",
    receivedAt: SCENARIO_TIME,
    deadlineAt: SCENARIO_EXPIRES,
    messages: [
      {
        messageId: `lab-message-${id}`,
        participantId: IDS.localParticipant,
        recordedAt: SCENARIO_TIME,
        modality: "text",
        content: message,
      },
    ],
  };
}
