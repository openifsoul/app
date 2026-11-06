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
  password: string;
  access?:
    { kind: "local"; origin: string } | { kind: "principal"; id: string };
  encryptionKey: string;
  store: PrivateStore;
  service: LabService | CharacterWorkspace;
  providers(): Promise<ProviderOption[]>;
  now?: () => number;
  demo?: (request: Request) => Promise<Response>;
}
const error = (code: string, message: string, status = 400) =>
  Response.json({ ok: false, error: { code, message } }, { status });
export function createAPI(options: APIOptions) {
  const now = options.now ?? Date.now;
  let busy = false;
  return async (request: Request): Promise<Response> => {
    try {
      return secured(await handle(request));
    } catch {
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
    if (
      options.access?.kind === "local" &&
      !trustedLocalRequest(request, options.access.origin)
    )
      return error("forbidden", "Open the app on its loopback address.", 403);
    if (originalPath === "/api/config" && request.method === "GET")
      return Response.json(appConfig(options.mode));
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
      const body = (await boundedJSON(request)) as { password?: unknown };
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
        providers: auth ? await options.providers() : [],
      });
    if (!auth) return error("unauthorized", "Sign in to continue.", 401);
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
        const body = (await boundedJSON(request)) as { key?: unknown };
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
        const body = (await boundedJSON(request, 70000)) as {
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
        const draft = (await boundedJSON(request)) as CharacterDraft;
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
      const body = (await boundedJSON(request)) as LabRunRequest &
        GenerationRequest;
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
        const providers = await options.providers();
        const provider = providers.find((p) => p.id === body.provider);
        if (
          !provider?.available ||
          !provider.models.some((m) => m.id === body.model)
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
