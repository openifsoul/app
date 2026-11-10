import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionClient } from "@ifsoul/adapter-sdk";
import type { ModelClient } from "@ifsoul/core/model-providers/types";
import type {
  ParticipantSession,
  AddressedEvent,
  SessionTurn,
  SessionParticipant,
} from "@ifsoul/core/runtime";
import type { SQLDriver } from "@ifsoul/core/memory/sql";
import {
  createParticipantSessionService,
  createSQLParticipantStore,
} from "../../apps/runtime-host/src/participant-sessions.js";

const participants: SessionParticipant[] = [
  { participantId: "npc-a", subjectId: "verified-a", kind: "npc" },
  { participantId: "npc-b", subjectId: "verified-b", kind: "npc" },
  { participantId: "player-one", subjectId: "verified-one", kind: "player" },
  { participantId: "player-two", subjectId: "verified-two", kind: "player" },
];
const all = participants.map((p) => p.participantId);
const session = (
  revision = 1,
  memberIds = all,
  worldId = "garden",
  sessionId = "party",
): ParticipantSession => ({
  sessionId,
  revision,
  worldId,
  hostId: "trusted-host",
  recallWorldIds: [worldId],
  members: participants
    .filter((p) => memberIds.includes(p.participantId))
    .map((p) => ({ participantId: p.participantId, role: p.kind })),
  groups: [{ groupId: "friends", participantIds: memberIds }],
  channels: [{ channelId: "chat", participantIds: memberIds }],
});
const event = (
  eventId: string,
  senderId = "player-one",
  recipientIds = ["npc-a"],
  text = "a private silver iris",
  revision = 1,
  sessionId = "party",
): AddressedEvent => ({
  eventId,
  senderId,
  recipientIds,
  observerIds: [],
  text,
  sessionId,
  revision,
  channelId: "chat",
});
const turn = (
  turnId: string,
  eventId: string,
  npcId = "npc-a",
  recipientIds = ["player-one"],
  revision = 1,
  sessionId = "party",
): SessionTurn => ({
  turnId,
  eventId,
  npcId,
  recipientIds,
  observerIds: [],
  revision,
  sessionId,
});
function harness(
  path = ":memory:",
  principalId = "owner",
  controller?: (input: unknown) => Promise<string>,
) {
  const db = new DatabaseSync(path);
  const driver: SQLDriver = {
    prepare(sql) {
      return db.prepare(sql);
    },
    transaction(work) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = work();
        db.exec("COMMIT");
        return value;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const prompts: string[] = [];
  const provider: ModelClient = {
    id: "openai",
    async generate(request) {
      prompts.push(request.prompt);
      return { ok: true, value: { content: "I hear you." } };
    },
  };
  const service = createParticipantSessionService({
    store: createSQLParticipantStore(driver),
    access: { principalId, hostId: "trusted-host" },
    resolveParticipant(subjectId) {
      const p = participants.find((p) => p.subjectId === subjectId);
      if (!p) throw Error("unverified");
      return p;
    },
    controller:
      controller ??
      (async (input) => {
        const result = await provider.generate({
          model: "synthetic",
          system: "Return bounded dialogue.",
          schema: {},
          prompt: JSON.stringify(input),
        });
        if (!result.ok) throw Error("provider");
        return (result.value as { content: string }).content;
      }),
  });
  return { db, service, client: createSessionClient(service.port), prompts };
}
async function setup(h: ReturnType<typeof harness>) {
  participants.forEach((p) => h.service.register(p.subjectId));
  await h.client.transition({
    transitionId: "join",
    expectedRevision: 0,
    session: session(),
  });
}

test("2 NPC + 2 players: addressed history and actual provider context stay private; verified identity survives worlds and SQLite reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ifsoul-participants-"));
  const path = join(directory, "synthetic.sqlite");
  let h = harness(path);
  try {
    await setup(h);
    assert.throws(() => h.service.register("player-one"), /unverified/);
    const secret = event("secret");
    await h.client.append(secret);
    await h.client.append(secret);
    await h.client.append(
      event("two", "player-two", ["npc-a"], "I prefer amber"),
    );
    await h.client.append(event("b", "player-two", ["npc-b"], "Hello B"));
    await h.client.converse({
      ticket: turn("b-turn", "b", "npc-b", ["player-two"]),
      outputEventId: "b-reply",
    });
    assert.doesNotMatch(h.prompts[0], /silver iris|I prefer amber/);
    assert.equal(
      (
        await h.client.history({ sessionId: "party", participantId: "npc-b" })
      ).some((e) => e.eventId === "secret"),
      false,
    );
    await h.client.converse({
      ticket: turn("a-two", "two", "npc-a", ["player-two"]),
      outputEventId: "two-reply",
    });
    assert.doesNotMatch(h.prompts[1], /silver iris/);
    await h.client.converse({
      ticket: turn("a-one", "secret"),
      outputEventId: "one-reply",
    });
    assert.match(h.prompts[2], /silver iris/);
    assert.doesNotMatch(h.prompts[2], /I prefer amber/);
    await h.client.converse({
      ticket: turn("a-one", "secret"),
      outputEventId: "one-reply",
    });
    assert.equal(h.prompts.length, 3);
    await h.client.append(
      event("shared", "player-one", ["npc-a", "player-two"], "Hello together"),
    );
    await h.client.converse({
      ticket: turn("shared-turn", "shared", "npc-a", [
        "player-one",
        "player-two",
      ]),
      outputEventId: "shared-reply",
    });
    assert.doesNotMatch(h.prompts[3], /silver iris|I prefer amber/);

    assert.equal(
      (
        await h.client.history({ sessionId: "party", participantId: "npc-a" })
      ).filter((e) => e.eventId === "secret").length,
      1,
    );
    await h.client.transition({
      transitionId: "leave",
      expectedRevision: 1,
      session: session(
        2,
        all.filter((p) => p !== "player-one"),
      ),
    });
    await assert.rejects(
      h.client.history({ sessionId: "party", participantId: "player-one" }),
      /unauthorized/,
    );
    await h.client.transition({
      transitionId: "rejoin",
      expectedRevision: 2,
      session: session(3),
    });
    h.db.close();
    h = harness(path);
    const dungeon = session(1, all, "dungeon", "dungeon-session");
    await h.client.transition({
      transitionId: "dungeon",
      expectedRevision: 0,
      session: dungeon,
    });
    await h.client.append(
      event(
        "dungeon-question",
        "player-one",
        ["npc-a"],
        "Remember me?",
        1,
        dungeon.sessionId,
      ),
    );
    await h.client.converse({
      ticket: turn(
        "isolated-world",
        "dungeon-question",
        "npc-a",
        ["player-one"],
        1,
        dungeon.sessionId,
      ),
      outputEventId: "isolated-reply",
    });
    assert.doesNotMatch(h.prompts[0], /silver iris/);
    dungeon.revision = 2;
    dungeon.recallWorldIds = ["garden", "dungeon"];
    await h.client.transition({
      transitionId: "continuity",
      expectedRevision: 1,
      session: dungeon,
    });
    await h.client.append(
      event(
        "remember",
        "player-one",
        ["npc-a"],
        "Remember me again?",
        2,
        dungeon.sessionId,
      ),
    );
    await h.client.converse({
      ticket: turn(
        "continuity-turn",
        "remember",
        "npc-a",
        ["player-one"],
        2,
        dungeon.sessionId,
      ),
      outputEventId: "continuity-reply",
    });
    assert.match(h.prompts[1], /silver iris/);
    assert.doesNotMatch(h.prompts[1], /I prefer amber/);
    const first = h.service.relationshipEvidence(
      dungeon.sessionId,
      "npc-a",
      "player-one",
    );
    const second = h.service.relationshipEvidence(
      dungeon.sessionId,
      "npc-a",
      "player-two",
    );
    assert.equal(first.playerId, "player-one");
    assert.equal(second.playerId, "player-two");
    assert(first.events.some((e) => e.eventId === "secret"));
    assert(!second.events.some((e) => e.eventId === "secret"));
    assert(second.events.some((e) => e.eventId === "two"));
    assert(!first.events.some((e) => e.eventId === "two"));
    const foreign = harness(path, "other-owner");
    try {
      await assert.rejects(
        foreign.client.history({ sessionId: "party", participantId: "npc-a" }),
        /unauthorized/,
      );
    } finally {
      foreign.db.close();
    }
  } finally {
    h.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("membership fences late completion, forged IDs fail, and one NPC writer spans sessions", async () => {
  let release: (text: string) => void = () => {};
  const h = harness(
    ":memory:",
    "owner",
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  try {
    await setup(h);
    const before = h.db
      .prepare("SELECT document FROM participant_sessions")
      .get();
    await assert.rejects(
      h.client.append(event("forged", "forged-player")),
      /unauthorized/,
    );
    assert.deepEqual(
      h.db.prepare("SELECT document FROM participant_sessions").get(),
      before,
    );
    await h.client.append(event("request"));
    const pending = h.client.converse({
      ticket: turn("pending", "request"),
      outputEventId: "late",
    });
    await h.client.transition({
      transitionId: "other",
      expectedRevision: 0,
      session: session(1, all, "garden", "other"),
    });
    await h.client.append(
      event(
        "other-event",
        "player-one",
        ["npc-a"],
        "Other session",
        1,
        "other",
      ),
    );
    await assert.rejects(
      h.client.converse({
        ticket: turn(
          "competing",
          "other-event",
          "npc-a",
          ["player-one"],
          1,
          "other",
        ),
        outputEventId: "competing-output",
      }),
      /busy/,
    );
    await h.client.transition({
      transitionId: "leave",
      expectedRevision: 1,
      session: session(
        2,
        all.filter((p) => p !== "player-one"),
      ),
    });
    release("late secret");
    await assert.rejects(pending, /stale/);
    assert.equal(
      (
        await h.client.history({ sessionId: "party", participantId: "npc-a" })
      ).some((e) => e.eventId === "late"),
      false,
    );
    // Rejoining or widening a group never rewrites original private event audiences.
    await h.client.transition({
      transitionId: "rejoin",
      expectedRevision: 2,
      session: session(3),
    });
    assert.equal(
      (await h.client.history({ sessionId: "party", participantId: "npc-b" }))
        .length,
      0,
    );
  } finally {
    h.db.close();
  }
});
