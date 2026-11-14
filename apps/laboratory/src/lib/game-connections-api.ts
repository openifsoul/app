import type {
  GameBinding,
  GameGrant,
  GamePairRequest,
} from "../../../server/src/game-connections";
import type { CharacterSummary } from "../../../runtime-host/src/service-types";
import { api, ApiError } from "./api";
import { desktopBridge } from "./desktop";
export type { GameBinding, GameGrant, GamePairRequest, CharacterSummary };
export const COMPANION_ORIGIN = "http://127.0.0.1:8811";
export interface MinecraftConnection {
  host: string;
  port: number;
  version: "1.20.2";
  auth: "offline";
  trustedServerApproved: true;
  botName: string;
  playerName: string;
}
export interface CompanionStatus {
  configured: boolean;
  running: boolean;
  phase: string;
  error?: string;
  requiresServiceSwitch?: boolean;
  requiresOwnerSwitch?: boolean;
  config?: {
    minecraft: MinecraftConnection;
    serviceEndpoint: string;
    connection: GameBinding;
  };
  connector?: { ready?: boolean; calls?: number };
  players?: { name: string; uuid: string }[];
}
export interface CompanionControl {
  controlToken: string;
  expiresAt: number;
}
export const readGameConnections = (signal?: AbortSignal) =>
  api<{ connections: GameBinding[] }>("game-connections", { signal });
export const readOwnedCharacters = (signal?: AbortSignal) =>
  api<CharacterSummary[]>("characters", { signal });
export const createGameConnection = (
  body: GamePairRequest,
  signal?: AbortSignal,
) => api<GameGrant>("game-connections", { method: "POST", body, signal });
export const revokeGameConnection = (id: string) =>
  api("game-connections/" + encodeURIComponent(id), { method: "DELETE" });
export class CompanionRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
async function localRequest<T>(
  path: string,
  options: { token?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(15000);
  const signal = options.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout;
  try {
    const desktop = desktopBridge();
    const response = await fetch(
      (desktop ? "/api/desktop/companion" : COMPANION_ORIGIN) + path,
      {
        method: options.body === undefined ? "GET" : "POST",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal,
        headers: {
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(!desktop && options.token
            ? { Authorization: `Bearer ${options.token}` }
            : {}),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      },
    );
    const value: unknown = await response.json();
    if (!response.ok) {
      const error = value as { error?: { code?: string } };
      throw new CompanionRequestError(error?.error?.code ?? "request-rejected");
    }
    if (!value || typeof value !== "object")
      throw new CompanionRequestError("invalid-response");
    return value as T;
  } catch (error) {
    if (error instanceof CompanionRequestError || options.signal?.aborted)
      throw error;
    throw new CompanionRequestError(
      timeout.aborted ? "timeout" : "unreachable",
    );
  }
}
export async function pairCompanion(
  code: string,
  signal?: AbortSignal,
): Promise<CompanionControl> {
  const proof = await api<{ code: string; expiresAt: number }>(
    "game-connections/control-proof",
    { method: "POST", body: {}, signal },
  );
  if (
    typeof proof.code !== "string" ||
    proof.code.length < 8 ||
    proof.code.length > 256 ||
    !Number.isSafeInteger(proof.expiresAt) ||
    proof.expiresAt <= Date.now()
  )
    throw new CompanionRequestError("invalid-response");
  const value = await localRequest<CompanionControl>("/pair", {
    body: { code, ownerProof: proof.code },
    signal,
  });
  if (
    typeof value.controlToken !== "string" ||
    value.controlToken.length < 16 ||
    value.controlToken.length > 256 ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= Date.now()
  )
    throw new CompanionRequestError("invalid-response");
  return value;
}
export const readCompanionStatus = (token: string, signal?: AbortSignal) =>
  localRequest<CompanionStatus>("/status", { token, signal });
export const configureCompanion = (
  token: string,
  pairCode: string,
  minecraft: MinecraftConnection,
  signal?: AbortSignal,
) =>
  localRequest<unknown>("/configure", {
    token,
    body: { serviceEndpoint: window.location.origin, pairCode, minecraft },
    signal,
  });
export const commandCompanion = (
  token: string,
  command: "start" | "stop" | "reconnect" | "clear",
  signal?: AbortSignal,
) =>
  localRequest<unknown>("/" + command, {
    token,
    body: command === "clear" ? { consent: true } : {},
    signal,
  });
export function gameConnectionError(error: unknown, companion = false): string {
  const code =
    error instanceof ApiError || error instanceof CompanionRequestError
      ? error.code
      : "unavailable";
  if (companion) {
    if (desktopBridge()) {
      if (["expired", "unauthorized", "pairing", "forbidden"].includes(code))
        return "Start and approve the bundled companion again. The saved connection will be available after approval.";
      if (code === "timeout" || code === "unreachable")
        return "The bundled companion did not respond. Start and approve it again, then refresh its status.";
    }
    if (
      [
        "expired",
        "unauthorized",
        "pairing-required",
        "invalid-code",
        "origin-not-approved",
        "forbidden",
      ].includes(code)
    )
      return "Approve this App on the companion’s local page and enter a fresh pairing code. Pairing codes work once and expire after five minutes.";
    if (code === "timeout" || code === "unreachable")
      return "The local companion did not respond. Keep it running on this computer, approve this App origin there, then retry.";
    if (code === "other-owner")
      return "The saved companion connection belongs to another account. Explicitly clear it before connecting this account.";
    if (code === "other-service")
      return "The companion is configured for another App. Clear its saved connection explicitly before connecting this service.";
    return "The companion could not complete this step. Check its local page, refresh status and review the Minecraft server and player name.";
  }
  if (code === "unauthorized" || code === "forbidden")
    return "This connection is not available to the current account. Sign in again or choose an owned character and memory.";
  if (code === "invalid" || code === "invalid-request")
    return "Choose an available model, an owned character and memory, and approve private dialogue before connecting.";
  if (code === "timeout" || code === "network")
    return "The App service did not respond. Your choices are preserved; retry when its connection returns.";
  return "Game connections are unavailable on this service. Retry or ask its host to enable the connection capability.";
}
