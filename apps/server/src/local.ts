import {
  createGameConnectionBroker,
  resolveGamePair,
  gameDeviceRequest,
} from "./game-connections.js";
import { createGameExecutor } from "./game-executor.js";
import { createAppBehavior } from "./behavior.js";
import { createSQLParticipantStore } from "../../runtime-host/src/participant-sessions.js";
import type { SQLDriver } from "@ifsoul/core/memory/sql";
import { trustedLocalRequest } from "./app-auth.js";
import {
  resolveAppResourcePolicy,
  httpBodyBudget,
  type AppResourceConfiguration,
} from "./resource-policy.js";
import { runBridgeRequest, observeBridgeRequest } from "./bridge.js";
import { createCharacterWorkspace } from "../../runtime-host/src/characters.js";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { resolve, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import {
  createModelController,
  createScenarioController,
  SCENARIO_MODEL,
} from "../../runtime-host/src/service.js";
import {
  createOpenAIProvider,
  createOllamaProvider,
  OPENAI_MODELS,
} from "@ifsoul/core/model-providers";
import {
  createAPI,
  readOpenAIKey,
  type PrivateStore,
  type ProviderOption,
} from "./api.js";
import { secured } from "./security.js";
let resourceConfiguration: AppResourceConfiguration = {};
if (process.env.IFSOUL_RESOURCE_POLICY_FILE) {
  try {
    resourceConfiguration = JSON.parse(
      readFileSync(process.env.IFSOUL_RESOURCE_POLICY_FILE, "utf8"),
    );
  } catch {
    throw Error("The local resource policy file could not be read as JSON.");
  }
}
if (process.env.IFSOUL_OLLAMA_PROMPT_BUDGET_BYTES !== undefined)
  resourceConfiguration = {
    ...resourceConfiguration,
    ollama: {
      ...resourceConfiguration.ollama,
      promptBytes: Number(process.env.IFSOUL_OLLAMA_PROMPT_BUDGET_BYTES),
    },
  };
const resourcePolicy = resolveAppResourcePolicy(resourceConfiguration);
const port = Number(process.env.PORT ?? 8788);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Choose a supported listen port");
const selfHosted = process.env.IFSOUL_PUBLIC_ORIGIN !== undefined;
const origin = selfHosted
  ? process.env.IFSOUL_PUBLIC_ORIGIN!
  : `http://127.0.0.1:${port}`;
const publicURL = new URL(origin);
const loopback = ["127.0.0.1", "localhost", "[::1]"];
if (
  publicURL.origin !== origin ||
  publicURL.username ||
  publicURL.password ||
  !(
    publicURL.protocol === "https:" ||
    (publicURL.protocol === "http:" && loopback.includes(publicURL.hostname))
  )
)
  throw Error("Use an HTTPS public origin or a loopback HTTP fixture");
const listenHost = process.env.IFSOUL_LISTEN_HOST ?? "127.0.0.1";
if (
  !["127.0.0.1", "0.0.0.0", "::1", "::"].includes(listenHost) ||
  (!selfHosted && listenHost !== "127.0.0.1") ||
  (publicURL.protocol === "http:" && !["127.0.0.1", "::1"].includes(listenHost))
)
  throw Error("Remote listening requires explicit HTTPS service origin");
if (selfHosted && !process.env.IFSOUL_DATA_DIR)
  throw Error(
    "Choose a dedicated persistent IFSOUL_DATA_DIR for the self-hosted service",
  );
const directory = resolve(process.env.IFSOUL_DATA_DIR ?? ".local/server");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const credentialPath = resolve(directory, "owner.json");
if (!existsSync(credentialPath))
  writeFileSync(
    credentialPath,
    JSON.stringify({
      password: randomBytes(32).toString("base64url"),
      encryptionKey: randomBytes(32).toString("base64url"),
    }),
    { mode: 0o600, flag: "wx" },
  );
chmodSync(credentialPath, 0o600);
const secrets = JSON.parse(readFileSync(credentialPath, "utf8")) as {
  password: string;
  encryptionKey: string;
};
const opened = openSQLiteMemory(resolve(directory, "memory.sqlite"));
if (!opened.ok) throw Error(opened.error.message);
const memory = opened.value;
const privateDB = new DatabaseSync(resolve(directory, "private.sqlite"));
chmodSync(resolve(directory, "private.sqlite"), 0o600);
privateDB.exec(
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)",
);
const store: PrivateStore = {
  get: (key) =>
    privateDB.prepare("SELECT value FROM settings WHERE key=?").get(key)
      ?.value as string | undefined,
  set: (key, value) => {
    privateDB
      .prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)")
      .run(key, value);
  },
  delete: (key) => {
    privateDB.prepare("DELETE FROM settings WHERE key=?").run(key);
  },
};
const ollamaOptions = {
  baseUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
  limits: resourcePolicy.ollama.provider.effective,
  budgetPolicy: resourcePolicy.ollama.budgetPolicy,
};
const ollama = createOllamaProvider(ollamaOptions);
const compactOllama = createOllamaProvider({
  ...ollamaOptions,
  limits: {
    ...ollamaOptions.limits,
    maxOutputTokens: Math.min(
      768,
      resourcePolicy.ollama.provider.effective.maxOutputTokens,
    ),
  },
});
const localOllamaClient: typeof ollama = {
  ...ollama,
  generate(input) {
    const properties = input.schema.properties;
    return resourcePolicy.ollama.compactReflection &&
      properties &&
      typeof properties === "object" &&
      "memoryUpdates" in properties
      ? compactOllama.generate(input)
      : ollama.generate(input);
  },
};
const providers = async (): Promise<ProviderOption[]> => {
  const installed = await ollama.listModels(AbortSignal.timeout(3000));
  return [
    {
      id: "openai",
      label: "OpenAI · your key",
      available: !!store.get("openai-key"),
      models: OPENAI_MODELS.map((id) => ({ id, label: id })),
      ...(!store.get("openai-key")
        ? { reason: "Add your OpenAI API key." }
        : {}),
    },
    {
      id: "ollama",
      label: "Ollama · local",
      available: installed.ok && installed.value.length > 0,
      models: installed.ok
        ? installed.value.map((id) => ({ id, label: id }))
        : [],
      ...(!installed.ok ? { reason: "Start Ollama on this computer." } : {}),
    },
    {
      id: "cloudflare",
      label: "Cloudflare Workers AI",
      available: false,
      models: [],
      reason: "Open the cloud laboratory to use Workers AI.",
    },
    {
      id: "scenario",
      label: "Synthetic scenario · no LLM",
      available: true,
      models: [{ id: SCENARIO_MODEL, label: "Deterministic scenario" }],
    },
  ];
};
const clientFor = async (
  selection: import("@ifsoul/core/model-providers/types").ProviderSelection,
) => {
  if (selection.provider === "ollama") return localOllamaClient;
  if (selection.provider === "openai") {
    const apiKey = await readOpenAIKey(store, secrets.encryptionKey);
    if (apiKey) return createOpenAIProvider({ apiKey });
  }
  throw Error("Provider unavailable");
};
let behavior: ReturnType<typeof createAppBehavior> | undefined;
const service = createCharacterWorkspace({
  memory,
  chatEnvironment: "app",
  runtimeLimits: resourcePolicy.runtime.effective,
  runtimeCeilings: resourcePolicy.runtimeCeilings,
  clientFor,
  controllerFor: (selection) => async (input, signal) => {
    const controller = async (
      input: import("@ifsoul/core/runtime").ControllerInput,
      signal: AbortSignal,
    ) =>
      selection.provider === "scenario"
        ? createScenarioController()(input, signal)
        : createModelController({
            client: await clientFor(selection),
            model: selection.model,
            promptBudgetBytes:
              selection.provider === "ollama"
                ? resourcePolicy.ollama.promptBytes
                : undefined,
            promptBudgetCeilingBytes:
              selection.provider === "ollama"
                ? resourcePolicy.ollama.promptCeilingBytes
                : undefined,
            compactOutput:
              selection.provider === "ollama" &&
              resourcePolicy.ollama.compactReflection,
            ...(behavior?.enabled()
              ? {}
              : {
                  reflection: {
                    memory,
                    ...(selection.provider === "ollama"
                      ? {
                          sourceBudgetBytes:
                            resourcePolicy.ollama.reflectionSourceBytes,
                          maxSources: resourcePolicy.ollama.reflectionSources,
                        }
                      : {}),
                  },
                }),
          })(input, signal);
    return behavior
      ? behavior.guardController(input, signal, controller)
      : controller(input, signal);
  },
});
const participantDriver: SQLDriver = {
  prepare: (sql) => privateDB.prepare(sql),
  transaction(work) {
    privateDB.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      privateDB.exec("COMMIT");
      return value;
    } catch (error) {
      privateDB.exec("ROLLBACK");
      throw error;
    }
  },
};
behavior = createAppBehavior({
  store: createSQLParticipantStore(participantDriver),
  access: { principalId: "local-owner", hostId: "app" },
  workspace: service,
});
const gameBroker = createGameConnectionBroker({
  store,
  transaction: (work) => participantDriver.transaction(work),
});
const gameExecutor = createGameExecutor({
  store: createSQLParticipantStore(participantDriver),
  clientFor: (selection) => clientFor(selection),
  validate: async (binding) => gameBroker.current(binding),
});
const ownerAPI = createAPI({
  mode: "local",
  resourcePolicy,
  ...(selfHosted ? {} : { access: { kind: "local" as const, origin } }),
  placement: selfHosted ? "selfhost" : "local",
  ...(selfHosted ? { publicOrigin: origin } : {}),
  password: secrets.password,
  encryptionKey: secrets.encryptionKey,
  store,
  service,
  behavior,
  providers,
  gameConnections: {
    controlProof: async () => gameBroker.controlProof("local-owner"),
    history: async (id) => {
      const binding = gameBroker
        .list("local-owner")
        .find((b) => b.connectionId === id);
      if (!binding) throw Error("Unknown connection");
      return gameExecutor.history(binding);
    },
    list: async () => gameBroker.list("local-owner"),
    pair: async (input) =>
      gameBroker.create(
        "local-owner",
        await resolveGamePair(service, providers, input),
        input.connectionId,
      ),
    revoke: async (id) => {
      gameBroker.revoke("local-owner", id);
    },
  },
  observeBridge: (body) => {
    observeBridgeRequest(body, memory, {
      bridgeLimits: resourcePolicy.bridge,
      retainedHistoryEntries: resourcePolicy.retainedHistoryEntries,
    });
  },
  bridge: async (body, selection) => {
    const policy = await behavior?.prepareBridge(body);
    try {
      return await runBridgeRequest(
        body,
        await clientFor(selection),
        selection.model,
        memory,
        {
          ...(policy ? { behavior: policy } : {}),
          bridgeLimits: resourcePolicy.bridge,
          retainedHistoryEntries: resourcePolicy.retainedHistoryEntries,
          runtimeLimits: resourcePolicy.runtime.effective,
          runtimeCeilings: resourcePolicy.runtimeCeilings,
          generationTimeoutCeilingMs:
            selection.provider === "ollama"
              ? resourcePolicy.ollama.provider.effective.timeoutMs
              : undefined,
          promptBudgetCeilingBytes:
            selection.provider === "ollama"
              ? resourcePolicy.ollama.promptCeilingBytes
              : undefined,
          compactOutput:
            selection.provider === "ollama" &&
            resourcePolicy.ollama.compactReflection,
          reflectionSourceBytes: resourcePolicy.ollama.reflectionSourceBytes,
          reflectionSources: resourcePolicy.ollama.reflectionSources,
          generationTimeoutMs:
            selection.provider === "ollama"
              ? resourcePolicy.ollama.generationTimeoutMs
              : undefined,
          promptBudgetBytes:
            selection.provider === "ollama"
              ? resourcePolicy.ollama.promptBytes
              : undefined,
        },
      );
    } catch (error) {
      policy?.validate();
      throw error;
    }
  },
});

if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Invalid port");
const webRoot = resolve("dist/web");
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};
const api = async (request: Request) => {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/game/device/")) {
    const response = await gameDeviceRequest(
      request,
      gameBroker,
      (binding, body) => gameExecutor.execute(binding, body),
    );
    return secured(response);
  }
  return ownerAPI(request);
};
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== publicURL.host) {
      res.writeHead(403, { Connection: "close" });
      res.end("Open IfSoul App using its configured address.");
      return;
    }
    const pathname = new URL(req.url ?? "/", origin).pathname;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(",") : v);
    }
    if (
      !selfHosted &&
      pathname.startsWith("/api/") &&
      ![
        "/api/game/device/redeem",
        "/api/game/device/ready",
        "/api/game/device/dialogue",
        "/api/game/device/revoke",
        "/api/game/device/owner-proof",
      ].includes(pathname) &&
      !trustedLocalRequest(
        new Request(new URL(req.url ?? "/", origin), {
          method: req.method,
          headers,
        }),
        origin,
      )
    ) {
      res.writeHead(403, { Connection: "close" });
      res.end("Open the App on its loopback address.");
      return;
    }
    const bodyLimit = httpBodyBudget(
      resourcePolicy,
      pathname,
      req.method ?? "GET",
    );
    if (Number(req.headers["content-length"]) > bodyLimit) {
      res.writeHead(413, {
        "Content-Type": "application/json",
        Connection: "close",
      });
      res.end(
        JSON.stringify({
          ok: false,
          error: {
            code: "budget-exceeded",
            layer: "http-ingress",
            message: "The request exceeds the configured HTTP byte budget.",
          },
        }),
      );
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const b = Buffer.from(chunk);
      size += b.length;
      if (size > bodyLimit) {
        res.writeHead(413, {
          "Content-Type": "application/json",
          Connection: "close",
        });
        res.end(
          JSON.stringify({
            ok: false,
            error: {
              code: "budget-exceeded",
              layer: "http-ingress",
              message: "The request exceeds the configured HTTP byte budget.",
            },
          }),
        );
        return;
      }
      chunks.push(b);
    }
    const request = new Request(new URL(req.url ?? "/", origin), {
      method: req.method,
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    let response: Response;
    if (new URL(request.url).pathname.startsWith("/api/"))
      response = await api(request);
    else {
      const pageURL = new URL(request.url);
      const pathname = decodeURIComponent(pageURL.pathname);
      let file = resolve(webRoot, `.${pathname}`);
      if (!file.startsWith(webRoot + "/") || !extname(file))
        file = resolve(webRoot, "index.html");
      try {
        response = secured(
          new Response(readFileSync(file), {
            headers: {
              "Content-Type": mime[extname(file)] ?? "application/octet-stream",
            },
          }),
        );
      } catch {
        response = new Response("Build IfSoul App with pnpm build:web first.", {
          status: 404,
        });
      }
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: {
          code: "server-error",
          message: "The request could not be completed.",
        },
      }),
    );
  }
});
server.requestTimeout = resourcePolicy.http.requestTimeoutMs;
server.headersTimeout = resourcePolicy.http.headersTimeoutMs;
server.listen(port, listenHost, () => {
  console.log(
    `IfSoul App (${selfHosted ? "self-hosted" : "local"}): ${origin}`,
  );
  console.log(
    selfHosted
      ? "Owner password sign-in required. Preserve the dedicated data directory and keep owner.json private."
      : "Local-only access: no account or password prompt.",
  );
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    privateDB.close();
    memory.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
