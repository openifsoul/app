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
const ollama = createOllamaProvider({
  baseUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
  limits: { timeoutMs: 55000 },
});
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
  if (selection.provider === "ollama") return ollama;
  if (selection.provider === "openai") {
    const apiKey = await readOpenAIKey(store, secrets.encryptionKey);
    if (apiKey) return createOpenAIProvider({ apiKey });
  }
  throw Error("Provider unavailable");
};
const service = createCharacterWorkspace({
  memory,
  chatEnvironment: "app",
  clientFor,
  controllerFor: (selection) => async (input, signal) =>
    selection.provider === "scenario"
      ? createScenarioController()(input, signal)
      : createModelController({
          client: await clientFor(selection),
          model: selection.model,
        })(input, signal),
});
const api = createAPI({
  mode: "local",
  access: {
    kind: "local",
    origin: `http://127.0.0.1:${Number(process.env.PORT ?? 8788)}`,
  },
  password: secrets.password,
  encryptionKey: secrets.encryptionKey,
  store,
  service,
  providers,
});
const port = Number(process.env.PORT ?? 8788);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Invalid port");
const origin = `http://127.0.0.1:${port}`,
  webRoot = resolve("dist/web");
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
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403);
      res.end("Open IfSoul App using its loopback address.");
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const b = Buffer.from(chunk);
      size += b.length;
      if (size > (req.url === "/api/characters/import" ? 70000 : 16384)) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(b);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(",") : v);
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
server.requestTimeout = 65000;
server.headersTimeout = 10000;
server.listen(port, "127.0.0.1", () => {
  console.log(`IfSoul App (local): ${origin}`);
  console.log("Local-only access: no account or password prompt.");
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
