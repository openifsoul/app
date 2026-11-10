import { createHash } from "node:crypto";
import {
  createParticipantRuntime,
  DEFAULT_BEHAVIOR_OPERATOR,
  SessionError,
} from "@ifsoul/core/runtime";
import type {
  ParticipantStore,
  SessionAccess,
  BehaviorConfiguration,
  BehaviorOperatorPolicy,
  AgentController,
  ControllerInput,
  BehaviorInspection,
} from "@ifsoul/core/runtime";
import type { ConversationRequest } from "@ifsoul/core/protocol";
import type { CharacterWorkspace } from "../../runtime-host/src/service-types.js";
import {
  createBehaviorService,
  classifyBehaviorEvent,
} from "../../runtime-host/src/behavior.js";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
/** Authenticated App composition shares exactly the SDK participant/config store. */
export function createAppBehavior(options: {
  store: ParticipantStore;
  access: SessionAccess;
  workspace: CharacterWorkspace;
  operator?: BehaviorOperatorPolicy;
  now?: () => number;
}) {
  const ownerOperator = options.operator ?? {
    ...DEFAULT_BEHAVIOR_OPERATOR,
    canEditConfig: true,
  };
  const behavior = createBehaviorService({
      ...options,
      operator: ownerOperator,
    }),
    participants = createParticipantRuntime(options.store, {
      behaviorOperator: ownerOperator,
    });
  function ensure(characterId?: string) {
    const snapshot = options.workspace.snapshot(characterId);
    if (!snapshot.ok) throw new SessionError("unauthorized");
    const memoryId = snapshot.value.character.characterId,
      npcId = `npc-${digest(memoryId)}`,
      sessionId = `app-${digest(memoryId)}`,
      playerId = "verified-app-player";
    // Ownership comes from the already authenticated CharacterWorkspace lookup, never profile names/imported IDs.
    participants.register(options.access, {
      participantId: npcId,
      subjectId: `memory-${digest(memoryId)}`,
      kind: "npc",
    });
    participants.register(options.access, {
      participantId: playerId,
      subjectId: "verified-principal",
      kind: "player",
    });
    const existing = options.store.transact(options.access.principalId, (s) =>
      s.sessions.find((x) => x.sessionId === sessionId),
    );
    if (existing && existing.hostId !== options.access.hostId)
      throw new SessionError("unauthorized");
    if (!existing)
      participants.transition(options.access, `bind-${digest(memoryId)}`, 0, {
        sessionId,
        revision: 1,
        hostId: options.access.hostId,
        worldId: "app-chat",
        recallWorldIds: ["app-chat"],
        members: [
          { participantId: npcId, role: "npc" },
          { participantId: playerId, role: "player" },
        ],
        groups: [],
        channels: [{ channelId: "chat", participantIds: [npcId, playerId] }],
      });
    return {
      npcId,
      memoryId,
      sessionId,
      playerId,
      revision: existing?.revision ?? 1,
      label: snapshot.value.character.profile.name,
    };
  }
  const enabled = () =>
    options.store.transact(
      options.access.principalId,
      (s) => (s.behavior?.config.revision ?? 0) > 0,
    );
  async function guardController(
    input: ControllerInput,
    signal: AbortSignal,
    controller: AgentController,
  ) {
    if (!enabled()) return controller(input, signal);
    const binding = ensure(input.character.characterId),
      snapshot = behavior.inspect(binding.sessionId, binding.npcId),
      configRevision = snapshot.configRevision;
    let inspection: BehaviorInspection = snapshot;
    if (input.operation === "conversation") {
      const request = input.request as ConversationRequest,
        utterance = request.messages.at(-1)?.content ?? "";
      const event = {
        eventId: `chat-${digest([input.character.characterId, request.requestId])}`,
        sessionId: binding.sessionId,
        revision: binding.revision,
        channelId: "chat",
        senderId: binding.playerId,
        recipientIds: [binding.npcId],
        observerIds: [],
        text: utterance,
      };
      const kind = classifyBehaviorEvent(utterance);
      await behavior.observe({
        event,
        kind,
        npcIds: [binding.npcId],
        strategy: "rules",
      });
      inspection = behavior.inspect(binding.sessionId, binding.npcId);
      const policy = behavior.permissions(
        binding.sessionId,
        binding.npcId,
        event.eventId,
      );
      if (!policy.observe || !policy.speak) {
        const now = new Date((options.now ?? Date.now)()).toISOString();
        return {
          schemaVersion: "0.4.0",
          kind: "conversation-response",
          binding: request.binding,
          requestId: request.requestId,
          correlationId: request.correlationId,
          channelId: request.channelId,
          speakerParticipantId: request.speakerParticipantId,
          recipientParticipantIds: request.recipientParticipantIds,
          responseId: `response-${request.requestId}`,
          createdAt: now,
          expiresAt: request.deadlineAt,
          output: {
            type: "no-output",
            reason: "policy",
          },
        };
      }
    } else if (
      !inspection.effective.policy.general.observe ||
      !inspection.effective.policy.general.requestAction
    )
      throw new SessionError("unauthorized");
    // The configured App path uses the same evidence source as SDK; unrelated legacy reflection is not injected.
    const permitted = options.store.transact(
      options.access.principalId,
      (s) =>
        new Set(
          s.behavior?.observations
            .filter(
              (o) =>
                o.npcId === binding.npcId &&
                o.permissions.observe &&
                o.permissions.remember &&
                inspection.effective.policy[
                  o.kind === "provocation" ? "provocation" : "general"
                ].observe &&
                inspection.effective.policy[
                  o.kind === "provocation" ? "provocation" : "general"
                ].remember,
            )
            .map((o) => o.eventId),
        ),
    );
    const safeInput: ControllerInput = {
      ...structuredClone(input),
      behavior: {
        configRevision: inspection.configRevision,
        effective: inspection.effective,
        parameters: inspection.parameters,
        values: inspection.values.filter(
          (v) =>
            !v.targetParticipantId ||
            v.targetParticipantId === binding.playerId,
        ),
      },
      memories: input.memories.filter((memory) => {
        const payload = memory.recordedPayload as { requestId?: string };
        return (
          typeof payload?.requestId === "string" &&
          permitted.has(
            `chat-${digest([input.character.characterId, payload.requestId])}`,
          )
        );
      }),
      character: {
        ...input.character,
        profile: {
          ...input.character.profile,
          goals: inspection.effective.goals
            .filter((g) => g.enabled)
            .sort(
              (a, b) =>
                b.priority - a.priority || a.goalId.localeCompare(b.goalId),
            )
            .map((g) => g.objective),
        },
      },
    };
    const output = await controller(safeInput, signal);
    if (
      signal.aborted ||
      behavior.inspect(binding.sessionId, binding.npcId).configRevision !==
        configRevision
    )
      throw new SessionError("stale");
    return output;
  }
  return {
    enabled,
    guardController,
    principalId: options.access.principalId,
    async prepareBridge(request: import("./bridge.js").BridgeRequest) {
      if (!enabled()) return undefined;
      const binding = ensure(request.memoryId ?? request.character.id);
      if (request.operation === "chat")
        await behavior.observe({
          event: {
            eventId: `bridge-${digest([binding.memoryId, request.hostId, request.requestId])}`,
            sessionId: binding.sessionId,
            revision: binding.revision,
            channelId: "chat",
            senderId: binding.playerId,
            recipientIds: [binding.npcId],
            observerIds: [],
            text: request.context,
          },
          kind: classifyBehaviorEvent(request.context),
          npcIds: [binding.npcId],
          strategy: "rules",
        });
      const inspection = behavior.inspect(binding.sessionId, binding.npcId);
      const policy =
        request.operation === "chat"
          ? behavior.permissions(
              binding.sessionId,
              binding.npcId,
              `bridge-${digest([binding.memoryId, request.hostId, request.requestId])}`,
            )
          : inspection.effective.policy.general;
      const allowed =
        policy.observe &&
        (request.operation === "decide" ? policy.requestAction : policy.speak);
      return {
        allowed,
        context: {
          configRevision: inspection.configRevision,
          effective: inspection.effective,
          parameters: inspection.parameters,
          values: inspection.values.filter(
            (v) =>
              !v.targetParticipantId ||
              v.targetParticipantId === binding.playerId,
          ),
        },
        validate() {
          if (
            behavior.inspect(binding.sessionId, binding.npcId)
              .configRevision !== inspection.configRevision
          )
            throw new SessionError("stale");
        },
      };
    },
    async prepareRun(
      request: import("../../runtime-host/src/service-types.js").LabRunRequest,
    ) {
      if (!enabled()) return { allowed: true };
      const binding = ensure(request.memoryCharacterId ?? request.characterId);
      if (request.operation === "plan") {
        const p = behavior.inspect(binding.sessionId, binding.npcId).effective
          .policy.general;
        return { allowed: p.observe && p.requestAction };
      }
      if (
        typeof request.message !== "string" ||
        !request.message.trim() ||
        request.message.length > 4000 ||
        typeof request.requestId !== "string"
      )
        throw new SessionError("invalid");
      const event = {
        eventId: `chat-${digest([binding.memoryId, `chat-${request.requestId}`])}`,
        sessionId: binding.sessionId,
        revision: binding.revision,
        channelId: "chat",
        senderId: binding.playerId,
        recipientIds: [binding.npcId],
        observerIds: [],
        text: request.message.trim(),
      };
      await behavior.observe({
        event,
        kind: classifyBehaviorEvent(event.text),
        npcIds: [binding.npcId],
        strategy: "rules",
      });
      const p = behavior.permissions(
        binding.sessionId,
        binding.npcId,
        event.eventId,
      );
      return { allowed: p.observe && p.speak };
    },
    async read(characterId?: string) {
      if (!ownerOperator.canEditConfig) throw new SessionError("unauthorized");
      const binding = ensure(characterId);
      const snapshot = await behavior.port.read();
      return {
        ...snapshot,
        catalog: {
          ...snapshot.catalog,
          npcs: snapshot.catalog.npcs.map((n) =>
            n.npcId === binding.npcId ? { ...n, label: binding.label } : n,
          ),
        },
      };
    },
    update: (request: {
      expectedRevision: number;
      config: BehaviorConfiguration;
    }) => behavior.port.update(request),
    inspect: (sessionId: string, npcId: string) =>
      behavior.port.inspect({ sessionId, npcId }),
    service: behavior,
  };
}
export type AppBehaviorAPI = ReturnType<typeof createAppBehavior>;
