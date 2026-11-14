import assert from "node:assert/strict";
import test from "node:test";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import type { ModelClient } from "@ifsoul/core/model-providers/types";
import {
  observeBridgeRequest,
  runBridgeRequest,
  type BridgeRequest,
} from "../../apps/server/src/bridge.js";
import {
  latestBridgeUserMessage,
  inspectBridgeMemory,
  bridgeMemoryEvent,
} from "../../apps/runtime-host/src/bridge-memory.js";

const base: BridgeRequest = {
  version: "ifsoul-bridge/0.4.0",
  hostId: "garden",
  memoryId: "shared-memory",
  character: { id: "mira", name: "Mira", temperament: "careful" },
  requestId: "first",
  operation: "chat",
  context: "Как дела?",
  choices: [],
  fallbackChoiceId: "",
  history: [],
};

test("host reactions preserve the latest actual user utterance across worlds and portrayals", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const captures: { prompt: Record<string, unknown>; system: string }[] = [];
  const client: ModelClient = {
    id: "ollama",
    async generate(input) {
      captures.push({ prompt: JSON.parse(input.prompt), system: input.system });
      return { ok: true, value: { content: "A synthetic reaction." } };
    },
  };
  try {
    await runBridgeRequest(base, client, "test", opened.value);
    await runBridgeRequest(
      {
        ...base,
        requestId: "other-profile",
        character: { id: "rook", name: "Rook", temperament: "bold" },
        context: "Bonjour",
      },
      client,
      "test",
      opened.value,
    );
    await runBridgeRequest(
      {
        ...base,
        requestId: "transition",
        operation: "speak",
        hostId: "dungeon",
        context: "We moved worlds. React to this scene.",
      },
      client,
      "test",
      opened.value,
    );
    let captured = captures.at(-1)!;
    assert.equal(captured.prompt.languageReferenceMessage, "Как дела?");
    assert.equal(
      captured.prompt.hostSpeechContext,
      "We moved worlds. React to this scene.",
    );
    assert.equal(captured.prompt.speechTrigger, "host");
    assert.equal(captured.prompt.latestUserMessage, undefined);
    assert.equal(captured.prompt.operation, "host-speech");
    assert.equal(Object.keys(captured.prompt).at(-1), "hostSpeechContext");
    assert.match(
      captured.system,
      /There is no new user question in this request/,
    );
    assert.match(captured.system, /do not answer that old question again/);
    assert.match(
      captured.system,
      /Never choose the response language from hostSpeechContext/,
    );
    await runBridgeRequest(
      {
        ...base,
        requestId: "room",
        operation: "speak",
        hostId: "dungeon",
        context: "A new room appears. React briefly.",
      },
      client,
      "test",
      opened.value,
    );
    assert.equal(captures.at(-1)!.prompt.languageReferenceMessage, "Как дела?");
    await runBridgeRequest(
      {
        ...base,
        requestId: "english",
        hostId: "chat",
        context: "How are you?",
      },
      client,
      "test",
      opened.value,
    );
    await runBridgeRequest(
      {
        ...base,
        requestId: "next-room",
        hostId: "dungeon",
        operation: "speak",
        context: "Another room appears.",
      },
      client,
      "test",
      opened.value,
    );
    assert.equal(
      captures.at(-1)!.prompt.languageReferenceMessage,
      "How are you?",
    );
    await runBridgeRequest(
      {
        ...base,
        requestId: "explicit",
        operation: "speak",
        language: "fr",
        context: "A host instruction in English.",
      },
      client,
      "test",
      opened.value,
    );
    assert.match(
      captures.at(-1)!.system,
      /explicitly requested language locale fr/,
    );
    const saved = inspectBridgeMemory(opened.value, "shared-memory");
    assert.deepEqual(
      saved.entries
        .filter((entry) => entry.kind === "chat")
        .map((entry) => JSON.parse(entry.summary).browserContext),
      ["Как дела?", "Bonjour", "How are you?"],
    );
  } finally {
    opened.value.close();
  }
});

test("latest actual user message survives hundreds of host requests and ignores host contexts", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  try {
    observeBridgeRequest(base, opened.value);
    for (let i = 0; i < 105; i++)
      observeBridgeRequest(
        {
          ...base,
          operation: "speak",
          requestId: `host-${i}`,
          context: "English host scene context.",
        },
        opened.value,
      );
    assert.ok(
      inspectBridgeMemory(opened.value, "shared-memory").entries.some(
        (entry) => entry.kind === "chat",
      ),
    );
    assert.equal(
      latestBridgeUserMessage(opened.value, "shared-memory", "mira"),
      "Как дела?",
    );
  } finally {
    opened.value.close();
  }
});

test("App user chat participates in language continuity, while host-only memory has no user utterance", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  try {
    let prompt: Record<string, unknown> = {};
    let system = "";
    const client: ModelClient = {
      id: "ollama",
      async generate(input) {
        prompt = JSON.parse(input.prompt);
        system = input.system;
        return { ok: true, value: { content: "A synthetic reaction." } };
      },
    };
    await runBridgeRequest(
      { ...base, operation: "speak", context: "An English host scene." },
      client,
      "test",
      opened.value,
    );
    assert.equal(prompt.languageReferenceMessage, "");
    assert.equal(prompt.hostSpeechContext, "An English host scene.");
    assert.match(system, /If it is empty, use character.speechStyle.languages/);
    assert.equal(
      latestBridgeUserMessage(opened.value, "shared-memory", "mira"),
      "",
    );
    const event = bridgeMemoryEvent(
      opened.value,
      "shared-memory",
      "app-language",
      "laboratory-run",
      {
        kind: "laboratory-run",
        run: {
          operation: "chat",
          message: "Bonjour, comment vas-tu?",
          persona: { characterId: "mira" },
          startedAt: new Date().toISOString(),
        },
      },
    );
    event.environmentId = "app-chat";
    const owned = opened.value.getCharacter("shared-memory");
    assert.ok(owned.ok && owned.value);
    if (!owned.ok || !owned.value) return;
    event.scope.participantIds = [
      owned.value.participantId,
      "participant-local",
    ];
    assert.ok(opened.value.commit({ exchanges: [], events: [event] }).ok);
    assert.equal(
      latestBridgeUserMessage(opened.value, "shared-memory", "mira"),
      "Bonjour, comment vas-tu?",
    );
    assert.equal(
      latestBridgeUserMessage(opened.value, "shared-memory", "rook"),
      "",
    );
    await runBridgeRequest(
      {
        ...base,
        requestId: "after-app",
        operation: "speak",
        context: "An English host scene after App chat.",
      },
      client,
      "test",
      opened.value,
    );
    assert.equal(prompt.languageReferenceMessage, "Bonjour, comment vas-tu?");
    assert.equal(
      prompt.hostSpeechContext,
      "An English host scene after App chat.",
    );
    const foreign = structuredClone(event);
    foreign.memoryId = "private-app-language";
    foreign.scope.participantIds = ["foreign-private-participant"];
    foreign.recordedPayload.run = {
      operation: "chat",
      message: "Private unrelated message",
      persona: { characterId: "mira" },
      startedAt: new Date(Date.now() + 1000).toISOString(),
    };
    assert.ok(opened.value.commit({ exchanges: [], events: [foreign] }).ok);
    assert.equal(
      latestBridgeUserMessage(opened.value, "shared-memory", "mira"),
      "Bonjour, comment vas-tu?",
    );
  } finally {
    opened.value.close();
  }
});
