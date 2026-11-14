import type {
  GameConnectionPort,
  GamePairRequest,
} from "./game-connections.js";
import {
  estimateCustomerCost,
  type BillingPort,
  type SpendingLimits,
} from "./billing.js";
import { SessionError } from "@ifsoul/core/runtime";
import type { AppBehaviorAPI } from "./behavior.js";
import {
  bridgeCapabilities,
  validBridgeRequest,
} from "@ifsoul/adapter-sdk/bridge";
import {
  AppResourceError,
  httpBodyBudget,
  type AppResourcePolicy,
} from "./resource-policy.js";
import type { BridgeRequest, BridgeResponse } from "./bridge.js";
import type { ProviderSelection } from "@ifsoul/core/model-providers/types";
import { appConfig, trustedLocalRequest } from "./app-auth.js";
import {
  CHARACTER_LIBRARY,
  EXTERNAL_AUTHORING_PROMPT,
} from "../../runtime-host/src/authoring.js";
import {
  authenticated,
  boundedJSON,
  decryptCredential,
  encryptCredential,
  equalSecret,
  secured,
  sessionCookie,
} from "./security.js";
import type {
  LabService,
  CharacterWorkspace,
  CharacterDraft,
  LabRunRequest,
  GenerationRequest,
} from "../../runtime-host/src/service-types.js";
export interface ProviderOption {
  id: string;
  label: string;
  available: boolean;
  models: { id: string; label: string }[];
  reason?: string;
}
export interface PrivateStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}
export interface APIOptions {
  mode: "local" | "cloud";
  placement?: "local" | "selfhost" | "managed";
  publicOrigin?: string;
  resourcePolicy?: AppResourcePolicy;
  password: string;
  access?:
    { kind: "local"; origin: string } | { kind: "principal"; id: string };
  encryptionKey: string;
  store: PrivateStore;
  service: LabService | CharacterWorkspace;
  providers(): Promise<ProviderOption[]>;
  now?: () => number;
  observeBridge?: (body: BridgeRequest) => void;
  bridge?: (
    body: BridgeRequest,
    selection: ProviderSelection,
  ) => Promise<BridgeResponse>;
  demo?: (request: Request) => Promise<Response>;
  behavior?: AppBehaviorAPI;
  billing?: BillingPort;
  gameConnections?: GameConnectionPort;
  browseGameMemory?: (
    params: URLSearchParams,
  ) => ReturnType<
    typeof import("../../runtime-host/src/memory-explorer.js").browseScopedHistory
  >;
  revokeMemorySource?: (
    memoryId: string,
    worldId: string,
    sourceId?: string,
  ) => void;
}
const error = (code: string, message: string, status = 400) =>
  Response.json({ ok: false, error: { code, message } }, { status });
export function createAPI(options: APIOptions) {
  const now = options.now ?? Date.now;
  let busy = false;
  return async (request: Request): Promise<Response> => {
    try {
      return secured(await handle(request));
    } catch (reason) {
      if (reason instanceof SessionError)
        return secured(
          error(
            reason.code,
            reason.code === "conflict" || reason.code === "stale"
              ? "Configuration changed. Reload it before saving again."
              : reason.code === "unauthorized"
                ? "This change is not allowed by the host configuration."
                : "Check the behavior configuration and try again.",
            reason.code === "conflict" || reason.code === "stale"
              ? 409
              : reason.code === "unauthorized"
                ? 403
                : 400,
          ),
        );
      if (reason instanceof AppResourceError && options.resourcePolicy)
        return secured(
          Response.json(
            {
              ok: false,
              error: {
                code: reason.code,
                layer: reason.layer,
                field: reason.field,
                message:
                  "The configured resource budget does not support this request.",
              },
            },
            { status: reason.code === "budget-exceeded" ? 413 : 400 },
          ),
        );
      return secured(
        error(
          "server-error",
          "The request could not be completed. Please try again.",
          500,
        ),
      );
    }
  };
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url),
      originalPath = url.pathname,
      path =
        originalPath === "/api/chat" || originalPath === "/api/lab/run"
          ? "/api/run"
          : originalPath;
    const readBody = (legacyMaximum = 16384) =>
      boundedJSON(
        request,
        options.resourcePolicy
          ? httpBodyBudget(options.resourcePolicy, originalPath, request.method)
          : legacyMaximum,
      );
    if (
      options.access?.kind === "local" &&
      !trustedLocalRequest(request, options.access.origin)
    )
      return error("forbidden", "Open the app on its loopback address.", 403);
    if (
      !options.access &&
      request.headers.has("origin") &&
      request.headers.get("origin") !== url.origin
    )
      return error("forbidden", "Open this service directly.", 403);
    if (originalPath === "/api/config" && request.method === "GET")
      return Response.json({
        ...appConfig(options.mode, options.resourcePolicy?.browserTimeoutMs),
        ...(!options.access ? { auth: "password" } : {}),
        ...(options.placement ? { placement: options.placement } : {}),
        ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}),
      });
    if (
      options.access &&
      options.mode === "cloud" &&
      (originalPath.startsWith("/api/lab/") || originalPath === "/api/run")
    )
      return error(
        "forbidden",
        "The laboratory is available only locally.",
        403,
      );
    if ((!options.password && !options.access) || !options.encryptionKey)
      return error(
        "not-configured",
        "The server needs owner configuration.",
        503,
      );
    const mutation = !["GET", "HEAD"].includes(request.method);
    if (mutation && request.headers.get("origin") !== url.origin)
      return error(
        "forbidden",
        "Open this panel directly before continuing.",
        403,
      );
    if (path.startsWith("/api/demo/") && options.demo)
      return options.demo(request);
    const auth = options.access
      ? true
      : await authenticated(request, options.password, now());
    if (!options.access && path === "/api/login" && request.method === "POST") {
      const attempt = JSON.parse(
        options.store.get("login-window") ?? '{"at":0,"count":0}',
      ) as { at: number; count: number };
      if (now() - attempt.at > 60000) {
        attempt.at = now();
        attempt.count = 0;
      }
      if (attempt.count >= 8)
        return error(
          "rate-limited",
          "Too many attempts. Wait a minute and try again.",
          429,
        );
      attempt.count++;
      options.store.set("login-window", JSON.stringify(attempt));
      const body = (await readBody()) as { password?: unknown };
      if (
        typeof body?.password !== "string" ||
        body.password.length > 256 ||
        !(await equalSecret(body.password, options.password))
      )
        return error(
          "invalid-password",
          "The access password is incorrect.",
          401,
        );
      return Response.json(
        { ok: true },
        {
          headers: {
            "Set-Cookie": await sessionCookie(
              options.password,
              url.protocol === "https:",
              now(),
            ),
          },
        },
      );
    }
    if (path === "/api/status" && request.method === "GET")
      return Response.json({
        authenticated: auth,
        mode: options.mode,
        ...(options.placement ? { placement: options.placement } : {}),
        providers: auth ? await options.providers() : [],
      });
    if (!auth) return error("unauthorized", "Sign in to continue.", 401);
    if (
      path === "/api/game-connections/control-proof" &&
      request.method === "POST" &&
      options.gameConnections
    ) {
      try {
        return Response.json(await options.gameConnections.controlProof());
      } catch {
        return error(
          "conflict",
          "Local control verification unavailable. Retry later.",
          409,
        );
      }
    }
    if (path === "/api/game-connections" && options.gameConnections) {
      if (request.method === "GET")
        return Response.json({
          connections: await options.gameConnections.list(),
        });
      if (request.method === "POST") {
        try {
          return Response.json(
            await options.gameConnections.pair(
              (await readBody(2048)) as GamePairRequest,
            ),
          );
        } catch {
          return error(
            "invalid-connection",
            "Choose an available character, memory and provider, then approve private dialogue.",
            400,
          );
        }
      }
    }
    if (
      path.startsWith("/api/game-connections/") &&
      path.endsWith("/history") &&
      request.method === "GET" &&
      options.gameConnections
    ) {
      try {
        return Response.json({
          events: await options.gameConnections.history(
            path.slice("/api/game-connections/".length, -"/history".length),
          ),
        });
      } catch {
        return error(
          "forbidden",
          "This connection history is not available.",
          403,
        );
      }
    }
    if (
      path.startsWith("/api/game-connections/") &&
      request.method === "DELETE" &&
      options.gameConnections
    ) {
      try {
        await options.gameConnections.revoke(
          path.slice("/api/game-connections/".length),
        );
        return Response.json({ ok: true });
      } catch {
        return error("forbidden", "This connection cannot be changed.", 403);
      }
    }
    if (path === "/api/billing/estimate" && request.method === "GET") {
      if (!options.billing)
        return error(
          "unavailable",
          "Billing is not enabled for this service.",
          404,
        );
      const snapshot = await options.billing.read();
      const tariff = snapshot.tariffs.find(
        (t) => t.model === url.searchParams.get("model"),
      );
      const inputTokens = Number(url.searchParams.get("inputTokens")),
        outputTokens = Number(url.searchParams.get("outputTokens")),
        calls = Number(url.searchParams.get("calls"));
      try {
        if (
          !tariff ||
          !["inputTokens", "outputTokens", "calls"].every((k) =>
            /^\d{1,10}$/.test(url.searchParams.get(k) ?? ""),
          )
        )
          throw Error();
        return Response.json({
          microdollars: estimateCustomerCost(
            tariff,
            inputTokens,
            outputTokens,
            calls,
          ),
          tariffVersion: tariff.version,
        });
      } catch {
        return error(
          "invalid-estimate",
          "Enter valid token counts and call count.",
          400,
        );
      }
    }
    if (path === "/api/billing" && request.method === "GET")
      return Response.json(
        options.billing
          ? { available: true, ...(await options.billing.read()) }
          : { available: false },
      );
    if (path === "/api/billing/limits" && request.method === "PUT") {
      if (!options.billing)
        return error(
          "unavailable",
          "Billing is not enabled for this service.",
          404,
        );
      const body = await readBody(2048);
      try {
        return Response.json(
          await options.billing.updateLimits(body as SpendingLimits),
        );
      } catch {
        return error(
          "conflict",
          "Limits could not be saved. Refresh and check the allowed amounts.",
          409,
        );
      }
    }

    if (
      options.behavior &&
      options.access?.kind === "principal" &&
      options.access.id !== options.behavior.principalId
    )
      throw new SessionError("unauthorized");
    if (path === "/api/behavior" && options.behavior) {
      if (request.method === "GET")
        return Response.json(
          {
            ok: true,
            value: await options.behavior.read(
              url.searchParams.get("characterId") ?? undefined,
            ),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      if (request.method === "PUT") {
        const body = await readBody(65536);
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).some(
            (k) => !["expectedRevision", "config"].includes(k),
          )
        )
          throw new SessionError("invalid");
        return Response.json(
          {
            ok: true,
            value: await options.behavior.update(
              body as Parameters<AppBehaviorAPI["update"]>[0],
            ),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
    }
    if (
      path === "/api/behavior/state" &&
      request.method === "GET" &&
      options.behavior
    )
      return Response.json(
        {
          ok: true,
          value: await options.behavior.inspect(
            url.searchParams.get("sessionId") ?? "",
            url.searchParams.get("npcId") ?? "",
          ),
        },
        { headers: { "Cache-Control": "no-store" } },
      );

    if (path === "/api/resource-policy" && request.method === "GET")
      return Response.json(
        options.resourcePolicy?.metadata ?? {
          version: "ifsoul-app-resource-policy/0.4.0",
          bridge: bridgeCapabilities(),
          model: { context: "composition-controlled", accounting: "unknown" },
          http: {
            bodyBytes: 16384,
            transport: "buffered-json",
            streamingLargeMessages: false,
          },
        },
      );
    if (
      path === "/api/bridge/observations" &&
      request.method === "POST" &&
      options.observeBridge
    ) {
      const body = await readBody();
      if (!body || typeof body !== "object" || Array.isArray(body))
        return error("invalid-request", "Enter a bounded bridge request.");
      if ((body as { version: unknown }).version !== "ifsoul-bridge/0.4.0")
        return error("unsupported-version", "Use IfSoul bridge version 0.4.0.");
      options.observeBridge(body as BridgeRequest);
      return Response.json({ ok: true });
    }
    if (path === "/api/bridge" && request.method === "POST" && options.bridge) {
      if (busy)
        return error(
          "busy",
          "An operation is already running. Wait for its result.",
          409,
        );
      const body = await readBody();
      if (!body || typeof body !== "object" || Array.isArray(body))
        return error("invalid-request", "Enter a bounded bridge request.");
      if ((body as { version: unknown }).version !== "ifsoul-bridge/0.4.0")
        return error("unsupported-version", "Use IfSoul bridge version 0.4.0.");
      if (options.behavior?.enabled()) {
        if (!validBridgeRequest(body, options.resourcePolicy?.bridge))
          throw new SessionError("invalid");
        const gate = await options.behavior.prepareBridge(
          body as BridgeRequest,
        );
        if (gate && !gate.allowed) {
          if ((body as BridgeRequest).operation === "decide")
            return error(
              "policy",
              "The configured reaction policy withheld an action.",
              400,
            );
          return Response.json({
            choiceId: "",
            speech: "",
            source: "fallback",
          });
        }
      }
      const providerId = url.searchParams.get("provider"),
        model = url.searchParams.get("model");
      const provider = (await options.providers()).find(
        (p) => p.id === providerId,
      );
      if (
        !provider?.available ||
        provider.id === "scenario" ||
        !model ||
        !provider.models.some((m) => m.id === model)
      )
        return error(
          "unavailable",
          "Choose an available model using provider and model URL parameters.",
        );
      if (busy)
        return error(
          "busy",
          "An operation is already running. Wait for its result.",
          409,
        );
      busy = true;
      try {
        return Response.json(
          await options.bridge(body as BridgeRequest, {
            provider: provider.id as ProviderSelection["provider"],
            model,
          }),
        );
      } finally {
        busy = false;
      }
    }
    if (path === "/api/logout" && request.method === "POST")
      return Response.json(
        { ok: true },
        {
          headers: {
            "Set-Cookie": `ifsoul_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${url.protocol === "https:" ? "; Secure" : ""}`,
          },
        },
      );
    if (path === "/api/credentials/openai") {
      if (busy)
        return error("busy", "Wait for the current operation to finish.", 409);
      if (request.method === "DELETE") {
        options.store.delete("openai-key");
        return Response.json({ ok: true });
      }
      if (request.method === "POST") {
        const body = (await readBody()) as { key?: unknown };
        if (
          typeof body?.key !== "string" ||
          body.key.length < 20 ||
          body.key.length > 1024 ||
          /\s/.test(body.key)
        )
          return error("invalid-key", "Enter a valid API key.");
        options.store.set(
          "openai-key",
          await encryptCredential(body.key, options.encryptionKey),
        );
        return Response.json({ ok: true });
      }
    }
    if ("listCharacters" in options.service) {
      if (
        path === "/api/memory/source-access" &&
        request.method === "DELETE" &&
        options.revokeMemorySource
      ) {
        const memoryId = url.searchParams.get("memoryId") ?? "";
        const worldId = url.searchParams.get("worldId") ?? "";
        const sourceId = url.searchParams.get("sourceId") ?? undefined;
        try {
          options.revokeMemorySource(memoryId, worldId, sourceId);
          return Response.json({ ok: true });
        } catch {
          return error(
            "invalid-document",
            "This memory source could not be restricted.",
          );
        }
      }
      if (path === "/api/memory/browse" && request.method === "GET") {
        if (!options.service.browseMemory)
          return error(
            "unsupported",
            "This store does not support browsing retained memory.",
          );
        const result = url.searchParams.has("connection")
          ? options.browseGameMemory?.(url.searchParams)
          : options.service.browseMemory(url.searchParams);
        if (!result)
          return error(
            "unsupported",
            "This store does not support connection history.",
          );
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }
      if (path === "/api/memory/export" && request.method === "GET") {
        const result = options.service.exportMemory(
          url.searchParams.get("memoryId") ?? "",
        );
        return Response.json(result, {
          status: result.ok ? 200 : 400,
          headers: { "Cache-Control": "no-store" },
        });
      }
      if (
        [
          "/api/memory/preview",
          "/api/memory/import",
          "/api/memory/new",
        ].includes(path) &&
        request.method === "POST"
      ) {
        if (busy) return error("busy", "Wait for the current operation.", 409);
        const body = (await readBody(2_010_000)) as Record<string, unknown>;
        if (!body || typeof body !== "object" || Array.isArray(body))
          return error("invalid-document", "Choose a memory archive.");
        const result =
          path === "/api/memory/new"
            ? options.service.createExportableMemory(
                body.characterId,
                body.consent,
              )
            : path === "/api/memory/preview"
              ? options.service.previewMemory(body.archive)
              : options.service.importMemory(body.archive, body.expectedDigest);
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }

      if (path === "/api/characters/authoring" && request.method === "GET")
        return Response.json({
          library: CHARACTER_LIBRARY,
          prompt: EXTERNAL_AUTHORING_PROMPT,
        });
      if (path === "/api/characters/export" && request.method === "GET") {
        const result = options.service.exportCharacter(
          url.searchParams.get("characterId") ?? "",
        );
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }
      if (path === "/api/characters/import" && request.method === "POST") {
        if (busy)
          return error(
            "busy",
            "Wait for the current operation to finish.",
            409,
          );
        const body = (await readBody(70000)) as {
          requestId: string;
          template: unknown;
        };
        const result = options.service.importCharacter(body);
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }
    }
    if (path === "/api/characters" && "listCharacters" in options.service) {
      if (request.method === "GET")
        return Response.json(options.service.listCharacters());
      if (request.method === "POST") {
        if (busy)
          return error(
            "busy",
            "Wait for the current operation to finish.",
            409,
          );
        const draft = (await readBody()) as CharacterDraft;
        const result = options.service.createCharacter(draft);
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }
    }
    if (path === "/api/snapshot" && request.method === "GET") {
      const id = url.searchParams.get("characterId") ?? undefined;
      return Response.json(
        "listCharacters" in options.service
          ? options.service.snapshot(
              id,
              url.searchParams.get("memoryCharacterId") ?? undefined,
            )
          : options.service.snapshot(),
      );
    }
    if (
      (path === "/api/run" ||
        (path === "/api/characters/generate" &&
          "listCharacters" in options.service)) &&
      request.method === "POST"
    ) {
      if (busy)
        return error(
          "busy",
          "An operation is already running. Wait for its result.",
          409,
        );
      const body = (await readBody()) as LabRunRequest & GenerationRequest;
      if (!body || typeof body !== "object")
        return error("invalid-request", "Choose an operation and model.");
      if (originalPath === "/api/chat" && body.operation !== "chat")
        return error(
          "forbidden",
          "Use the local laboratory for planning.",
          403,
        );
      busy = true;
      try {
        const behaviorGate =
          path === "/api/run" && options.behavior
            ? await options.behavior.prepareRun(body)
            : { allowed: true };
        const providers = await options.providers();
        const provider = providers.find((p) => p.id === body.provider);
        if (
          behaviorGate.allowed &&
          (!provider?.available ||
            !provider.models.some((m) => m.id === body.model))
        )
          return error(
            "unavailable",
            "The selected model is not available. Check its connection.",
          );
        const counter = JSON.parse(
          options.store.get("run-window") ?? '{"at":0,"count":0}',
        ) as { at: number; count: number };
        if (now() - counter.at > 3600000) {
          counter.at = now();
          counter.count = 0;
        }
        if (counter.count >= 60)
          return error(
            "rate-limited",
            "The hourly laboratory limit has been reached. Try later.",
            429,
          );
        counter.count++;
        options.store.set("run-window", JSON.stringify(counter));
        const result =
          path === "/api/characters/generate" &&
          "listCharacters" in options.service
            ? await options.service.generateCharacter(body)
            : await options.service.run(body);
        return Response.json(result, { status: result.ok ? 200 : 400 });
      } finally {
        busy = false;
      }
    }
    return error("not-found", "This action is not available.", 404);
  }
}
export async function readOpenAIKey(
  store: PrivateStore,
  encryptionKey: string,
): Promise<string | undefined> {
  const value = store.get("openai-key");
  return value ? decryptCredential(value, encryptionKey) : undefined;
}
