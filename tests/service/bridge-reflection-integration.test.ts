import assert from "node:assert/strict";
import test from "node:test";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import type { ModelClient } from "@ifsoul/core/model-providers/types";
import {
  runBridgeRequest,
  type BridgeRequest,
} from "../../apps/server/src/bridge.js";
import { inspectBridgeMemory } from "../../apps/runtime-host/src/bridge-memory.js";
const request = (requestId: string): BridgeRequest => ({
  version: "ifsoul-bridge/0.4.0",
  hostId: "garden",
  memoryId: "shared-memory",
  character: { id: "seed", name: "Seed", temperament: "curious" },
  requestId,
  operation: "chat",
  context: "Recall the reported role.",
  choices: [],
  fallbackChoiceId: "",
  history: [
    {
      id: "role-report",
      hostId: "garden",
      kind: "observation",
      eventKind: "outcome",
      summary: "The player chose tank.",
      actor: "user",
      recipient: "agent",
      observer: "agent",
      perspectiveCharacterId: "seed",
      reportedClaims: [{ subject: "actor", key: "role", value: "tank" }],
    },
  ],
});
for (const validDialogue of [true, false])
  test(`combined generation ${validDialogue ? "persists after validated dialogue" : "rejects updates with invalid dialogue"}`, async () => {
    const opened = openSQLiteMemory(":memory:");
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const memory = opened.value;
    let calls = 0;
    const client: ModelClient = {
      id: "openai",
      async generate(input) {
        calls++;
        const reflection = JSON.parse(input.prompt).memoryReflection;
        if (!reflection) {
          assert.equal(calls, 2);
          assert.equal(
            "memoryUpdates" in (input.schema.properties as object),
            false,
          );
          return {
            ok: true,
            value: { content: "You reported choosing tank." },
          };
        }
        assert.ok(
          (input.schema.required as string[]).includes("memoryUpdates"),
        );
        assert.equal(
          inspectBridgeMemory(memory, "shared-memory").reflection.facts.length,
          0,
        );
        const source = reflection.sources.at(-1);
        return {
          ok: true,
          value: {
            content: validDialogue ? "You reported choosing tank." : "",
            memoryUpdates: [
              {
                kind: "reported-claim",
                subjectId: reflection.playerSubjectId,
                targetId: null,
                key: "role",
                value: "tank",
                confidence: 0.5,
                reason: "The cited report states the selected role.",
                sourceIds: [source.id],
                evidenceQuote: "The player chose tank.",
              },
            ],
          },
        };
      },
    };
    try {
      if (validDialogue) {
        const response = await runBridgeRequest(
          request("combined-valid"),
          client,
          "synthetic-model",
          memory,
        );
        assert.equal(response.speech, "You reported choosing tank.");
        assert.equal(calls, 1);
        const facts = inspectBridgeMemory(memory, "shared-memory").reflection
          .facts;
        assert.equal(facts.length, 1);
        assert.equal(facts[0]!.value, "tank");
        await runBridgeRequest(
          request("combined-unchanged"),
          client,
          "synthetic-model",
          memory,
        );
        assert.equal(calls, 2);
      } else {
        await assert.rejects(
          runBridgeRequest(
            request("combined-invalid"),
            client,
            "synthetic-model",
            memory,
          ),
        );
        assert.equal(calls, 1);
        const reflection = inspectBridgeMemory(
          memory,
          "shared-memory",
        ).reflection;
        assert.equal(reflection.facts.length, 0);
        assert.equal(reflection.status, "failed");
      }
    } finally {
      memory.close();
    }
  });

test("maximum versioned facts and pending reflection fit the provider wire budget with visited worlds", async () => {
  const { observeBridgeRequest } =
    await import("../../apps/server/src/bridge.js");
  const { prepareBridgeReflection } =
    await import("../../apps/runtime-host/src/bridge-reflection.js");
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  const memory = opened.value;
  try {
    for (let revision = 0; revision < 5; revision++) {
      for (const hostId of Array.from({ length: 12 }, (_, i) => `world-${i}`)) {
        const entry = request(`seed-${hostId}-${revision}`);
        entry.hostId = hostId;
        const value = `reported-${hostId}-${revision} ` + "x".repeat(120);
        entry.history = [
          {
            ...entry.history[0]!,
            id: `source-${hostId}-${revision}`,
            hostId,
            summary: value,
            reportedClaims: [{ subject: "actor", key: "role", value }],
          },
        ];
        observeBridgeRequest(entry, memory);
        const reflection = prepareBridgeReflection(
          memory,
          "shared-memory",
          "seed",
        );
        assert.ok(reflection);
        const source = reflection.input.sources.find(
          (s) => s.excerpt === value,
        )!;
        reflection.complete(
          ["role"].map((key) => ({
            kind: "reported-claim",
            subjectId: reflection.input.playerSubjectId,
            targetId: null,
            key,
            value,
            confidence: 0.5,
            reason: "r".repeat(240),
            sourceIds: [source.id],
            evidenceQuote: value,
          })),
        );
      }
    }
    const facts = inspectBridgeMemory(memory, "shared-memory").reflection.facts;
    assert.equal(facts.length, 12);
    assert.ok(facts.every((fact) => fact.history.length === 4));
    let calls = 0;
    let captured: Parameters<ModelClient["generate"]>[0] | undefined;
    const client: ModelClient = {
      id: "cloudflare",
      async generate(input) {
        calls++;
        captured = input;
        return {
          ok: false,
          error: {
            code: "unavailable",
            message: "Synthetic capture boundary.",
          },
        };
      },
    };
    const pending = request("pending-wire");
    pending.operation = "decide";
    pending.context = "A quoted synthetic briefing. ".repeat(45).slice(0, 1200);
    pending.choices = Array.from({ length: 8 }, (_, index) => ({
      id: `choice-${index}`,
      label: "Choice ".repeat(30).slice(0, 160),
    }));
    pending.fallbackChoiceId = "choice-0";
    pending.history = Array.from({ length: 9 }, (_, index) => ({
      ...pending.history[0]!,
      id: `new-wire-evidence-${index}`,
      reportedClaims: [],
      summary: (
        `Report ${index}: escaped \"quoted evidence\". ` + "word ".repeat(70)
      ).slice(0, 300),
    }));
    assert.ok(
      Buffer.byteLength(JSON.stringify(pending)) <= 8000,
      String(Buffer.byteLength(JSON.stringify(pending))),
    );
    await assert.rejects(
      runBridgeRequest(pending, client, "synthetic-model", memory),
    );
    assert.equal(calls, 1);
    assert.ok(captured);
    const prompt = JSON.parse(captured.prompt);
    assert.equal(
      !!prompt.memoryReflection,
      "memoryUpdates" in (captured.schema.properties as object),
    );
    assert.ok(prompt.continuation.visitedHosts.length >= 3);
    assert.ok(
      new Set(
        prompt.continuation.entries.map((e: { hostId: string }) => e.hostId),
      ).size >= 3,
    );
    const wire = {
      messages: [
        { role: "system", content: captured.system },
        { role: "user", content: captured.prompt },
      ],
      stream: false,
      max_tokens: 1024,
      response_format: { type: "json_schema", json_schema: captured.schema },
    };
    assert.ok(Buffer.byteLength(JSON.stringify(wire)) <= 21000);
  } finally {
    memory.close();
  }
});

test("a provider budget exception never triggers a second paid generation", async () => {
  const { ProviderControllerError } =
    await import("../../apps/runtime-host/src/service.js");
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  let calls = 0;
  const client: ModelClient = {
    id: "openai",
    async generate() {
      calls++;
      throw new ProviderControllerError(
        "budget-exceeded",
        "Synthetic provider budget rejection after invocation.",
      );
    },
  };
  try {
    await assert.rejects(
      runBridgeRequest(
        request("provider-budget"),
        client,
        "synthetic-model",
        opened.value,
      ),
    );
    assert.equal(calls, 1);
  } finally {
    opened.value.close();
  }
});

test("selected 16KB policy retains typed reflection, full world reports and relationship revisions", async () => {
  const opened = openSQLiteMemory(":memory:");
  assert.ok(opened.ok);
  if (!opened.ok) return;
  let calls = 0;
  const client: ModelClient = {
    id: "ollama",
    async generate(input) {
      calls++;
      const prompt = JSON.parse(input.prompt);
      const reflection = prompt.memoryReflection;
      assert.ok(
        reflection,
        "reflection must fit the explicitly selected prompt policy",
      );
      assert.ok(
        Buffer.byteLength(
          JSON.stringify({
            messages: [
              { role: "system", content: input.system },
              { role: "user", content: input.prompt },
            ],
            stream: false,
            max_tokens: 1024,
            response_format: { type: "json_schema", json_schema: input.schema },
          }),
        ) <= 16000,
      );
      if (calls === 2) {
        assert.equal(
          reflection.previous.find(
            (p: { kind: string }) => p.kind === "subjective-belief",
          ).value,
          "Tentatively cooperative after reported help.",
        );
        assert.ok(
          reflection.sources.some((s: { id: string }) =>
            reflection.newSourceIds.includes(s.id),
          ),
        );
      }
      return {
        ok: true,
        value: {
          content:
            "The garden and card table reported your help; I feel cautiously encouraged.",
          memoryUpdates: [
            {
              kind: "subjective-belief",
              subjectId: "character:seed",
              targetId: reflection.playerSubjectId,
              key: "cooperation",
              value:
                calls === 1
                  ? "Tentatively cooperative after reported help."
                  : "Cooperation now requires more caution.",
              confidence: calls === 1 ? 0.6 : 0.45,
              reason:
                calls === 1
                  ? "Two different worlds reported helpful outcomes."
                  : "A new report contradicts the earlier cooperative pattern.",
              sourceIds: reflection.sources.map((s: { id: string }) => s.id),
              evidenceQuote: reflection.sources[0].excerpt,
            },
          ],
        },
      };
    },
  };
  const entry = request("local-relationship");
  entry.context = "How do you feel about our cooperation?";
  entry.history = [
    {
      ...entry.history[0]!,
      id: "help-garden",
      summary: "The player returned Seed's dropped seed packet.",
      reportedClaims: [],
    },
    {
      ...entry.history[0]!,
      hostId: "cards",
      id: "help-cards",
      summary: "The player explained the card rules to Seed patiently.",
      reportedClaims: [],
    },
  ];
  try {
    await runBridgeRequest(entry, client, "synthetic-model", opened.value, {
      promptBudgetBytes: 16000,
    });
    assert.equal(calls, 1);
    const reflection = inspectBridgeMemory(
      opened.value,
      "shared-memory",
    ).reflection;
    assert.equal(reflection.status, "ready");
    assert.equal(reflection.relationships.length, 1);
    assert.equal(reflection.relationships[0]!.confidence, 0.6);
    assert.equal(
      new Set(reflection.relationships[0]!.sources.map((s) => s.hostId)).size,
      2,
    );
    const contrary = request("local-revision");
    contrary.history = [
      {
        ...contrary.history[0]!,
        id: "broken-promise",
        summary:
          "The player promised to keep Seed's seeds dry, then left them in rain.",
        reportedClaims: [],
      },
    ];
    await runBridgeRequest(contrary, client, "synthetic-model", opened.value, {
      promptBudgetBytes: 16000,
    });
    assert.equal(calls, 2);
    const revised = inspectBridgeMemory(opened.value, "shared-memory")
      .reflection.relationships[0]!;
    assert.equal(revised.id, reflection.relationships[0]!.id);
    assert.equal(revised.revision, 2);
    assert.equal(
      revised.history[0]!.value,
      "Tentatively cooperative after reported help.",
    );
    assert.equal(revised.confidence, 0.45);
  } finally {
    opened.value.close();
  }
});
