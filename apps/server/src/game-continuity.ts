import { createHash } from "node:crypto";
import {
  createBehaviorRuntime,
  createParticipantRuntime,
  DEFAULT_BEHAVIOR_OPERATOR,
  SessionError,
} from "@ifsoul/core/runtime";
import type {
  AddressedEvent,
  AuthorizeSessionEvidence,
  BehaviorInspection,
  BehaviorProposal,
  ParticipantState,
  ParticipantStore,
} from "@ifsoul/core/runtime";
import type {
  ConversationRequest,
  ConversationResponse,
} from "@ifsoul/core/protocol";
import type { GameOutcomeReceipts } from "../../runtime-host/src/participant-sessions.js";
import type { ModelClient } from "@ifsoul/core/model-providers/types";
import { failure, success } from "@ifsoul/core/memory/port";
import {
  classifyBehaviorEvent,
  createBehaviorModelProposer,
  createBehaviorService,
  type DeferredBehaviorProposal,
} from "../../runtime-host/src/behavior.js";
import {
  createModelController,
  ProviderControllerError,
  linkedAppConversationInput,
  type ModelInputBudget,
} from "../../runtime-host/src/service.js";
import type {
  CharacterWorkspace,
  LabRun,
  LabRunRequest,
  LinkedGameEvidence,
} from "../../runtime-host/src/service-types.js";
import type { createGameConnectionBroker } from "./game-connections.js";
import type { createBridgeSourcePolicy } from "./bridge-source-access.js";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
type RelationshipHistory = ReturnType<
  ReturnType<typeof createBehaviorRuntime>["inspect"]
>["history"];

function visibleRelationshipHistory(
  history: RelationshipHistory,
  npcId: string,
  playerId: string,
  eligible: ReadonlySet<string>,
) {
  return history.filter(
    (change) =>
      change.npcId === npcId &&
      change.targetParticipantId === playerId &&
      !change.worldId &&
      change.evidenceEventIds.length > 0 &&
      change.evidenceEventIds.every((eventId) => eligible.has(eventId)),
  );
}

/** Compose a safe preview without applying a proposal or inventing an old value. */
export function projectLinkedRelationshipTransition(
  inspection: BehaviorInspection,
  change: DeferredBehaviorProposal["changes"][number],
  proposalRef: string,
  playerId: string,
  storedParameterIds: ReadonlySet<string>,
  eligible: ReadonlySet<string>,
):
  NonNullable<LinkedGameEvidence["proposedRelationships"]>[number] | undefined {
  if (change.targetParticipantId !== playerId) return;
  const parameter = inspection.parameters.find(
    (item) =>
      item.parameterId === change.parameterId &&
      item.kind === "relationship" &&
      item.scope === "portable",
  );
  if (!parameter) return;
  const matches = (item: {
    parameterId: string;
    targetParticipantId?: string;
    worldId?: string;
  }) =>
    item.parameterId === change.parameterId &&
    item.targetParticipantId === playerId &&
    !item.worldId;
  const old = inspection.values.find(matches);
  if (!old && storedParameterIds.has(change.parameterId)) return;
  const history = inspection.history.filter(matches);
  if (old && !history.some((entry) => entry.revision === old.revision)) return;
  const baselineEvidenceEventIds = [
    ...new Set(history.flatMap((entry) => entry.evidenceEventIds)),
  ];
  if (
    (old && !baselineEvidenceEventIds.length) ||
    [...baselineEvidenceEventIds, ...change.evidenceEventIds].some(
      (ref) => !eligible.has(ref),
    )
  )
    return;
  const initial = Object.hasOwn(
    inspection.effective.initialValues,
    parameter.parameterId,
  )
    ? inspection.effective.initialValues[parameter.parameterId]
    : parameter.initial;
  const before = old?.value ?? initial;
  const after = Number((before + change.delta).toFixed(6));
  if (after < parameter.min || after > parameter.max) return;
  return {
    proposalRef,
    parameterId: change.parameterId,
    targetParticipantId: playerId,
    status: "uncommitted",
    subjectNpcId: inspection.npcId,
    configRevision: inspection.configRevision,
    stateRevision: inspection.stateRevision,
    proposedStateRevision: inspection.stateRevision + 1,
    before: {
      value: before,
      confidence: old?.confidence ?? null,
      valueRevision: old?.revision ?? null,
    },
    proposedAfter: { value: after, confidence: change.confidence },
    baselineEvidenceEventIds,
    evidenceEventIds: change.evidenceEventIds,
  };
}

export function createGameContinuity(options: {
  principalId: string;
  broker: ReturnType<typeof createGameConnectionBroker>;
  store: ParticipantStore & Partial<GameOutcomeReceipts>;
  workspace: CharacterWorkspace;
  clientFor: (request: LabRunRequest) => Promise<ModelClient>;
  timeoutMs: number;
  reflectionTimeoutMs: number;
  sourceAccess: ReturnType<typeof createBridgeSourcePolicy>["snapshot"];
  promptBudgetFor?: (
    request: LabRunRequest,
  ) =>
    | { bytes: number; ceiling: number; fitsModelInput?: ModelInputBudget }
    | undefined;
}) {
  const operator = { ...DEFAULT_BEHAVIOR_OPERATOR, canEditConfig: true };
  const grants = (memoryId: string) =>
    options.broker.continuityBindings(options.principalId, memoryId);
  function list(memoryId: string) {
    if (!id.test(memoryId)) return [];
    const policy = options.sourceAccess(memoryId);
    return grants(memoryId).map(({ id, binding }) => ({
      id,
      worldId: binding.hostId,
      playerName: binding.player!.name,
      playerScope: digest([memoryId, binding.player!.uuid]),
      scopeRevision: policy.cursorKey,
      characterId: binding.characterId,
      characterName: binding.character.name,
    }));
  }

  async function run(request: LabRunRequest, signal: AbortSignal) {
    const selection = request.gameContext;
    const memoryId = request.memoryCharacterId ?? request.characterId;
    if (
      request.operation !== "chat" ||
      request.provider === "scenario" ||
      !selection ||
      !memoryId ||
      typeof selection.anchor !== "string" ||
      !id.test(selection.anchor) ||
      !Array.isArray(selection.sources) ||
      selection.sources.length > 3 ||
      selection.sources.some(
        (value) => typeof value !== "string" || !id.test(value),
      ) ||
      new Set([selection.anchor, ...selection.sources]).size !==
        selection.sources.length + 1 ||
      typeof request.requestId !== "string" ||
      !id.test(request.requestId) ||
      typeof request.message !== "string" ||
      !request.message.trim() ||
      request.message.length > 4000
    )
      return failure(
        "invalid-document",
        "Choose a valid game conversation context.",
      );

    const ids = [selection.anchor, ...[...selection.sources].sort()];
    const available = grants(memoryId);
    const selected = ids.map((identity) =>
      available.find((item) => item.id === identity),
    );
    const anchor = selected[0]?.binding;
    if (
      !anchor?.player ||
      request.characterId !== anchor.characterId ||
      selected.some(
        (source) =>
          !source ||
          source.binding.player?.uuid !== anchor.player!.uuid ||
          source.binding.characterId !== anchor.characterId,
      )
    )
      return failure(
        "stale-context",
        "This linked game conversation is unavailable.",
      );
    const snapshot = options.workspace.snapshot(request.characterId, memoryId);
    if (!snapshot.ok) return snapshot;
    const sourceAccess = options.sourceAccess(memoryId);
    const validate = () => {
      signal.throwIfAborted();
      try {
        sourceAccess.validate();
      } catch {
        throw new SessionError("stale");
      }
      const current = grants(memoryId);
      if (
        !ids.every((identity) => current.some((grant) => grant.id === identity))
      )
        throw new SessionError("stale");
    };

    const access = { principalId: options.principalId, hostId: anchor.hostId };
    const npcId = "npc-" + digest(memoryId);
    const playerId =
      "player-" + digest([options.principalId, anchor.player.uuid]);
    const linkedWorld = "app-linked-" + digest([ids, sourceAccess.cursorKey]);
    const sessionId = "session-" + linkedWorld;
    const sourceBindings = new Map(
      selected.map((item) => [
        "session-" + item!.binding.connectionId,
        item!.binding.hostId,
      ]),
    );
    const authorizeEvidence: AuthorizeSessionEvidence = (query) =>
      query.access.principalId === access.principalId &&
      query.access.hostId === access.hostId &&
      query.session.sessionId === sessionId &&
      query.npcId === npcId &&
      (query.targetParticipantId === undefined ||
        query.targetParticipantId === playerId) &&
      query.audienceParticipantIds.every(
        (participant) => participant === playerId || participant === npcId,
      ) &&
      (query.sourceSession.sessionId === sessionId ||
        (sourceBindings.get(query.sourceSession.sessionId) ===
          query.sourceSession.hostId &&
          query.sourceSession.worldId === query.sourceSession.hostId &&
          sourceAccess.allows(
            query.sourceSession.worldId,
            query.event.eventId,
          )));

    const participants = createParticipantRuntime(options.store, {
      behaviorOperator: operator,
      authorizeEvidence,
    });
    const behavior = createBehaviorRuntime(options.store, {
      operator,
      authorizeEvidence,
    });
    const eventId =
      "app-linked-input-" + digest([sessionId, request.requestId]);
    const outputEventId =
      "app-linked-output-" + digest([sessionId, request.requestId]);
    const ticket = {
      turnId: "app-linked-turn-" + digest(eventId),
      sessionId,
      revision: 1,
      npcId,
      eventId,
      recipientIds: [playerId],
      observerIds: [],
    };
    let hasTurn = false;
    try {
      validate();
      const deadline = AbortSignal.any([
        signal,
        AbortSignal.timeout(options.timeoutMs),
      ]);
      const validateTurn = () => {
        validate();
        deadline.throwIfAborted();
      };
      const configuration = {
        ...request,
        requestId: "gc-" + digest([sessionId, request.requestId]),
      };
      const startedAt = new Date().toISOString();
      const input = linkedAppConversationInput(
        configuration,
        snapshot.value.persona ?? snapshot.value.character,
        startedAt,
      );
      const conversation = input.request as ConversationRequest;
      const state = options.store.transact(access.principalId, (state) => ({
        sources: state.sessions.filter(
          (row) =>
            sourceBindings.get(row.sessionId) === row.hostId &&
            row.worldId === row.hostId &&
            row.members.some(
              (member) =>
                member.participantId === playerId && member.role === "player",
            ) &&
            row.members.some(
              (member) =>
                member.participantId === npcId && member.role === "npc",
            ),
        ),
        linked: state.sessions.some((row) => row.sessionId === sessionId),
      }));
      if (state.sources.length !== selected.length)
        return failure(
          "stale-context",
          "Connect and speak privately in each selected game first.",
        );
      if (!state.linked) {
        participants.transition(access, "bind-" + sessionId, 0, {
          sessionId,
          revision: 1,
          hostId: access.hostId,
          worldId: linkedWorld,
          recallWorldIds: [
            linkedWorld,
            ...new Set(state.sources.map((source) => source.worldId)),
          ],
          members: [
            { participantId: npcId, role: "npc" },
            { participantId: playerId, role: "player" },
          ],
          groups: [],
          channels: [
            {
              channelId: "app-conversation",
              participantIds: [npcId, playerId],
            },
          ],
        });
      }
      const underlying = await options.clientFor(request);
      const client: ModelClient = {
        id: underlying.id,
        async generate(generation) {
          validateTurn();
          const result = await underlying.generate({
            ...generation,
            signal: AbortSignal.any([
              deadline,
              ...(generation.signal ? [generation.signal] : []),
            ]),
          });
          validateTurn();
          return result;
        },
      };
      let deferred: DeferredBehaviorProposal | undefined;
      const propose = createBehaviorModelProposer(client, request.model, {
        deferReason: true,
      });
      const service = createBehaviorService({
        store: options.store,
        access,
        operator,
        authorizeEvidence,
        validateEvidenceAccess: validateTurn,
        optionalModelReflection: true,
        deferModelReflection: (proposal) => {
          deferred = proposal;
        },
        timeoutMs: options.reflectionTimeoutMs,
        proposer: (projection, reflectionSignal) => {
          const eligible = new Set(
            projection.priorEvidence.map(({ eventId }) => eventId),
          );
          const history = visibleRelationshipHistory(
            behavior.inspect(access, sessionId, npcId).history,
            npcId,
            playerId,
            eligible,
          );
          const parameters = projection.inspection.parameters.filter(
            (parameter) =>
              parameter.kind === "relationship" &&
              parameter.scope === "portable",
          );
          const values = projection.inspection.values.filter(
            (value) =>
              value.targetParticipantId === playerId &&
              history.some(
                (change) =>
                  change.parameterId === value.parameterId &&
                  change.revision === value.revision,
              ),
          );
          return propose(
            {
              ...projection,
              inspection: { ...projection.inspection, parameters, values },
            },
            reflectionSignal,
          );
        },
      });
      await service.observe({
        event: {
          eventId,
          sessionId,
          revision: 1,
          channelId: "app-conversation",
          senderId: playerId,
          recipientIds: [npcId],
          observerIds: [],
          text: request.message,
        },
        kind: classifyBehaviorEvent(request.message),
        npcIds: [npcId],
        strategy: "model",
        signal: deadline,
      });
      validateTurn();
      const turn = participants.begin(access, ticket);
      hasTurn = !turn.output;
      let response: ConversationResponse;
      if (turn.output) {
        response = {
          schemaVersion: "0.4.0",
          kind: "conversation-response",
          binding: conversation.binding,
          requestId: conversation.requestId,
          correlationId: conversation.correlationId,
          channelId: conversation.channelId,
          speakerParticipantId: conversation.speakerParticipantId,
          recipientParticipantIds: conversation.recipientParticipantIds,
          responseId: outputEventId,
          createdAt: startedAt,
          expiresAt: conversation.deadlineAt,
          output: {
            type: "utterance",
            modality: "text",
            content: turn.output.text,
          },
        };
      } else {
        const worlds = new Map(
          state.sources.map((source) => [source.sessionId, source]),
        );
        const connections = new Map(
          selected.map((item) => [
            "session-" + item!.binding.connectionId,
            item!.binding.connectionId,
          ]),
        );
        const participantClaims: LinkedGameEvidence["participantClaims"] = [];
        const companionDialogue: LinkedGameEvidence["companionDialogue"] = [];
        const verifiedHostObservations: LinkedGameEvidence["verifiedHostObservations"] =
          [];
        const eligible = new Set([eventId]);
        for (const event of [...turn.memories].reverse()) {
          if (event.eventId === eventId) continue;
          const world = worlds.get(event.sessionId);
          if (
            (!world && event.sessionId !== sessionId) ||
            (world && !sourceAccess.allows(world.worldId, event.eventId))
          )
            continue;
          const record = {
            eventId: event.eventId,
            worldId: world?.worldId ?? linkedWorld,
            originHostId: world?.hostId ?? access.hostId,
            text: event.text.slice(0, 320),
          };
          if (event.senderId === playerId) {
            participantClaims.push({ ...record, reporterId: playerId });
          } else if (event.senderId === npcId) {
            const connectionId = connections.get(event.sessionId);
            const outcome =
              world &&
              connectionId &&
              event.channelId === "private" &&
              event.recipientIds.length === 1 &&
              event.recipientIds[0] === playerId &&
              event.observerIds.length === 0
                ? options.store.gameOutcome?.(
                    { principalId: access.principalId, hostId: world.hostId },
                    connectionId,
                    event,
                  )
                : undefined;
            if (outcome && world)
              verifiedHostObservations.push({
                ...record,
                reportingHostId: world.hostId,
                actorParticipantId: npcId,
                ...outcome,
              });
            else
              companionDialogue.push({
                ...record,
                speakerParticipantId: npcId,
              });
          } else continue;
          eligible.add(event.eventId);
          if (eligible.size === 13) break;
        }
        const inspection = behavior.inspect(access, sessionId, npcId);
        if (
          deferred &&
          (inspection.configRevision !== deferred.configRevision ||
            inspection.stateRevision !== deferred.expectedStateRevision)
        )
          throw new SessionError("stale");
        const relationships = visibleRelationshipHistory(
          inspection.history,
          npcId,
          playerId,
          eligible,
        )
          .slice(-4)
          .map(
            ({
              npcId: subjectNpcId,
              parameterId,
              targetParticipantId,
              before,
              after,
              revision,
              confidence,
              reason,
              evidenceEventIds,
            }) => ({
              subjectNpcId,
              parameterId,
              targetParticipantId: targetParticipantId!,
              before,
              after,
              recordedRevision: revision,
              confidence,
              reason,
              evidenceEventIds,
            }),
          );
        const storedParameterIds = deferred
          ? options.store.transact(
              access.principalId,
              (state) =>
                new Set(
                  (state.behavior?.values ?? [])
                    .filter(
                      (value) =>
                        value.npcId === npcId &&
                        value.targetParticipantId === playerId &&
                        !value.worldId,
                    )
                    .map((value) => value.parameterId),
                ),
            )
          : new Set<string>();
        const pending = deferred
          ? deferred.changes.flatMap((change, index) => {
              const preview = projectLinkedRelationshipTransition(
                inspection,
                change,
                `p${index + 1}`,
                playerId,
                storedParameterIds,
                eligible,
              );
              return preview ? [{ change, preview }] : [];
            })
          : [];
        let explained: BehaviorProposal | undefined;
        const budget = options.promptBudgetFor?.(request);
        const controller = createModelController({
          client,
          model: request.model,
          recallAnswerability: true,
          linkedGameEvidence: {
            conversationRoles: {
              speakingNpc: {
                participantId: npcId,
                portrayalCharacterId: input.character.characterId,
                portrayalName: input.character.profile.name,
              },
              currentPlayer: {
                participantId: playerId,
                displayName: anchor.player.name,
              },
            },
            currentEventId: eventId,
            currentUtterance: {
              eventId,
              reporterId: playerId,
              source: "participant-claim",
              origin: "app-conversation",
            },
            participantClaims,
            companionDialogue,
            verifiedHostObservations,
            relationships,
            ...(pending.length && {
              proposedRelationships: pending.map(({ preview }) => preview),
            }),
          },
          ...(pending.length && {
            onRelationshipExplanations(
              offeredRefs: ReadonlySet<string>,
              explanations: unknown,
            ) {
              if (
                !deferred ||
                !Array.isArray(explanations) ||
                !explanations.length ||
                explanations.length > offeredRefs.size
              )
                return;
              const reasons = new Map<string, string>();
              for (const entry of explanations) {
                if (
                  !entry ||
                  typeof entry !== "object" ||
                  Object.keys(entry).length !== 2 ||
                  typeof entry.proposalRef !== "string" ||
                  !offeredRefs.has(entry.proposalRef) ||
                  reasons.has(entry.proposalRef) ||
                  typeof entry.reason !== "string" ||
                  !entry.reason.trim() ||
                  entry.reason.length > 220
                )
                  return;
                reasons.set(entry.proposalRef, entry.reason.trim());
              }
              explained = {
                ...deferred,
                changes: pending.flatMap(({ change, preview }) => {
                  const reason = reasons.get(preview.proposalRef);
                  return reason ? [{ ...change, reason }] : [];
                }),
              };
            },
          }),
          promptBudgetBytes: budget?.bytes,
          promptBudgetCeilingBytes: budget?.ceiling,
          fitsModelInput: budget?.fitsModelInput,
        });
        response = (await controller(input, deadline)) as ConversationResponse;
        if (
          response.output.type !== "utterance" ||
          response.output.modality !== "text"
        )
          throw new SessionError("invalid");
        validateTurn();
        const output: AddressedEvent = {
          eventId: outputEventId,
          sessionId,
          revision: 1,
          channelId: "app-conversation",
          senderId: npcId,
          recipientIds: [playerId],
          observerIds: [],
          text: response.output.content,
        };
        options.store.transact(access.principalId, (state) => {
          const onDraft = (draft: ParticipantState): ParticipantStore => ({
            transact(principalId, work) {
              if (principalId !== access.principalId)
                throw new SessionError("unauthorized");
              return work(draft);
            },
          });
          const runtime = createBehaviorRuntime(onDraft(state), {
            operator,
            authorizeEvidence,
          });
          if (deferred) {
            const current = runtime.inspect(access, sessionId, npcId);
            if (
              current.configRevision !== deferred.configRevision ||
              current.stateRevision !== deferred.expectedStateRevision
            )
              throw new SessionError("stale");
          }
          if (explained?.changes.length) {
            const scratch = structuredClone(state);
            try {
              createBehaviorRuntime(onDraft(scratch), {
                operator,
                authorizeEvidence,
              }).apply(access, explained, Date.now());
              Object.assign(state, scratch);
            } catch (error) {
              if (
                !(error instanceof SessionError) ||
                (error.code !== "invalid" && error.code !== "conflict")
              )
                throw error;
            }
          }
          createParticipantRuntime(onDraft(state), {
            behaviorOperator: operator,
            authorizeEvidence,
          }).complete(access, ticket, output);
          runtime.observe(
            access,
            sessionId,
            npcId,
            output.eventId,
            "observation",
          );
        });
        hasTurn = false;
      }
      validateTurn();
      const completedAt = new Date().toISOString();
      const run: LabRun = {
        requestId: request.requestId,
        operation: "chat",
        message: request.message,
        provider: request.provider,
        model: request.model,
        startedAt,
        completedAt,
        status: "completed",
        stages: [],
        selectedMemoryIds: [],
        result: {
          type: "chat",
          response,
          delivery: {
            schemaVersion: "0.4.0",
            kind: "conversation-delivery",
            binding: response.binding,
            requestId: response.requestId,
            responseId: response.responseId,
            correlationId: response.correlationId,
            channelId: response.channelId,
            deliveryId: "delivery-" + digest(outputEventId),
            recordedAt: completedAt,
            status: "delivered",
          },
        },
      };
      return success({
        ...snapshot.value,
        runs: [run],
        run,
        stages: run.stages,
        result: run.result,
      });
    } catch (error) {
      if (hasTurn) {
        try {
          participants.cancel(access, ticket);
        } catch {}
      }
      if (
        signal.aborted ||
        (error instanceof SessionError &&
          ["stale", "unauthorized"].includes(error.code))
      )
        return failure(
          "stale-context",
          "This linked game conversation is unavailable.",
        );
      if (
        error instanceof ProviderControllerError &&
        ["insufficient-evidence", "clarify-recall"].includes(error.code)
      ) {
        validate();
        return {
          ok: false as const,
          error: {
            code: error.code,
            message: error.message,
          },
        };
      }
      return failure(
        "controller-failed",
        "The linked conversation could not finish. Try again.",
      );
    }
  }
  return { list, run };
}
