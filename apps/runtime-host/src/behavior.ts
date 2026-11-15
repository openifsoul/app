import { createHash } from "node:crypto";
import {
  createBehaviorRuntime,
  behaviorEvidenceVisible,
  createParticipantRuntime,
  DEFAULT_BEHAVIOR_OPERATOR,
  SessionError,
} from "@ifsoul/core/runtime";
import type {
  ParticipantStore,
  SessionAccess,
  BehaviorOperatorPolicy,
  BehaviorConfiguration,
  BehaviorEditorSnapshot,
  BehaviorInspection,
  BehaviorProposal,
  BehaviorEventKind,
  AddressedEvent,
  AuthorizeSessionEvidence,
  BehaviorLimits,
} from "@ifsoul/core/runtime";
import type { BehaviorHostPort } from "@ifsoul/adapter-sdk";
import type { ModelClient } from "@ifsoul/core/model-providers/types";
import { modelReplyLanguagePolicy } from "./service.js";

export type DeferredBehaviorProposal = Omit<BehaviorProposal, "changes"> & {
  changes: Omit<BehaviorProposal["changes"][number], "reason">[];
};

export interface BehaviorReflectionInput {
  inspection: BehaviorInspection;
  event: AddressedEvent;
  kind: BehaviorEventKind;
  priorEvidence: {
    eventId: string;
    worldId: string;
    reporterId: string;
    source: "participant-claim";
    text: string;
  }[];
}
export function createBehaviorService(options: {
  store: ParticipantStore;
  access: SessionAccess;
  operator?: BehaviorOperatorPolicy;
  now?: () => number;
  limits?: Partial<BehaviorLimits>;
  ceilings?: Partial<BehaviorLimits>;
  authorizeEvidence?: AuthorizeSessionEvidence;
  validateEvidenceAccess?: () => void;
  optionalModelReflection?: boolean;
  deferModelReflection?: (proposal: DeferredBehaviorProposal) => void;
  proposer?: (
    input: BehaviorReflectionInput,
    signal: AbortSignal,
  ) => Promise<unknown>;
  timeoutMs?: number;
}) {
  const access = structuredClone(options.access),
    operator = structuredClone(options.operator ?? DEFAULT_BEHAVIOR_OPERATOR);
  const runtime = createBehaviorRuntime(options.store, {
    operator,
    limits: options.limits,
    ceilings: options.ceilings,
    authorizeEvidence: options.authorizeEvidence,
  });
  const participants = createParticipantRuntime(options.store, {
    behaviorOperator: operator,
    authorizeEvidence: options.authorizeEvidence,
  });
  const timeout = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000)
    throw new RangeError("Invalid behavior reflection deadline");
  const port: BehaviorHostPort<
    BehaviorEditorSnapshot,
    BehaviorConfiguration,
    BehaviorInspection
  > = {
    async read() {
      return runtime.read(access);
    },
    async update(request) {
      if (
        !request ||
        Object.keys(request).some(
          (k) => !["expectedRevision", "config"].includes(k),
        )
      )
        throw new SessionError("invalid");
      runtime.update(access, request.expectedRevision, request.config);
      return runtime.read(access);
    },
    async inspect(request) {
      return operator.canEditConfig
        ? runtime.adminInspect(access, request.sessionId, request.npcId)
        : runtime.inspect(access, request.sessionId, request.npcId);
    },
  };
  async function observe(request: {
    event: AddressedEvent;
    kind: BehaviorEventKind;
    npcIds: string[];
    strategy?: "rules" | "model";
    signal?: AbortSignal;
  }) {
    // Host evidence is durable independently of whether an NPC may perceive/recall/react to it.
    if (
      !Array.isArray(request.npcIds) ||
      request.npcIds.length > 64 ||
      new Set(request.npcIds).size !== request.npcIds.length
    )
      throw new SessionError("invalid");
    options.validateEvidenceAccess?.();
    participants.append(access, request.event);
    const results: {
      npcId: string;
      status: "updated" | "recorded" | "replay";
      inspection: BehaviorInspection;
    }[] = [];
    for (const npcId of request.npcIds) {
      const observed = runtime.observe(
        access,
        request.event.sessionId,
        npcId,
        request.event.eventId,
        request.kind,
      );
      const inspection = runtime.inspect(
        access,
        request.event.sessionId,
        npcId,
      );
      if (!observed.fresh) {
        results.push({ npcId, status: "replay", inspection });
        continue;
      }
      const eligibleParameters = inspection.parameters.filter(
        (p) =>
          p.kind === "state" ||
          (p.kind === "relationship" &&
            observed.observation.permissions.updateRelationship &&
            request.event.senderId !== npcId),
      );
      if (
        !observed.observation.permissions.observe ||
        !eligibleParameters.length
      ) {
        results.push({ npcId, status: "recorded", inspection });
        continue;
      }
      const proposalId = `reflection-${createHash("sha256")
        .update(JSON.stringify([request.event.eventId, npcId]))
        .digest("hex")
        .slice(0, 32)}`;
      let proposal: unknown;
      const optionalReflection =
        request.strategy === "model" && options.optionalModelReflection;
      const recordWithoutReflection = () => {
        options.validateEvidenceAccess?.();
        request.signal?.throwIfAborted();
        results.push({ npcId, status: "recorded", inspection });
      };
      let approvedEvidenceIds = new Set([request.event.eventId]);
      if (request.strategy === "model" && options.proposer) {
        const targetId = request.event.senderId;
        const priorEvidence =
          targetId === npcId
            ? []
            : options.store.transact(access.principalId, (state) => {
                const current = state.sessions.find(
                  (entry) => entry.sessionId === request.event.sessionId,
                )!;
                const recallable = new Map(
                  state.sessions
                    .filter(
                      (entry) =>
                        (entry.hostId === access.hostId ||
                          options.authorizeEvidence !== undefined) &&
                        current.recallWorldIds.includes(entry.worldId),
                    )
                    .map((entry) => [entry.sessionId, entry.worldId]),
                );
                return state.events
                  .filter(
                    (event) =>
                      event.eventId !== request.event.eventId &&
                      recallable.has(event.sessionId) &&
                      event.observerIds.length === 0 &&
                      event.recipientIds.length === 1 &&
                      ((event.senderId === targetId &&
                        event.recipientIds[0] === npcId) ||
                        (event.senderId === npcId &&
                          event.recipientIds[0] === targetId)) &&
                      behaviorEvidenceVisible(
                        state,
                        access,
                        npcId,
                        current.sessionId,
                        event.eventId,
                        operator,
                        {
                          authorizeEvidence: options.authorizeEvidence,
                          purpose: "relationship-evidence",
                          targetParticipantId: targetId,
                          audienceParticipantIds: [targetId],
                        },
                      ),
                  )
                  .slice(-8)
                  .map((event) => ({
                    eventId: event.eventId,
                    worldId: recallable.get(event.sessionId)!,
                    reporterId: event.senderId,
                    source: "participant-claim" as const,
                    text: event.text.slice(0, 512),
                  }));
              });
        approvedEvidenceIds = new Set([
          request.event.eventId,
          ...priorEvidence.map((event) => event.eventId),
        ]);
        const timer = AbortSignal.timeout(timeout);
        const signal = request.signal
          ? AbortSignal.any([request.signal, timer])
          : timer;
        let abort = () => {};
        try {
          options.validateEvidenceAccess?.();
          proposal = await Promise.race([
            options.proposer(
              {
                inspection: {
                  ...inspection,
                  parameters: eligibleParameters,
                  history: [],
                  values: inspection.values.filter(
                    (v) =>
                      !v.targetParticipantId ||
                      v.targetParticipantId === request.event.senderId,
                  ),
                },
                event: {
                  ...request.event,
                  recipientIds: [npcId],
                  observerIds: [],
                },
                kind: request.kind,
                priorEvidence,
              },
              signal,
            ),
            new Promise<never>((_, reject) => {
              abort = () =>
                reject(new DOMException("Reflection timed out", "AbortError"));
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            }),
          ]);
        } catch (error) {
          if (
            !optionalReflection ||
            (error instanceof SessionError &&
              (error.code === "unauthorized" || error.code === "stale"))
          )
            throw error;
          recordWithoutReflection();
          continue;
        } finally {
          signal.removeEventListener("abort", abort);
        }
      } else {
        const delta =
          request.kind === "provocation"
            ? -1
            : request.kind === "helpful"
              ? 1
              : 0;
        const changes = eligibleParameters
          .filter(
            (p) =>
              p.kind === "relationship" &&
              ["trust", "cooperation", "caution"].includes(p.parameterId),
          )
          .flatMap((p) => {
            const direction = p.parameterId === "caution" ? -delta : delta;
            if (!direction) return [];
            const current =
              inspection.values.find(
                (v) =>
                  v.parameterId === p.parameterId &&
                  v.targetParticipantId === request.event.senderId,
              )?.value ??
              inspection.effective.initialValues[p.parameterId] ??
              p.initial;
            const amount =
              direction *
              Math.min(
                p.maxDelta,
                Math.abs(direction),
                direction > 0 ? p.max - current : current - p.min,
              );
            return [
              {
                parameterId: p.parameterId,
                targetParticipantId: request.event.senderId,
                delta: amount,
                confidence: 0.8,
                evidenceEventIds: [request.event.eventId],
                reason:
                  request.kind === "provocation"
                    ? "Observed a host-classified provocation"
                    : "Observed a host-classified helpful event",
              },
            ];
          });
        proposal = {
          proposalId,
          npcId,
          sessionId: request.event.sessionId,
          configRevision: inspection.configRevision,
          expectedStateRevision: inspection.stateRevision,
          changes,
        };
      }
      if (
        !proposal ||
        typeof proposal !== "object" ||
        !Array.isArray((proposal as BehaviorProposal).changes)
      ) {
        if (!optionalReflection) throw new SessionError("invalid");
        recordWithoutReflection();
        continue;
      }
      if (!(proposal as BehaviorProposal).changes.length) {
        recordWithoutReflection();
        continue;
      }
      // Identity, evidence, configuration and state revisions are fixed by the host; models may propose deltas only.
      const output = proposal as BehaviorProposal;
      if (
        output.npcId !== npcId ||
        output.sessionId !== request.event.sessionId ||
        output.configRevision !== inspection.configRevision ||
        output.expectedStateRevision !== inspection.stateRevision ||
        output.changes.some(
          (change) =>
            !Array.isArray(change?.evidenceEventIds) ||
            !change.evidenceEventIds.includes(request.event.eventId) ||
            change.evidenceEventIds.some(
              (eventId) => !approvedEvidenceIds.has(eventId),
            ),
        )
      ) {
        if (!optionalReflection) throw new SessionError("unauthorized");
        recordWithoutReflection();
        continue;
      }
      options.validateEvidenceAccess?.();
      request.signal?.throwIfAborted();
      if (request.strategy === "model" && options.deferModelReflection) {
        options.deferModelReflection({ ...output, proposalId });
        recordWithoutReflection();
        continue;
      }
      try {
        results.push({
          npcId,
          status: "updated",
          inspection: runtime.apply(
            access,
            { ...output, proposalId },
            (options.now ?? Date.now)(),
          ),
        });
      } catch (error) {
        if (
          !optionalReflection ||
          !(error instanceof SessionError) ||
          (error.code !== "invalid" && error.code !== "conflict")
        )
          throw error;
        recordWithoutReflection();
      }
    }
    return results;
  }
  return {
    port,
    observe,
    permissions(sessionId: string, npcId: string, eventId: string) {
      const inspection = runtime.inspect(access, sessionId, npcId);
      const original = options.store.transact(access.principalId, (s) =>
        s.behavior?.observations.find(
          (o) => o.eventId === eventId && o.npcId === npcId,
        ),
      );
      const current =
        inspection.effective.policy[
          original?.kind === "provocation" ? "provocation" : "general"
        ];
      return {
        ...current,
        observe: current.observe && !!original?.permissions.observe,
      };
    },
    inspect: (sessionId: string, npcId: string) =>
      runtime.inspect(access, sessionId, npcId),
    decay: (sessionId: string, npcId: string) =>
      runtime.decay(access, sessionId, npcId, (options.now ?? Date.now)()),
    operator: structuredClone(operator),
  };
}
/** Bounded source-grounded reflection through the existing ModelClient port. */
const deltaIntentRatios = new Map([
  ["-100%", -1],
  ["-75%", -0.75],
  ["-50%", -0.5],
  ["-25%", -0.25],
  ["0%", 0],
  ["+25%", 0.25],
  ["+50%", 0.5],
  ["+75%", 0.75],
  ["+100%", 1],
]);

export function createBehaviorModelProposer(
  client: ModelClient,
  model: string,
  options: { deferReason?: boolean } = {},
) {
  return async (
    input: BehaviorReflectionInput,
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (!input.inspection.parameters.some((p) => p.kind !== "trait"))
      return {
        proposalId: "no-mutable-parameters",
        npcId: input.inspection.npcId,
        sessionId: input.inspection.sessionId,
        configRevision: input.inspection.configRevision,
        expectedStateRevision: input.inspection.stateRevision,
        changes: [],
      };
    const {
      npcId,
      sessionId,
      configRevision,
      stateRevision,
      parameters,
      values,
      effective,
    } = input.inspection;
    const mutableParameters = parameters.filter((p) => p.kind !== "trait");
    if (
      mutableParameters.some(
        (p) => !Number.isFinite(p.maxDelta) || p.maxDelta <= 0,
      )
    )
      throw new SessionError("invalid");
    const maximumDeltas = new Map(
      mutableParameters.map((p) => [p.parameterId, p.maxDelta]),
    );
    const priorEvidenceIds = new Set(
      input.priorEvidence
        .map((event) => event.eventId)
        .filter((id) => id !== input.event.eventId),
    );
    const response = await client.generate({
      model,
      signal,
      system:
        "Return a JSON object containing only changes. Propose bounded relationship or transient-state changes when the current report supports them. Choose deltaIntent as a signed percentage of the selected parameter’s maxDelta. Use currentEventId for the current turn that prompted the reassessment. Select only relevant historical support in priorEvidenceIds. The current turn does not verify an earlier claim. reporterId is the speaker, not necessarily the person who acted. Participant claims are unverified, including corrections. Record uncertainty when accounts disagree. Confidence describes certainty of the interpretation, independently of the parameter value. " +
        (options.deferReason
          ? ""
          : "Explain what the latestUserMessage changes in a short reason in that message’s language. ") +
        "Preserve names and places exactly. Return changes=[] when evidence is insufficient. " +
        modelReplyLanguagePolicy(),
      prompt: JSON.stringify({
        inspection: {
          npcId,
          sessionId,
          configRevision,
          stateRevision,
          parameters,
          values,
          initialValues: effective.initialValues,
        },
        kind: input.kind,
        priorEvidence: input.priorEvidence,
        event: {
          eventId: input.event.eventId,
          reporterId: input.event.senderId,
          source: "participant-claim",
        },
        latestUserMessage: input.event.text,
      }),
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["changes"],
        properties: {
          changes: {
            type: "array",
            maxItems: 8,
            items: {
              anyOf: mutableParameters.map((p) => ({
                type: "object",
                additionalProperties: false,
                required: [
                  "parameterId",
                  "deltaIntent",
                  "confidence",
                  "currentEventId",
                  "priorEvidenceIds",
                  ...(options.deferReason ? [] : ["reason"]),
                  ...(p.kind === "relationship" ? ["targetParticipantId"] : []),
                ],
                properties: {
                  parameterId: { const: p.parameterId },
                  ...(p.kind === "relationship"
                    ? { targetParticipantId: { const: input.event.senderId } }
                    : {}),
                  deltaIntent: {
                    type: "string",
                    enum: [...deltaIntentRatios.keys()],
                  },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  currentEventId: { const: input.event.eventId },
                  priorEvidenceIds: {
                    type: "array",
                    items: {
                      type: "string",
                      ...(priorEvidenceIds.size && {
                        enum: [...priorEvidenceIds],
                      }),
                    },
                    maxItems: priorEvidenceIds.size,
                    uniqueItems: true,
                  },
                  ...(!options.deferReason && {
                    reason: { type: "string", minLength: 1, maxLength: 220 },
                  }),
                },
              })),
            },
          },
        },
      },
    });
    if (!response.ok) throw Error("Behavior reflection unavailable");
    const value = response.value as { content?: unknown };
    const raw =
      typeof value?.content === "string"
        ? JSON.parse(value.content)
        : response.value;
    type ModelChange = Omit<
      BehaviorProposal["changes"][number],
      "evidenceEventIds" | "delta" | "reason"
    > & {
      reason?: string;
      deltaIntent: string;
      currentEventId: string;
      priorEvidenceIds: string[];
    };
    const changes = (raw as { changes?: ModelChange[] } | undefined)?.changes;
    if (
      !raw ||
      typeof raw !== "object" ||
      Object.keys(raw).length !== 1 ||
      !Array.isArray(changes) ||
      changes.some(
        (change) =>
          !change ||
          (options.deferReason
            ? Object.hasOwn(change, "reason") ||
              change.targetParticipantId !== input.event.senderId ||
              Object.keys(change).some(
                (key) =>
                  ![
                    "parameterId",
                    "targetParticipantId",
                    "deltaIntent",
                    "confidence",
                    "currentEventId",
                    "priorEvidenceIds",
                  ].includes(key),
              ) ||
              !Number.isFinite(change.confidence) ||
              change.confidence < 0 ||
              change.confidence > 1
            : typeof change.reason !== "string" ||
              !change.reason.trim() ||
              change.reason.length > 220) ||
          change.currentEventId !== input.event.eventId ||
          !Array.isArray(change.priorEvidenceIds) ||
          new Set(change.priorEvidenceIds).size !==
            change.priorEvidenceIds.length ||
          change.priorEvidenceIds.some((id) => !priorEvidenceIds.has(id)) ||
          Object.hasOwn(change, "evidenceEventIds") ||
          Object.hasOwn(change, "delta"),
      )
    )
      throw new SessionError("invalid");
    return {
      proposalId: "model-reflection",
      npcId,
      sessionId,
      configRevision,
      expectedStateRevision: stateRevision,
      changes: changes.map(
        ({ currentEventId, priorEvidenceIds, deltaIntent, ...change }) => {
          const ratio = deltaIntentRatios.get(deltaIntent);
          const maxDelta = maximumDeltas.get(change.parameterId);
          if (ratio === undefined || maxDelta === undefined)
            throw new SessionError("invalid");
          return {
            ...change,
            delta: ratio * maxDelta,
            evidenceEventIds: [currentEventId, ...priorEvidenceIds],
          };
        },
      ),
    } satisfies DeferredBehaviorProposal;
  };
}
/** Small host-owned classifier for App chat; classification is not model authority. */
export function classifyBehaviorEvent(text: string): BehaviorEventKind {
  if (
    /\b(idiot|stupid|insult|threaten|provocation)\b|идиот|дурак|провокац/i.test(
      text,
    )
  )
    return "provocation";
  if (
    /\b(help(?:ed|ful)?|thank(?:s| you)|assist(?:ed)?)\b|помог|спасибо/i.test(
      text,
    )
  )
    return "helpful";
  return "observation";
}
