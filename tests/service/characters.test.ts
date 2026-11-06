import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import { createCharacterWorkspace } from "../../apps/runtime-host/src/characters.js";
import { createScenarioController } from "../../apps/runtime-host/src/service.js";
import type { Result } from "@ifsoul/core/memory/port";
const unwrap = <T>(r: Result<T>): T => {
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw Error();
  return r.value;
};
const draft = (requestId: string) => ({
  requestId,
  name: requestId,
  description: "An original fictional companion.",
  speechStyle: "Brief and warm.",
  biography: "An authored story, not lived evidence.",
});
const run = (
  characterId: string,
  operation: "plan" | "chat",
  requestId = "same-request",
) => ({
  characterId,
  operation,
  requestId,
  provider: "scenario" as const,
  model: "synthetic-v1",
  ...(operation === "chat" ? { message: "What happened?" } : {}),
});
test("characters have isolated host outcomes, participant scopes and request identities across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ifsoul-characters-"));
  let memory = unwrap(openSQLiteMemory(join(dir, "memory.sqlite")));
  try {
    let workspace = createCharacterWorkspace({
      memory,
      controllerFor: () => createScenarioController(),
    });
    const a = unwrap(workspace.createCharacter(draft("alpha"))).character;
    const b = unwrap(workspace.createCharacter(draft("beta"))).character;
    assert.notEqual(a.participantId, b.participantId);
    const planned = unwrap(await workspace.run(run(a.characterId, "plan")));
    assert.equal(planned.run.status, "completed");
    assert.equal(unwrap(workspace.snapshot(b.characterId)).memories.length, 0);
    const bChat = unwrap(await workspace.run(run(b.characterId, "chat")));
    assert.equal(bChat.run.status, "completed");
    assert.equal(bChat.result.type, "chat");
    if (
      bChat.result.type === "chat" &&
      bChat.result.response.output.type === "utterance"
    )
      assert.match(
        bChat.result.response.output.content,
        /no selected host report/,
      );
    for (const event of bChat.memories) {
      assert.equal(event.characterId, b.characterId);
      assert(!JSON.stringify(event).includes(a.participantId));
    }
    unwrap(memory.close());
    memory = unwrap(openSQLiteMemory(join(dir, "memory.sqlite")));
    workspace = createCharacterWorkspace({
      memory,
      controllerFor: () => createScenarioController(),
    });
    assert.equal(unwrap(workspace.listCharacters()).length, 3);
    assert.equal(
      unwrap(workspace.snapshot()).character.characterId,
      "character-lumen",
    );
    const aChat = unwrap(
      await workspace.run(run(a.characterId, "chat", "chat-after-restart")),
    );
    assert.equal(aChat.run.status, "completed");
    if (
      aChat.result.type === "chat" &&
      aChat.result.response.output.type === "utterance"
    )
      assert.match(
        aChat.result.response.output.content,
        /reported that I inspected/,
      );
    else assert.fail("Expected dialogue");
  } finally {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("creation retries preserve identity and reject profile mutation or injected state", () => {
  const memory = unwrap(openSQLiteMemory(":memory:"));
  try {
    const workspace = createCharacterWorkspace({
      memory,
      controllerFor: () => createScenarioController(),
    });
    const first = unwrap(workspace.createCharacter(draft("alpha")));
    assert.deepEqual(unwrap(workspace.createCharacter(draft("alpha"))), first);
    assert.equal(
      workspace.createCharacter({ ...draft("alpha"), name: "Changed" }).ok,
      false,
    );
    assert.equal(
      workspace.createCharacter({
        ...draft("other"),
        memoryRecordIds: ["forged"],
      } as never).ok,
      false,
    );
    assert.equal(
      workspace.createCharacter({ ...draft("bad"), name: " ".repeat(2) }).ok,
      false,
    );
    assert.equal(
      workspace.createCharacter({
        ...draft("bad"),
        biography: "x".repeat(3001),
      }).ok,
      false,
    );
    assert.equal(workspace.snapshot("unknown").ok, false);
    assert.equal(unwrap(workspace.listCharacters()).length, 2);
    assert.equal(memory.listCharacters(1000).ok, false);
  } finally {
    memory.close();
  }
});

test("profile files round-trip attribution/extensions while imports start fresh and reject state", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:"));
  try {
    const workspace = createCharacterWorkspace({
      memory,
      controllerFor: () => createScenarioController(),
    });
    const a = unwrap(workspace.createCharacter(draft("source"))).character;
    await workspace.run(run(a.characterId, "chat"));
    const template = unwrap(workspace.exportCharacter(a.characterId));
    template.extensions = {
      "example.test": { note: "preserve this optional metadata" },
    };
    template.authorship = {
      authors: ["Synthetic Author"],
      license: "Apache-2.0",
    };
    const imported = unwrap(
      workspace.importCharacter({ requestId: "imported", template }),
    );
    assert.equal(imported.memories.length, 0);
    assert.notEqual(imported.character.characterId, a.characterId);
    assert.deepEqual(
      unwrap(workspace.exportCharacter(imported.character.characterId)),
      template,
    );
    assert.deepEqual(
      unwrap(workspace.importCharacter({ requestId: "imported", template })),
      imported,
    );
    for (const invalid of [
      { ...template, kind: "character-instance" },
      { ...template, memoryRecordIds: ["private"] },
      { ...template, requiredExtensions: ["example.test"] },
      { ...template, extensions: { "example.test": "x".repeat(65536) } },
    ])
      assert.equal(
        workspace.importCharacter({ requestId: "bad", template: invalid }).ok,
        false,
      );
    assert.equal(unwrap(workspace.listCharacters()).length, 3);
    assert(!JSON.stringify(template).includes("What happened?"));
  } finally {
    memory.close();
  }
});

test("independent portrayal uses selected memory without moving history or rebinding participants", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:"));
  try {
    let observed: import("@ifsoul/core/runtime").ControllerInput | undefined;
    const workspace = createCharacterWorkspace({
      memory,
      controllerFor: () => async (input, signal) => {
        observed = input;
        return createScenarioController()(input, signal);
      },
    });
    const a = unwrap(workspace.createCharacter(draft("alice"))).character;
    const b = unwrap(workspace.createCharacter(draft("clock"))).character;
    unwrap(await workspace.run(run(a.characterId, "plan", "prior")));
    const before = unwrap(workspace.snapshot(a.characterId));
    const request = {
      ...run(b.characterId, "chat", "shared"),
      memoryCharacterId: a.characterId,
    };
    const cross = unwrap(await workspace.run(request));
    assert.equal(cross.run.status, "completed");
    assert.equal(observed?.character.profile.name, b.profile.name);
    assert.equal(observed?.character.characterId, a.characterId);
    assert.equal(observed?.character.participantId, a.participantId);
    assert.equal(observed?.portrayal?.memoryOwnerName, a.profile.name);
    assert.equal(cross.persona?.characterId, b.characterId);
    assert.equal(cross.run.persona?.characterId, b.characterId);
    assert.equal(cross.character.characterId, a.characterId);
    assert.equal(unwrap(workspace.snapshot(b.characterId)).memories.length, 0);
    for (const event of before.memories)
      assert.deepEqual(
        cross.memories.find((e) => e.memoryId === event.memoryId),
        event,
      );
    assert.deepEqual(unwrap(await workspace.run(request)), cross);
    assert.equal(workspace.snapshot(b.characterId, "unknown").ok, false);
    const own = unwrap(
      await workspace.run(run(b.characterId, "chat", "shared")),
    );
    assert.equal(own.run.status, "completed");
    assert.notEqual(own.run.requestId, cross.run.requestId);
  } finally {
    memory.close();
  }
});

test("generation validates output, sends no history and durably reuses requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ifsoul-authoring-"));
  let memory = unwrap(openSQLiteMemory(join(dir, "memory.sqlite")));
  let calls = 0;
  const client: import("@ifsoul/core/model-providers/types").ModelClient = {
    id: "openai",
    async generate(input) {
      calls++;
      assert(!input.prompt.includes("memoryRecordIds"));
      return {
        ok: true,
        value: {
          name: "Moss",
          description: "A curious fern.",
          speechStyle: "Soft short phrases.",
          biography: "An original fictional fern in a glass garden.",
        },
      };
    },
  };
  const options = () => ({
    memory,
    controllerFor: () => createScenarioController(),
    clientFor: async () => client,
  });
  const request = {
    requestId: "generate-one",
    provider: "openai" as const,
    model: "test-model",
    brief: "An original fern",
  };
  try {
    let workspace = createCharacterWorkspace(options());
    const template = unwrap(await workspace.generateCharacter(request));
    assert.equal(template.kind, "character-template");
    assert.equal(unwrap(workspace.listCharacters()).length, 1);
    memory.close();
    memory = unwrap(openSQLiteMemory(join(dir, "memory.sqlite")));
    workspace = createCharacterWorkspace(options());
    assert.deepEqual(
      unwrap(await workspace.generateCharacter(request)),
      template,
    );
    assert.equal(calls, 1);
    assert.equal(
      (await workspace.generateCharacter({ ...request, brief: "Different" }))
        .ok,
      false,
    );
    const saved = unwrap(
      workspace.importCharacter({ requestId: "save-generated", template }),
    );
    assert.equal(saved.memories.length, 0);
    client.generate = async () => ({
      ok: true,
      value: { name: "Bad", credentials: "not-allowed" },
    });
    assert.equal(
      (
        await workspace.generateCharacter({
          ...request,
          requestId: "bad-output",
        })
      ).ok,
      false,
    );
    assert.equal(unwrap(workspace.listCharacters()).length, 2);
  } finally {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("application chat has neutral context and preserves memory across restart", async () => {
  const memory = unwrap(openSQLiteMemory(":memory:"));
  try {
    let inspected = false;
    const options = {
      memory,
      chatEnvironment: "app" as const,
      controllerFor: () => {
        const controller = createScenarioController();
        return ((input, signal) => {
          inspected = true;
          assert.equal(input.context.binding.environmentId, "app-chat");
          assert.deepEqual(input.context.observedState.properties, []);
          assert.match(
            input.context.observedState.summary,
            /no game is currently attached/,
          );
          assert.equal(input.profile.hostIntents.length, 0);
          return controller(input, signal);
        }) as ReturnType<typeof createScenarioController>;
      },
    };
    let workspace = createCharacterWorkspace(options);
    const result = unwrap(
      await workspace.run(run("character-lumen", "chat", "app-first")),
    );
    assert.equal(result.run.status, "completed");
    assert.equal(inspected, true);
    assert.equal(result.result.type, "chat");
    assert(
      result.memories.every((event) => event.environmentId === "app-chat"),
    );
    assert(!JSON.stringify(result.result).includes("herb beds"));
    workspace = createCharacterWorkspace(options);
    assert.equal(unwrap(workspace.snapshot()).runs.length, 1);
    const reused = unwrap(
      await workspace.run(run("character-lumen", "chat", "app-first")),
    );
    assert.equal(reused.runs.length, 1);
  } finally {
    memory.close();
  }
});
