import type {
  BehaviorConfiguration,
  BehaviorEditorSnapshot,
  BehaviorInspection,
} from "@ifsoul/core/runtime";
import { api, ApiError } from "./api";
export type {
  BehaviorConfiguration,
  BehaviorEditorSnapshot,
  BehaviorInspection,
} from "@ifsoul/core/runtime";
export const readBehavior = (characterId?: string, signal?: AbortSignal) =>
  api<BehaviorEditorSnapshot>(
    `behavior${characterId ? `?characterId=${encodeURIComponent(characterId)}` : ""}`,
    { signal },
  );
export const saveBehavior = (
  config: BehaviorConfiguration,
  expectedRevision: number,
) =>
  api<BehaviorEditorSnapshot>("behavior", {
    method: "PUT",
    body: {
      expectedRevision,
      config: { ...config, revision: expectedRevision + 1 },
    },
  });
export const readBehaviorState = (
  sessionId: string,
  npcId: string,
  signal?: AbortSignal,
) =>
  api<BehaviorInspection>(
    `behavior/state?sessionId=${encodeURIComponent(sessionId)}&npcId=${encodeURIComponent(npcId)}`,
    { signal },
  );
export function behaviorError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "unavailable";
  if (code === "conflict" || code === "stale")
    return "The configuration changed elsewhere. Your draft is preserved. Reload the saved version before applying your changes again.";
  if (code === "unauthorized" || code === "forbidden" || code === "locked")
    return "This change is restricted by the hosting policy. Check the locked controls or reload your access.";
  if (
    code === "invalid" ||
    code === "invalid-document" ||
    code === "invalid-request"
  )
    return "Some values are outside their allowed bounds. Check the parameter ranges and required fields.";
  if (code === "timeout" || code === "network")
    return "The runtime did not respond. Your draft is preserved; try again when the connection returns.";
  return "Behavior configuration is unavailable on this runtime. Retry or contact its host.";
}
