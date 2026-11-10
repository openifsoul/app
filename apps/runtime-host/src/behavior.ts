import { createHash } from "node:crypto";
import {
  createBehaviorRuntime,
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
  BehaviorLimits,
} from "@ifsoul/core/runtime";
import type { BehaviorHostPort } from "@ifsoul/adapter-sdk";
import type { ModelClient } from "@ifsoul/core/model-providers/types";

export interface BehaviorReflectionInput {
  inspection: BehaviorInspection;
  event: AddressedEvent;
  kind: BehaviorEventKind;
}
export function createBehaviorService(options: {
  store: ParticipantStore;
  access: SessionAccess;
  operator?: BehaviorOperatorPolicy;
  now?: () => number;
  limits?: Partial<BehaviorLimits>;
  ceilings?: Partial<BehaviorLimits>;
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
  });
  const participants = createParticipantRuntime(options.store, {
    behaviorOperator: operator,
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
  }) {
    // Host evidence is durable independently of whether an NPC may perceive/recall/react to it.
    if (
      !Array.isArray(request.npcIds) ||
      request.npcIds.length > 64 ||
      new Set(request.npcIds).size !== request.npcIds.length
    )
      throw new SessionError("invalid");
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
      if (request.strategy === "model" && options.proposer) {
        const signal = AbortSignal.timeout(timeout);
        let abort = () => {};
        try {
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
      )
        throw new SessionError("invalid");
      if (!(proposal as BehaviorProposal).changes.length) {
        results.push({ npcId, status: "recorded", inspection });
        continue;
      }
      // Identity, evidence, configuration and state revisions are fixed by the host; models may propose deltas only.
      const output = proposal as BehaviorProposal;
      if (
        output.npcId !== npcId ||
        output.sessionId !== request.event.sessionId ||
        output.configRevision !== inspection.configRevision ||
        output.expectedStateRevision !== inspection.stateRevision
      )
        throw new SessionError("unauthorized");
      results.push({
        npcId,
        status: "updated",
        inspection: runtime.apply(
          access,
          { ...output, proposalId },
          (options.now ?? Date.now)(),
        ),
      });
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
export function createBehaviorModelProposer(
  client: ModelClient,
  model: string,
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
    const response = await client.generate({
      model,
      signal,
      system:
        "Return only a JSON BehaviorProposal. Propose bounded relationship or transient-state deltas from the supplied evidence. Never change policy, goals, capabilities, stable traits, identities or host game state. Confidence is separate from value. Return changes=[] when evidence is insufficient.",
      prompt: JSON.stringify(input),
      schema: {
        type: "object",
        additionalProperties: false,
        required: [
          "proposalId",
          "npcId",
          "sessionId",
          "configRevision",
          "expectedStateRevision",
          "changes",
        ],
        properties: {
          proposalId: { type: "string" },
          npcId: { const: input.inspection.npcId },
          sessionId: { const: input.inspection.sessionId },
          configRevision: { const: input.inspection.configRevision },
          expectedStateRevision: { const: input.inspection.stateRevision },
          changes: {
            type: "array",
            maxItems: 8,
            items: {
              anyOf: input.inspection.parameters
                .filter((p) => p.kind !== "trait")
                .map((p) => ({
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "parameterId",
                    "delta",
                    "confidence",
                    "evidenceEventIds",
                    "reason",
                    ...(p.kind === "relationship"
                      ? ["targetParticipantId"]
                      : []),
                  ],
                  properties: {
                    parameterId: { const: p.parameterId },
                    ...(p.kind === "relationship"
                      ? { targetParticipantId: { const: input.event.senderId } }
                      : {}),
                    delta: {
                      type: "number",
                      minimum: -p.maxDelta,
                      maximum: p.maxDelta,
                    },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    evidenceEventIds: {
                      type: "array",
                      items: { const: input.event.eventId },
                      minItems: 1,
                      maxItems: 1,
                    },
                    reason: { type: "string", minLength: 1, maxLength: 512 },
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
    return raw;
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
