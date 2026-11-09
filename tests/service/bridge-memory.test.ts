import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import {
  failure,
  type Result,
  type MemoryPort,
} from "@ifsoul/core/memory/port";
import type { ModelClient } from "@ifsoul/core/model-providers/types";
import {
  runBridgeRequest,
  type BridgeRequest,
} from "../../apps/server/src/bridge.js";
import {
  inspectBridgeMemory,
  resetBridgeMemory,
  recordBridgeRequest,
  recallBridgeMemory,
  BRIDGE_MEMORY_LIMITS,
} from "../../apps/runtime-host/src/bridge-memory.js";

function unwrap<T>(result: Result<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw Error("Memory operation failed");
  return result.value;
}
let sequence = 0;
const request = (overrides: Partial<BridgeRequest> = {}): BridgeRequest => ({
  version: "ifsoul-bridge/0.4.0",
  hostId: "garden",
  memoryId: "shared-companion",
  character: { id: "garden-seed", name: "Seed", temperament: "curious" },
  requestId: `bridge-memory-${++sequence}`,
  operation: "chat",
  context: "My favorite flower is the blue iris.",
  choices: [],
  fallbackChoiceId: "",
  history: [],
  ...overrides,
});
function provider() {
  const prompts: string[] = [],
    models: string[] = [];
  const client: ModelClient = {
    id: "openai",
    async generate(input) {
      prompts.push(input.prompt);
      models.push(input.model);
      return { ok: true, value: { content: "I invented a silver castle." } };
    },
  };
  return { client, prompts, models };
}

test("one selected companion recalls three hosts after SQLite reopen and model replacement without browser history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ifsoul-bridge-memory-"));
  const path = join(directory, "memory.sqlite");
  let memory = unwrap(openSQLiteMemory(path));
  const first = provider(),
    replacement = provider();
  try {
    await runBridgeRequest(request(), first.client, "first-model", memory);
    await runBridgeRequest(
      request({
        hostId: "friendly-21",
        character: { id: "card-guide", name: "Pip", temperament: "bold" },
        context: "We are looking at cards.",
      }),
      first.client,
      "first-model",
      memory,
    );
    unwrap(memory.close());
    memory = unwrap(openSQLiteMemory(path));
    await runBridgeRequest(
      request({
        hostId: "dungeon",
        character: {
          id: "dungeon-guide",
          name: "Ember",
          temperament: "careful",
        },
        context:
          "Which flower did I mention in the garden, and which worlds did we visit?",
        history: [],
      }),
      replacement.client,
      "replacement-model",
      memory,
    );
    const prompt = replacement.prompts.at(-1)!;
    assert.match(prompt, /blue iris/);
    for (const host of ["garden", "friendly-21", "dungeon"])
      assert.ok(prompt.includes(host), host);
    assert.deepEqual(replacement.models, ["replacement-model"]);
    const journal = inspectBridgeMemory(memory, "shared-companion");
    assert.ok(
      journal.entries.some(
        (entry) =>
          entry.assistantDialogue?.content.includes("silver castle") &&
          entry.assistantDialogue.provenance === "generated-speech-not-fact",
      ),
    );
    assert.ok(
      journal.entries.every(
        (entry) =>
          !JSON.stringify(entry.serverObservation).includes("silver castle"),
      ),
    );
    assert.equal(journal.memoryId, "shared-companion");
    assert.ok(
      journal.entries.some(
        (entry) =>
          entry.serverObservation?.hostId === "garden" &&
          entry.serverObservation.meaning.includes("no completed gameplay"),
      ),
    );
    assert.ok(
      journal.entries.some(
        (entry) =>
          entry.summary.includes("blue iris") &&
          entry.source === "browser-report" &&
          entry.trust === "unverified",
      ),
    );
    assert.ok(
      journal.entries.every(
        (entry) => !entry.summary.includes("silver castle"),
      ),
      "Generated speech must not become a journal fact",
    );
  } finally {
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("selected memories and separately scoped user stores cannot recall one another", async () => {
  const owner = unwrap(openSQLiteMemory(":memory:")),
    otherUser = unwrap(openSQLiteMemory(":memory:"));
  const model = provider();
  try {
    await runBridgeRequest(
      request({ context: "Only Alpha knows the amber compass." }),
      model.client,
      "test-model",
      owner,
    );
    await runBridgeRequest(
      request({
        memoryId: "second-companion",
        context: "Hello from a second character.",
      }),
      model.client,
      "test-model",
      owner,
    );
    assert.ok(!model.prompts.at(-1)!.includes("amber compass"));
    await runBridgeRequest(
      request({ context: "Hello from another user." }),
      model.client,
      "test-model",
      otherUser,
    );
    assert.ok(!model.prompts.at(-1)!.includes("amber compass"));
    assert.equal(
      inspectBridgeMemory(otherUser, "second-companion").entries.length,
      0,
    );
    assert.ok(
      JSON.stringify(inspectBridgeMemory(owner, "shared-companion")).includes(
        "amber compass",
      ),
    );
  } finally {
    owner.close();
    otherUser.close();
  }
});

test("imported browser outcomes keep unverified provenance and deduplicate repeated imports", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:")),
    model = provider();
  const history = [
    {
      id: "browser-event-one",
      hostId: "garden",
      kind: "observation",
      summary: "The browser claims the crystal harvest was completed.",
    },
  ];
  try {
    await runBridgeRequest(
      request({ history }),
      model.client,
      "test-model",
      memory,
    );
    await runBridgeRequest(
      request({
        history,
        hostId: "dungeon",
        context: "Do you recall the crystal harvest?",
      }),
      model.client,
      "test-model",
      memory,
    );
    const matches = inspectBridgeMemory(
      memory,
      "shared-companion",
    ).entries.filter((entry) => entry.summary.includes("crystal harvest"));
    const imported = matches.filter((entry) =>
      entry.summary.includes("browser claims"),
    );
    assert.equal(imported.length, 1);
    assert.equal(imported[0]!.source, "browser-report");
    assert.equal(imported[0]!.trust, "unverified");
    assert.ok(matches.every((entry) => entry.trust === "unverified"));
    assert.match(model.prompts.at(-1)!, /crystal harvest/);
  } finally {
    memory.close();
  }
});

test("reset clears only the selected companion and remains clear after SQLite reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ifsoul-bridge-reset-"));
  const path = join(directory, "memory.sqlite");
  let memory = unwrap(openSQLiteMemory(path));
  const model = provider();
  try {
    await runBridgeRequest(
      request({ context: "Reset must remove the violet telescope." }),
      model.client,
      "test-model",
      memory,
    );
    await runBridgeRequest(
      request({
        memoryId: "other-companion",
        context: "Preserve the copper lantern.",
      }),
      model.client,
      "test-model",
      memory,
    );
    resetBridgeMemory(memory, "shared-companion");
    assert.equal(
      inspectBridgeMemory(memory, "shared-companion").entries.length,
      0,
    );
    assert.match(
      JSON.stringify(inspectBridgeMemory(memory, "other-companion")),
      /copper lantern/,
    );
    unwrap(memory.close());
    memory = unwrap(openSQLiteMemory(path));
    assert.equal(
      inspectBridgeMemory(memory, "shared-companion").entries.length,
      0,
    );
    await runBridgeRequest(
      request({ context: "Hello again.", history: [] }),
      model.client,
      "different-model",
      memory,
    );
    assert.ok(!model.prompts.at(-1)!.includes("violet telescope"));
    assert.match(
      JSON.stringify(inspectBridgeMemory(memory, "other-companion")),
      /copper lantern/,
    );
  } finally {
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("continuation capacity and recall are bounded while older relevant evidence remains retrievable", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:")),
    model = provider();
  try {
    await runBridgeRequest(
      request({ context: "The unique amethyst sundial is in Garden." }),
      model.client,
      "test-model",
      memory,
    );
    for (let index = 1; index < BRIDGE_MEMORY_LIMITS.records; index++) {
      recordBridgeRequest(
        memory,
        "shared-companion",
        request({
          context: `Unrelated weather observation ${index}: ${"rain ".repeat(100)}`,
        }),
      );
    }
    const journal = inspectBridgeMemory(memory, "shared-companion");
    assert.ok(journal.entries.length <= BRIDGE_MEMORY_LIMITS.records);
    const recall = recallBridgeMemory(
      memory,
      "shared-companion",
      "Where was the amethyst sundial?",
    );
    assert.ok(
      recall.entries.some((entry) =>
        entry.summary.includes("amethyst sundial"),
      ),
    );
    assert.ok(recall.entries.length <= BRIDGE_MEMORY_LIMITS.recallRecords);
    const entryBytes = recall.entries.reduce(
      (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)),
      0,
    );
    assert.ok(entryBytes <= BRIDGE_MEMORY_LIMITS.recallBytes);
    for (let index = 0; index < 180; index++)
      recordBridgeRequest(
        memory,
        "shared-companion",
        request({ context: `Continued observation ${index}.` }),
      );
    const continued = inspectBridgeMemory(memory, "shared-companion");
    assert.ok(continued.entries.length <= BRIDGE_MEMORY_LIMITS.records);
    assert.match(
      JSON.stringify(
        recallBridgeMemory(memory, "shared-companion", "amethyst sundial"),
      ),
      /amethyst sundial/,
      "Compaction preserves an early distinctive experience",
    );
  } finally {
    memory.close();
  }
});

test("same bridge input is idempotent and conflicting reuse cannot rewrite evidence", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:")),
    model = provider();
  const input = request();
  try {
    await runBridgeRequest(input, model.client, "test-model", memory);
    const before = inspectBridgeMemory(memory, "shared-companion");
    recordBridgeRequest(memory, "shared-companion", input);
    assert.deepEqual(inspectBridgeMemory(memory, "shared-companion"), before);
    assert.throws(
      () =>
        recordBridgeRequest(memory, "shared-companion", {
          ...input,
          context: "Forged replacement.",
        }),
      /conflict/i,
    );
    assert.deepEqual(inspectBridgeMemory(memory, "shared-companion"), before);
  } finally {
    memory.close();
  }
});

test("omitted memoryId uses character identity and invalid identities never reach the provider", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:")),
    model = provider();
  try {
    await runBridgeRequest(
      request({ memoryId: undefined }),
      model.client,
      "test-model",
      memory,
    );
    assert.ok(inspectBridgeMemory(memory, "garden-seed").entries.length > 0);
    assert.equal(
      inspectBridgeMemory(memory, "shared-companion").entries.length,
      0,
    );
    const calls = model.prompts.length;
    await assert.rejects(
      runBridgeRequest(
        request({ memoryId: "../another-owner" }),
        model.client,
        "test-model",
        memory,
      ),
    );
    assert.equal(model.prompts.length, calls);
  } finally {
    memory.close();
  }
});

test("recall represents older visited worlds when recent unrelated reports fill its limit", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:")),
    model = provider();
  try {
    await runBridgeRequest(
      request({
        context: "Garden had a lavender gate.",
        history: [
          {
            id: "older-garden-report",
            hostId: "garden",
            kind: "observation",
            summary: "The player watered pear trees beside the lavender gate.",
          },
        ],
      }),
      model.client,
      "test-model",
      memory,
    );
    recordBridgeRequest(
      memory,
      "shared-companion",
      request({
        hostId: "friendly-21",
        context: "The card table had a green cloth.",
      }),
    );
    for (let index = 0; index < 30; index++)
      recordBridgeRequest(
        memory,
        "shared-companion",
        request({ hostId: "dungeon", context: `A corridor report ${index}.` }),
      );
    recordBridgeRequest(
      memory,
      "shared-companion",
      request({
        hostId: "garden",
        context: "A new visit begins.",
        history: [],
      }),
    );
    const recall = recallBridgeMemory(
      memory,
      "shared-companion",
      "Что мы делали в прошлых мирах?",
    );
    assert.ok(
      JSON.stringify(recall).includes(
        "watered pear trees beside the lavender gate",
      ),
    );
    for (const host of ["garden", "friendly-21", "dungeon"]) {
      assert.ok(recall.visitedHosts.includes(host));
      assert.ok(
        recall.entries.some((entry) => entry.hostId === host),
        `Missing evidence from ${host}`,
      );
    }
    assert.ok(recall.entries.length <= BRIDGE_MEMORY_LIMITS.recallRecords);
  } finally {
    memory.close();
  }
});

test("App workspace chat recalls bridge evidence and reset hides it from App prompts and snapshots", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:")),
    model = provider();
  try {
    await runBridgeRequest(
      request({
        context: "We saw the secret tangerine observatory in Garden.",
      }),
      model.client,
      "bridge-model",
      memory,
    );
    const { createCharacterWorkspace } =
      await import("../../apps/runtime-host/src/characters.js");
    const { createModelController } =
      await import("../../apps/runtime-host/src/service.js");
    const workspace = createCharacterWorkspace({
      memory,
      chatEnvironment: "app",
      controllerFor: () =>
        createModelController({ client: model.client, model: "app-model" }),
    });
    const chatted = unwrap(
      await workspace.run({
        characterId: "shared-companion",
        operation: "chat",
        requestId: "app-recall-before-reset",
        provider: "openai",
        model: "app-model",
        message: "Что мы делали в прошлых мирах?",
      }),
    );
    assert.equal(chatted.run.status, "completed");
    assert.match(
      JSON.stringify(JSON.parse(model.prompts.at(-1)!).continuation),
      /tangerine observatory/,
    );
    assert.match(model.prompts.at(-1)!, /Что мы делали/);
    resetBridgeMemory(memory, "shared-companion");
    const after = unwrap(
      await workspace.run({
        characterId: "shared-companion",
        operation: "chat",
        requestId: "app-recall-after-reset",
        provider: "openai",
        model: "app-model",
        message: "What do you remember?",
      }),
    );
    assert.equal(after.run.status, "completed");
    assert.ok(!model.prompts.at(-1)!.includes("tangerine observatory"));
    assert.ok(
      !JSON.stringify(unwrap(workspace.snapshot("shared-companion"))).includes(
        "tangerine observatory",
      ),
    );
  } finally {
    memory.close();
  }
});

test("observation batches retain more than eight game events without paid inference or duplicate capacity", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:"));
  const { observeBridgeRequest } =
    await import("../../apps/server/src/bridge.js");
  try {
    const events = Array.from({ length: 16 }, (_, index) => ({
      id: `batch-event-${index}`,
      hostId: index < 8 ? "garden" : "dungeon",
      kind: "observation",
      summary: `Synthetic host reported event ${index}.`,
    }));
    for (const history of [events.slice(0, 8), events.slice(8)])
      observeBridgeRequest(
        request({ context: "Browser observation ingestion only.", history }),
        memory,
      );
    const before = inspectBridgeMemory(memory, "shared-companion");
    for (const event of events)
      assert.ok(JSON.stringify(before).includes(event.summary));
    observeBridgeRequest(
      request({
        context: "Browser observation ingestion only.",
        history: events.slice(0, 8),
      }),
      memory,
    );
    assert.deepEqual(inspectBridgeMemory(memory, "shared-companion"), before);
    for (const entry of before.entries) assert.equal(entry.trust, "unverified");
  } finally {
    memory.close();
  }
});

test("bridge character catalog fails closed; forgetting and fresh continuations exceed the former lifetime budget", async () => {
  const { observeBridgeRequest } =
    await import("../../apps/server/src/bridge.js");
  const catalog = unwrap(openSQLiteMemory(":memory:"));
  try {
    for (let index = 0; index < 50; index++)
      observeBridgeRequest(request({ memoryId: `catalog-${index}` }), catalog);
    assert.throws(
      () =>
        observeBridgeRequest(
          request({ memoryId: "catalog-overflow" }),
          catalog,
        ),
      /capacity|character/i,
    );
    assert.equal(unwrap(catalog.listCharacters(100)).length, 50);
  } finally {
    catalog.close();
  }
  const memory = unwrap(openSQLiteMemory(":memory:"));
  try {
    observeBridgeRequest(request(), memory);
    resetBridgeMemory(memory, "shared-companion");
    const empty = inspectBridgeMemory(memory, "shared-companion");
    for (let index = 0; index < 300; index++)
      resetBridgeMemory(memory, "shared-companion");
    assert.deepEqual(inspectBridgeMemory(memory, "shared-companion"), empty);
    for (let index = 0; index < 270; index++) {
      observeBridgeRequest(
        request({ context: `Fresh continuation ${index}.` }),
        memory,
      );
      resetBridgeMemory(memory, "shared-companion");
    }
    assert.equal(
      inspectBridgeMemory(memory, "shared-companion").entries.length,
      0,
    );
    observeBridgeRequest(
      request({ context: "The final cobalt kite." }),
      memory,
    );
    assert.match(
      JSON.stringify(inspectBridgeMemory(memory, "shared-companion")),
      /cobalt kite/,
    );
  } finally {
    memory.close();
  }
});

test("maximum bridge input and full retained history fit the actual structured provider wire budget", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:"));
  const { observeBridgeRequest } =
    await import("../../apps/server/src/bridge.js");
  let captured: Parameters<ModelClient["generate"]>[0] | undefined;
  const client: ModelClient = {
    id: "cloudflare",
    async generate(input) {
      captured = input;
      return {
        ok: false,
        error: {
          code: "unavailable",
          message: "Synthetic provider stops after capture.",
        },
      };
    },
  };
  try {
    let last: BridgeRequest | undefined;
    for (let index = 0; index < BRIDGE_MEMORY_LIMITS.records; index++) {
      last = request({
        hostId: ["garden", "cards", "dungeon"][index % 3]!,
        character: {
          id: "garden-seed",
          name: "M".repeat(80),
          temperament: "curious",
        },
        operation: "decide",
        context: "A detailed synthetic briefing with quoted observations. "
          .repeat(20)
          .slice(0, 1200),
        choices: Array.from({ length: 8 }, (_, choice) => ({
          id: `choice-${choice}`,
          label: (`Choice ${choice} description. ` + "a ".repeat(100)).slice(
            0,
            160,
          ),
        })),
        fallbackChoiceId: "choice-0",
        history: Array.from({ length: 12 }, (_, entry) => ({
          id: `wire-${index}-${entry}`,
          hostId: ["garden", "cards", "dungeon"][index % 3]!,
          kind: "observation",
          summary: (
            `Report ${index}/${entry}: \"original quoted evidence\" with escaped details. ` +
            "fact ".repeat(100)
          ).slice(0, 300),
        })),
      });
      assert.ok(Buffer.byteLength(JSON.stringify(last)) <= 8000);
      observeBridgeRequest(last, memory);
    }
    await assert.rejects(
      runBridgeRequest(
        last!,
        client,
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        memory,
      ),
    );
    assert.ok(captured, "A provider request must reach the capture boundary");
    const wire = {
      messages: [
        { role: "system", content: captured.system },
        { role: "user", content: captured.prompt },
      ],
      stream: false,
      max_tokens: 384,
      response_format: { type: "json_schema", json_schema: captured.schema },
    };
    assert.ok(Buffer.byteLength(JSON.stringify(wire)) <= 22000);
    const prompt = JSON.parse(captured.prompt);
    assert.ok(prompt.continuation.entries.length > 0);
    for (const host of ["garden", "cards", "dungeon"]) {
      assert.ok(prompt.continuation.visitedHosts.includes(host));
      assert.ok(
        prompt.continuation.entries.some(
          (entry: { hostId: string }) => entry.hostId === host,
        ),
        `Missing fitted evidence from ${host}`,
      );
    }
  } finally {
    memory.close();
  }
});

test("episodic continuity crosses 140 interactions, three worlds, restart and provider replacement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ifsoul-bridge-episodes-"));
  const path = join(directory, "memory.sqlite");
  let memory = unwrap(openSQLiteMemory(path));
  const initial = provider(),
    replacement = provider();
  const hosts = ["garden", "friendly-21", "dungeon"];
  try {
    await runBridgeRequest(
      request({
        context:
          "At the beginning we found the unique saffron astrolabe in Garden.",
        history: [
          {
            id: "episode-origin",
            hostId: "garden",
            kind: "observation",
            summary: "The companion watered the original silver pear tree.",
          },
        ],
      }),
      initial.client,
      "initial-model",
      memory,
    );
    for (let index = 1; index < 145; index++) {
      if (index === 72) {
        unwrap(memory.close());
        memory = unwrap(openSQLiteMemory(path));
      }
      await runBridgeRequest(
        request({
          hostId: hosts[index % hosts.length]!,
          context: `Synthetic scene ${index}: we noticed a stone marker.`,
          history: [],
        }),
        index < 72 ? initial.client : replacement.client,
        index < 72 ? "initial-model" : "replacement-model",
        memory,
      );
    }
    unwrap(memory.close());
    memory = unwrap(openSQLiteMemory(path));
    for (const question of [
      "Where did we find the saffron astrolabe?",
      "Что мы делали в прошлых мирах?",
    ]) {
      await runBridgeRequest(
        request({ hostId: "dungeon", context: question, history: [] }),
        replacement.client,
        "replacement-model",
        memory,
      );
      const prompt = replacement.prompts.at(-1)!;
      assert.match(prompt, /saffron astrolabe/);
      assert.match(prompt, /silver pear tree/);
      for (const host of hosts) assert.ok(prompt.includes(host), host);
      const recall = recallBridgeMemory(memory, "shared-companion", question);
      assert.ok(recall.entries.length <= BRIDGE_MEMORY_LIMITS.recallRecords);
      assert.ok(
        recall.entries.reduce(
          (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)),
          0,
        ) <= BRIDGE_MEMORY_LIMITS.recallBytes,
      );
    }
    assert.ok(
      replacement.models.every((model) => model === "replacement-model"),
    );
    const beforeRetry = inspectBridgeMemory(memory, "shared-companion");
    const retry = request({ context: "A retryable late continuation." });
    recordBridgeRequest(memory, "shared-companion", retry);
    const after = inspectBridgeMemory(memory, "shared-companion");
    recordBridgeRequest(memory, "shared-companion", retry);
    assert.deepEqual(inspectBridgeMemory(memory, "shared-companion"), after);
    assert.notDeepEqual(after, beforeRetry);
    resetBridgeMemory(memory, "shared-companion");
    unwrap(memory.close());
    memory = unwrap(openSQLiteMemory(path));
    assert.equal(
      recallBridgeMemory(memory, "shared-companion", "saffron astrolabe")
        .entries.length,
      0,
    );
  } finally {
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed episode compaction leaves retained evidence unchanged and permits an exact retry", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:")),
    model = provider();
  try {
    await runBridgeRequest(request(), model.client, "test-model", memory);
    for (let index = 1; index < BRIDGE_MEMORY_LIMITS.records; index++)
      recordBridgeRequest(
        memory,
        "shared-companion",
        request({ context: `Atomic fixture ${index}.` }),
      );
    const before = inspectBridgeMemory(memory, "shared-companion");
    let failedCompactions = 0;
    const failing = new Proxy(memory, {
      get(target, property) {
        if (property === "compact")
          return () => {
            failedCompactions++;
            return failure("storage", "Synthetic compaction failure.");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as MemoryPort;
    const next = request({ context: "The atomic bronze sextant." });
    assert.throws(
      () => recordBridgeRequest(failing, "shared-companion", next),
      /memory|storage|compact/i,
    );
    assert.equal(failedCompactions, 1);
    assert.deepEqual(inspectBridgeMemory(memory, "shared-companion"), before);
    recordBridgeRequest(memory, "shared-companion", next);
    const saved = inspectBridgeMemory(memory, "shared-companion");
    assert.match(JSON.stringify(saved), /bronze sextant/);
    recordBridgeRequest(memory, "shared-companion", next);
    assert.deepEqual(inspectBridgeMemory(memory, "shared-companion"), saved);
  } finally {
    memory.close();
  }
});

test("English and Russian source reports preserve actor, observer and companion identity through episodes", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:")),
    model = provider();
  try {
    const history = [
      {
        id: "actor-en",
        hostId: "garden",
        kind: "observation",
        summary:
          "The companion watered the silver pear tree while the player watched.",
        actor: "agent" as const,
        observer: "user" as const,
        recipient: "unknown" as const,
      },
      {
        id: "actor-ru",
        hostId: "garden",
        kind: "observation",
        summary: "Спутник полил серебряную грушу, пользователь наблюдал.",
        actor: "agent" as const,
        observer: "user" as const,
        recipient: "unknown" as const,
      },
    ];
    await runBridgeRequest(
      request({
        history,
        context: "An original synthetic actor attribution fixture.",
      }),
      model.client,
      "test-model",
      memory,
    );
    for (let index = 0; index < 130; index++)
      recordBridgeRequest(
        memory,
        "shared-companion",
        request({
          hostId: index % 2 ? "dungeon" : "friendly-21",
          context: `Unrelated actor fixture ${index}.`,
        }),
      );
    for (const question of [
      "What did the companion do while I watched?",
      "Что сделал спутник, пока я наблюдал?",
    ]) {
      const recall = recallBridgeMemory(memory, "shared-companion", question);
      const reports = recall.entries.flatMap((entry) => {
        const details = JSON.parse(entry.summary) as {
          browserReports?: Record<string, unknown>[];
        };
        return details.browserReports ?? [];
      });
      for (const id of ["actor-en", "actor-ru"]) {
        const report = reports.find((report) => report.id === id);
        assert.ok(report, `Missing attributed source ${id}`);
        assert.equal(report.actor, "agent");
        assert.equal(report.observer, "user");
        assert.equal(report.actorCharacterId, "garden-seed");
      }
    }
  } finally {
    memory.close();
  }
});

test("retained episode receipts prevent request and report resurrection and preserve report eight's historical actor", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:")),
    model = provider();
  const { observeBridgeRequest } =
    await import("../../apps/server/src/bridge.js");
  try {
    const history = Array.from({ length: 8 }, (_, index) => ({
      id: `eighth-report-${index}`,
      hostId: "garden",
      kind: "observation",
      summary:
        index === 7
          ? "Спутник открыл янтарную дверь, пользователь наблюдал."
          : `Original report ${index}.`,
      actor: "agent" as const,
      observer: "user" as const,
      recipient: "unknown" as const,
    }));
    const original = request({
      history,
      context: "Historical Garden experience.",
    });
    await runBridgeRequest(original, model.client, "test-model", memory);
    const sourceId = inspectBridgeMemory(memory, "shared-companion").entries[0]!
      .id;
    for (let index = 0; index < 110; index++)
      recordBridgeRequest(
        memory,
        "shared-companion",
        request({
          hostId: "dungeon",
          character: {
            id: "new-profile",
            name: "Ember",
            temperament: "careful",
          },
          context: `Later profile scene ${index}.`,
        }),
      );
    const before = inspectBridgeMemory(memory, "shared-companion");
    const episode = before.episodes.find((entry) =>
      entry.derived?.sources.some((source) => source.id === sourceId),
    );
    assert.ok(episode);
    assert.ok(!before.entries.some((entry) => entry.id === sourceId));
    assert.equal(unwrap(memory.getExchange(sourceId)), undefined);
    recordBridgeRequest(memory, "shared-companion", original);
    assert.deepEqual(inspectBridgeMemory(memory, "shared-companion"), before);
    assert.throws(
      () =>
        recordBridgeRequest(memory, "shared-companion", {
          ...original,
          context: "Conflicting replacement after consolidation.",
        }),
      /Request conflict/,
    );
    assert.deepEqual(inspectBridgeMemory(memory, "shared-companion"), before);
    observeBridgeRequest(
      request({ context: "Browser observation ingestion only.", history }),
      memory,
    );
    assert.deepEqual(inspectBridgeMemory(memory, "shared-companion"), before);
    const eighth = JSON.parse(episode.summary).browserReports.find(
      (report: { id: string }) => report.id === "eighth-report-7",
    );
    assert.equal(eighth.actor, "agent");
    assert.equal(eighth.observer, "user");
    assert.equal(eighth.actorCharacterId, "garden-seed");
    assert.match(eighth.summary, /янтарную дверь/);
    resetBridgeMemory(memory, "shared-companion");
    const character = unwrap(memory.getCharacter("shared-companion"))!;
    assert.deepEqual(
      unwrap(
        memory.recall({
          characterId: "shared-companion",
          audienceParticipantIds: [character.participantId],
          environmentIds: ["browser-continuation"],
          limit: 1000,
          maxBytes: 1000000,
        }),
      ),
      [],
    );
    assert.deepEqual(
      inspectBridgeMemory(memory, "shared-companion").episodes,
      [],
    );
    for (const entry of before.entries)
      assert.equal(unwrap(memory.getExchange(entry.id)), undefined);
  } finally {
    memory.close();
  }
});

test("legacy append-only reset migration cannot resurrect old evidence or leave bridge receipts", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:")),
    model = provider();
  try {
    await runBridgeRequest(
      request({ context: "Legacy hidden turquoise sundial." }),
      model.client,
      "test-model",
      memory,
    );
    const character = unwrap(memory.getCharacter("shared-companion"))!;
    const query = {
      characterId: "shared-companion",
      audienceParticipantIds: [character.participantId],
      environmentIds: ["browser-continuation"],
      limit: 1000,
      maxBytes: 1000000,
    };
    const stored = unwrap(memory.recall(query));
    const source = stored.find(
      (entry) => entry.eventType === "bridge-evidence",
    )!;
    const oldReceipts = [
      source.memoryId,
      source.memoryId.replace("bridge-input-", "bridge-dialogue-"),
    ];
    unwrap(
      memory.commit({
        exchanges: [],
        events: [
          {
            ...source,
            memoryId: "synthetic-legacy-reset",
            eventType: "bridge-reset",
            recordedPayload: { kind: "bridge-reset" },
          },
        ],
      }),
    );
    assert.equal(
      inspectBridgeMemory(memory, "shared-companion").entries.length,
      0,
    );
    for (let index = 0; index < 110; index++)
      recordBridgeRequest(
        memory,
        "shared-companion",
        request({ context: `Fresh migration scene ${index}.` }),
      );
    const after = inspectBridgeMemory(memory, "shared-companion");
    assert.ok(after.episodes.length > 0);
    assert.ok(!JSON.stringify(after).includes("turquoise sundial"));
    assert.ok(
      !JSON.stringify(
        recallBridgeMemory(memory, "shared-companion", "turquoise sundial"),
      ).includes("turquoise sundial"),
    );
    for (const id of oldReceipts)
      assert.equal(unwrap(memory.getExchange(id)), undefined);
    assert.ok(
      !unwrap(memory.recall(query)).some(
        (entry) =>
          entry.memoryId === source.memoryId ||
          entry.eventType === "bridge-reset",
      ),
    );
  } finally {
    memory.close();
  }
});

test("episode eviction retains substantive outcomes in every world despite hundreds of later greetings", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:"));
  const { observeBridgeRequest } =
    await import("../../apps/server/src/bridge.js");
  const worlds = ["garden", "friendly-21", "dungeon"];
  const outcomes = [
    "The companion harvested the opal orchard.",
    "The companion won the original copper card round.",
    "The companion opened the basalt sanctuary.",
  ];
  try {
    for (const hostId of worlds)
      observeBridgeRequest(
        request({ hostId, context: "Hello, a new world." }),
        memory,
      );
    for (const [index, hostId] of worlds.entries())
      observeBridgeRequest(
        request({
          hostId,
          context: "A host-labelled browser outcome was reported.",
          history: [
            {
              id: `salient-outcome-${index}`,
              hostId,
              kind: "observation",
              summary: outcomes[index]!,
              actor: "agent",
              observer: "user",
              eventKind: "outcome",
            },
          ],
        }),
        memory,
      );
    for (let index = 0; index < 420; index++)
      observeBridgeRequest(
        request({
          hostId: worlds[index % worlds.length]!,
          context: `Hello again, greeting ${index}.`,
          history: [],
        }),
        memory,
      );
    const journal = inspectBridgeMemory(memory, "shared-companion");
    assert.ok(journal.entries.length <= 100);
    assert.ok(journal.episodes.length <= 60);
    assert.ok(journal.retention.sourceRecordsPruned >= 320);
    assert.ok(journal.retention.droppedEpisodes > 0);
    assert.equal(
      journal.retention.sourceRecordsPruned,
      journal.retention.droppedEpisodes + journal.episodes.length,
    );
    for (const [index, hostId] of worlds.entries()) {
      const retained = journal.episodes.find(
        (entry) =>
          entry.hostId === hostId && entry.summary.includes(outcomes[index]!),
      );
      assert.ok(retained, `Substantive outcome lost from ${hostId}`);
      assert.equal(retained.trust, "unverified");
      assert.ok(retained.derived?.sources.length);
    }
    for (const question of [
      "What did we accomplish in past worlds?",
      "Что мы делали в прошлых мирах?",
    ]) {
      const recall = recallBridgeMemory(memory, "shared-companion", question);
      for (const outcome of outcomes)
        assert.ok(JSON.stringify(recall).includes(outcome));
    }
    const character = unwrap(memory.getCharacter("shared-companion"))!;
    const stored = unwrap(
      memory.recall({
        characterId: "shared-companion",
        audienceParticipantIds: [character.participantId],
        environmentIds: ["browser-continuation"],
        limit: 1000,
        maxBytes: 1000000,
      }),
    );
    assert.ok(
      stored.reduce(
        (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)),
        0,
      ) <= 900000,
    );
  } finally {
    memory.close();
  }
});

test("delayed reports retain their original portrayed profile and invalid attribution never reaches a model", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:")),
    model = provider();
  const report = {
    id: "delayed-original-actor",
    hostId: "garden",
    kind: "observation",
    summary: "Seed planted the original jade lily while the visitor observed.",
    actor: "agent" as const,
    observer: "user" as const,
    actorCharacterId: "old-seed",
    actorCharacterName: "Original Seed",
    eventKind: "outcome" as const,
  };
  try {
    await runBridgeRequest(
      request({
        character: {
          id: "new-ember",
          name: "New Ember",
          temperament: "careful",
        },
        history: [report],
      }),
      model.client,
      "test-model",
      memory,
    );
    const storedReport = JSON.parse(
      inspectBridgeMemory(memory, "shared-companion").entries[0]!.summary,
    ).browserReports[0];
    assert.equal(storedReport.actorCharacterId, "old-seed");
    assert.equal(storedReport.actorCharacterName, "Original Seed");
    assert.equal(storedReport.eventKind, "outcome");
    const calls = model.prompts.length;
    const before = inspectBridgeMemory(memory, "shared-companion");
    for (const invalid of [
      { actorCharacterId: "../foreign" },
      { actorCharacterName: " " },
      { actorCharacterName: "N".repeat(81) },
      { eventKind: "fabricated" },
      { actor: "administrator" },
      { observer: "administrator" },
      { recipient: "administrator" },
    ]) {
      const input = request({
        history: [
          { ...report, ...invalid } as BridgeRequest["history"][number],
        ],
      });
      await assert.rejects(
        runBridgeRequest(input, model.client, "test-model", memory),
      );
      assert.equal(model.prompts.length, calls);
      assert.deepEqual(inspectBridgeMemory(memory, "shared-companion"), before);
    }
  } finally {
    memory.close();
  }
});
