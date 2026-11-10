/** Runnable original synthetic host. No account, model, network or personal store. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createSessionClient } from "@ifsoul/adapter-sdk";
import type { SQLDriver } from "@ifsoul/core/memory/sql";
import type {
  ParticipantSession,
  SessionParticipant,
} from "@ifsoul/core/runtime";
import {
  createParticipantSessionService,
  createSQLParticipantStore,
} from "./participant-sessions.js";

const db = new DatabaseSync(":memory:");
try {
  const driver: SQLDriver = {
    prepare: (sql) => db.prepare(sql),
    transaction(work) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = work();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  // The host supplies this verified directory after authentication. It is not request data.
  const verified: SessionParticipant[] = [
    { participantId: "npc-a", subjectId: "verified-host-npc-a", kind: "npc" },
    { participantId: "npc-b", subjectId: "verified-host-npc-b", kind: "npc" },
    {
      participantId: "player-one",
      subjectId: "verified-host-player-one",
      kind: "player",
    },
    {
      participantId: "player-two",
      subjectId: "verified-host-player-two",
      kind: "player",
    },
  ];
  const service = createParticipantSessionService({
    store: createSQLParticipantStore(driver),
    access: { principalId: "synthetic-owner", hostId: "synthetic-host" },
    resolveParticipant(subjectId) {
      const participant = verified.find((p) => p.subjectId === subjectId);
      if (!participant) throw Error("Unverified host subject");
      return participant;
    },
    async controller(input) {
      if (input.ticket.npcId === "npc-b")
        assert(!JSON.stringify(input).includes("silver iris"));
      return "I hear you.";
    },
  });
  verified.forEach((p) => service.register(p.subjectId));
  const session: ParticipantSession = {
    sessionId: "garden-party",
    revision: 1,
    hostId: "synthetic-host",
    worldId: "garden",
    recallWorldIds: ["garden"],
    members: verified.map((p) => ({
      participantId: p.participantId,
      role: p.kind,
    })),
    groups: [
      {
        groupId: "party",
        participantIds: verified.map((p) => p.participantId),
      },
    ],
    channels: [
      {
        channelId: "chat",
        participantIds: verified.map((p) => p.participantId),
      },
    ],
  };
  const client = createSessionClient(service.port);
  await client.transition({
    transitionId: "join",
    expectedRevision: 0,
    session,
  });
  for (const [eventId, senderId, npcId, text] of [
    ["private-a", "player-one", "npc-a", "I prefer the silver iris."],
    ["private-b", "player-two", "npc-b", "Hello from the orchard."],
  ]) {
    await client.append({
      eventId,
      sessionId: session.sessionId,
      revision: 1,
      channelId: "chat",
      senderId,
      recipientIds: [npcId],
      observerIds: [],
      text,
    });
    const proposal = await client.converse({
      ticket: {
        turnId: `turn-${eventId}`,
        eventId,
        sessionId: session.sessionId,
        revision: 1,
        npcId,
        recipientIds: [senderId],
        observerIds: [],
      },
      outputEventId: `reply-${eventId}`,
    });
    console.log(
      `${proposal.senderId} to ${proposal.recipientIds.join(", ")}: ${proposal.text}`,
    );
    // The host would separately adopt/deliver this proposal and report effects.
  }
  assert(
    !(
      await client.history({
        sessionId: session.sessionId,
        participantId: "npc-b",
      })
    ).some((e) => e.eventId === "private-a"),
  );
  console.log(
    "Two NPCs and two players: private context and history remained separate.",
  );
} finally {
  db.close();
}
