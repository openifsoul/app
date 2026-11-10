import type {
  BillingSnapshot,
  SpendingLimits,
  CustomerTariff,
  BillingExpense,
} from "../../../server/src/billing";
import { api, ApiError } from "./api";
export type { BillingSnapshot, SpendingLimits, CustomerTariff, BillingExpense };
export type BillingCapability =
  { available: false } | ({ available: true } & BillingSnapshot);
export interface CustomerEstimate {
  microdollars: number;
  tariffVersion: string;
}
export const readBilling = (signal?: AbortSignal) =>
  api<BillingCapability>("billing", { signal });
export const updateSpendingLimits = (limits: SpendingLimits) =>
  api<BillingSnapshot>("billing/limits", { method: "PUT", body: limits });
export const estimateBilling = (
  model: string,
  inputTokens: number,
  outputTokens: number,
  calls: number,
  signal?: AbortSignal,
) =>
  api<CustomerEstimate>(
    `billing/estimate?${new URLSearchParams({ model, inputTokens: String(inputTokens), outputTokens: String(outputTokens), calls: String(calls) })}`,
    { signal },
  );
/** Amounts are customer-facing integer microdollars; preserve all six decimal places. */
export function dollarsInput(microdollars: number): string {
  if (!Number.isSafeInteger(microdollars) || microdollars < 0) return "";
  const amount = BigInt(microdollars);
  return `${amount / 1000000n}.${String(amount % 1000000n).padStart(6, "0")}`;
}
export function customerUSD(microdollars: number): string {
  const amount = dollarsInput(microdollars);
  return amount ? `$${amount}` : "Unavailable";
}
export function parseDollars(value: string): number | null {
  if (!/^\d{1,16}(?:\.\d{0,6})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}
export function billingError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "unavailable";
  if (code === "conflict" || code === "stale")
    return "The saved limits changed or exceed this service’s allowed amounts. Your draft is preserved. Reload the saved limits and check the values.";
  if (code === "unauthorized" || code === "forbidden")
    return "Your billing access is unavailable. Sign in again or contact the service owner.";
  if (code === "invalid" || code === "invalid-request")
    return "Check the workload or amount values, then try again.";
  if (code === "network" || code === "timeout")
    return "Billing did not respond. Your draft is preserved; try again when the connection returns.";
  return "Billing is unavailable on this service. Retry or contact the service owner.";
}
