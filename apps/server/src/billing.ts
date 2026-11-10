/** Neutral customer billing capability supplied by the service operator. */
export interface CustomerTariff {
  version: string;
  model: string;
  inputMicrodollarsPerMillion: number;
  outputMicrodollarsPerMillion: number;
  requestMicrodollars: number;
}
export interface SpendingLimits {
  revision: number;
  dailyMicrodollars: number;
  sessionMicrodollars: number;
  paused: boolean;
}
export interface BillingExpense {
  id: string;
  at: number;
  model: string;
  category: string;
  npcId?: string;
  gameId?: string;
  sessionId?: string;
  state: "held" | "settled" | "released" | "unknown";
  reservedMicrodollars: number;
  chargedMicrodollars: number;
  inputTokens?: number;
  outputTokens?: number;
  accounting?: "measured" | "estimated";
}
export interface BillingSnapshot {
  version: "ifsoul-billing-view/0.4.0";
  currency: "USD";
  availableMicrodollars: number;
  reservedMicrodollars: number;
  promotionalMicrodollars: number;
  spentMicrodollars: number;
  limits: SpendingLimits;
  tariffs: CustomerTariff[];
  expenses: BillingExpense[];
}
export interface BillingPort {
  read(): Promise<BillingSnapshot>;
  updateLimits(value: SpendingLimits): Promise<BillingSnapshot>;
}
/** Customer estimate and billing use the same final rates; no payment is performed here. */
export function estimateCustomerCost(
  tariff: CustomerTariff,
  inputTokens: number,
  outputTokens: number,
  calls = 1,
) {
  if (
    ![
      inputTokens,
      outputTokens,
      calls,
      tariff.inputMicrodollarsPerMillion,
      tariff.outputMicrodollarsPerMillion,
      tariff.requestMicrodollars,
    ].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    throw Error("Invalid estimate");
  const total =
    (BigInt(inputTokens) * BigInt(tariff.inputMicrodollarsPerMillion) +
      BigInt(outputTokens) * BigInt(tariff.outputMicrodollarsPerMillion) +
      999999n) /
      1000000n +
    BigInt(calls) * BigInt(tariff.requestMicrodollars);
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error("Estimate exceeds supported range");
  return Number(total);
}
