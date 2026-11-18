import type { GameBinding } from "./game-connections.js";

export type AdventureDecision =
  | { kind: "reply" | "status" }
  | { kind: "exchange" | "return" }
  | { kind: "gather"; resource: string; count: number };

export function gatherChoices(bindings: GameBinding[]) {
  return bindings.flatMap((binding) => {
    const snapshot = binding.capability;
    const descriptor = snapshot?.manifest.capabilities.find(
      (row) =>
        row.intentId === "minecraft.gather-logs" &&
        row.support !== "unsupported" &&
        row.readiness === "ready",
    );
    if (
      !snapshot ||
      binding.capabilityOffline ||
      !descriptor ||
      !snapshot.allowedIntentIds.includes(descriptor.intentId)
    )
      return [];
    const resource = descriptor.parameters.find(
      (param) => param.name === "resource" && param.type === "choice",
    );
    const count = descriptor.parameters.find(
      (param) => param.name === "count" && param.type === "quantity",
    );
    if (
      !resource?.choices?.length ||
      !count ||
      count.minimum === undefined ||
      count.maximum === undefined
    )
      return [];
    return [
      {
        binding,
        snapshot,
        descriptor,
        resources: resource.choices,
        minimum: count.minimum,
        maximum: count.maximum,
      },
    ];
  });
}

export function returnChoices(bindings: GameBinding[]) {
  return bindings.flatMap((binding) => {
    const snapshot = binding.capability;
    if (!snapshot || binding.capabilityOffline) return [];
    const descriptor = snapshot.manifest.capabilities.find(
      (row) =>
        row.intentId === "minecraft.return-from-forest" &&
        row.support !== "unsupported" &&
        row.readiness === "ready",
    );
    return descriptor && snapshot.allowedIntentIds.includes(descriptor.intentId)
      ? [{ binding, snapshot, descriptor }]
      : [];
  });
}

export interface AdventureFact {
  operationId: string;
  intentId: string;
  status:
    "offered" | "progress" | "succeeded" | "partial" | "failed" | "cancelled";
  at: number;
  issuedAt?: number;
  late?: boolean;
  count?: number;
}
export function validAdventureFact(value: unknown): value is AdventureFact {
  if (!value || typeof value !== "object") return false;
  const fact = value as Partial<AdventureFact>;
  return (
    typeof fact.operationId === "string" &&
    ["minecraft.gather-logs", "minecraft.return-from-forest"].includes(
      String(fact.intentId),
    ) &&
    [
      "offered",
      "progress",
      "succeeded",
      "partial",
      "failed",
      "cancelled",
    ].includes(String(fact.status)) &&
    Number.isFinite(fact.at) &&
    (fact.issuedAt === undefined || Number.isFinite(fact.issuedAt)) &&
    (fact.late === undefined || typeof fact.late === "boolean") &&
    (fact.count === undefined ||
      (Number.isSafeInteger(fact.count) && fact.count >= 0 && fact.count <= 32))
  );
}
export const adventureTones = ["direct", "warm", "wry", "playful"] as const;
export type AdventureTone = (typeof adventureTones)[number];

export function adventureFactLine(
  facts: AdventureFact[],
  tone: AdventureTone,
  russian: boolean,
  observed?: { actor: string; fact: AdventureFact },
) {
  const phrases = russian
    ? {
        direct: "Вот что известно.",
        warm: "Расскажу, что знаю.",
        wry: "Ну вот.",
        playful: "Хи-хи.",
      }
    : {
        direct: "Here is what I know.",
        warm: "I can share what I know.",
        wry: "Well, then.",
        playful: "Hee-hee.",
      };
  const operations = new Map<
    string,
    { startedAt: number; latest: AdventureFact }
  >();
  for (const fact of facts) {
    const known = operations.get(fact.operationId);
    if (!known) {
      operations.set(fact.operationId, {
        startedAt: fact.issuedAt ?? fact.at,
        latest: fact,
      });
      continue;
    }
    if (
      fact.at >= known.latest.at &&
      ((!fact.late && fact.status !== "progress") ||
        ["offered", "progress"].includes(known.latest.status))
    ) {
      known.latest = { ...fact, count: fact.count ?? known.latest.count };
    }
  }
  const latestByIntent = new Map<
    string,
    { startedAt: number; latest: AdventureFact }
  >();
  for (const operation of operations.values()) {
    const previous = latestByIntent.get(operation.latest.intentId);
    if (!previous || previous.startedAt <= operation.startedAt)
      latestByIntent.set(operation.latest.intentId, operation);
  }
  const labels = russian
    ? {
        offered: "результат неизвестен",
        progress: "ещё в работе",
        succeeded: "выполнено",
        partial: "выполнено частично",
        failed: "не удалось",
        cancelled: "отменено",
      }
    : {
        offered: "outcome unknown",
        progress: "in progress",
        succeeded: "completed",
        partial: "partially completed",
        failed: "failed",
        cancelled: "cancelled",
      };
  const details = [...latestByIntent.values()].map(({ latest: fact }) => {
    const returning = fact.intentId === "minecraft.return-from-forest";
    const action = russian
      ? returning
        ? "Моё возвращение"
        : "Мой сбор"
      : returning
        ? "My return"
        : "My gathering";
    const count = returning
      ? ""
      : fact.count === undefined
        ? russian
          ? ", число брёвен неизвестно"
          : ", log count unknown"
        : russian
          ? `, собрано брёвен: ${fact.count}`
          : `, logs collected: ${fact.count}`;
    return `${action} — ${labels[fact.status]}${count}.`;
  });
  const shared =
    observed &&
    (russian
      ? `В отчёте ${observed.actor}: ${labels[observed.fact.status]}.`
      : `I saw ${observed.actor}'s report: ${labels[observed.fact.status]}.`);
  const own = [
    phrases[tone],
    ...(details.length
      ? details
      : [
          russian
            ? "У меня пока нет подтверждённого результата."
            : "I have no verified outcome yet.",
        ]),
  ].join(" ");
  return shared && own.length + shared.length + 1 <= 180
    ? own + " " + shared
    : own;
}

// A response that hits the schema boundary without a sentence ending is
// likely clipped. Short natural utterances need no closing punctuation.
export function clippedAdventureSpeech(
  raw: string,
  normalized: string,
  limit: number,
) {
  return (
    (raw.length >= limit || normalized.length >= limit) &&
    !/[.!?…。！？؟।][»”’"'\)\]】）]*$/u.test(normalized)
  );
}

// This detects task references for factual presentation only. The planner and
// existing capability checks still decide whether an action can be issued.
export function referencedAdventureIntents(text: string) {
  return [
    ...(/верн|возвращ|покин|уйти из лес|return|head back|go back/iu.test(text)
      ? ["minecraft.return-from-forest"]
      : []),
    ...(/сбор|собра|собер|бр[её]в|gather|collect|logs/iu.test(text)
      ? ["minecraft.gather-logs"]
      : []),
  ];
}
