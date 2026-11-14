import {
  createParticipantRuntime,
  emptyParticipantState,
  SessionError,
} from "@ifsoul/core/runtime";
import type {
  ParticipantStore,
  ParticipantState,
  SessionAccess,
  SessionParticipant,
  ParticipantSession,
  AddressedEvent,
  SessionTurn,
} from "@ifsoul/core/runtime";
import type { SQLDriver } from "@ifsoul/core/memory/sql";
import type { SessionHostPort } from "@ifsoul/adapter-sdk";

/** The caller owns database lifecycle; this composition never opens personal stores. */
export function createSQLParticipantStore(
  db: SQLDriver,
  indexedHistory = false,
): ParticipantStore & {
  searchHistory(
    principalId: string,
    sessionId: string,
    text: string,
  ): Set<string>;
} {
  db.prepare(
    "CREATE TABLE IF NOT EXISTS participant_sessions (principal_id TEXT PRIMARY KEY, document TEXT NOT NULL)",
  ).run();
  if (indexedHistory)
    db.transaction(() => {
      db.prepare(
        "CREATE VIRTUAL TABLE IF NOT EXISTS participant_history_fts USING fts5(principal UNINDEXED, session UNINDEXED, event UNINDEXED, text)",
      ).run();
      db.prepare(
        "CREATE TABLE IF NOT EXISTS participant_history_index_version (version INTEGER PRIMARY KEY)",
      ).run();
      if (
        !db
          .prepare(
            "SELECT version FROM participant_history_index_version WHERE version=1",
          )
          .get()
      ) {
        db.prepare(
          `INSERT INTO participant_history_fts(principal, session, event, text)
        SELECT principal_id, json_extract(item.value,'$.sessionId'), json_extract(item.value,'$.eventId'), json_extract(item.value,'$.text')
        FROM participant_sessions, json_each(document,'$.events') AS item`,
        ).run();
        db.prepare(
          "INSERT INTO participant_history_index_version(version) VALUES (1)",
        ).run();
      }
    });
  return {
    searchHistory(principalId, sessionId, text) {
      if (!indexedHistory) throw new SessionError("invalid");
      const phrase = `"${text.replaceAll('"', '""')}"`;
      return new Set(
        db
          .prepare(
            `SELECT event FROM participant_history_fts
        WHERE participant_history_fts MATCH ? AND principal=? AND session=?`,
          )
          .all(phrase, principalId, sessionId)
          .map((row) => String(row.event)),
      );
    },
    transact(principalId, work) {
      return db.transaction(() => {
        const row = db
          .prepare(
            "SELECT document FROM participant_sessions WHERE principal_id = ?",
          )
          .get(principalId);
        const state: ParticipantState = row
          ? JSON.parse(String(row.document))
          : emptyParticipantState();
        if (state.format !== "ifsoul-participants/0.4.0")
          throw new SessionError("invalid");
        const prior = indexedHistory
          ? new Map(state.events.map((event) => [event.eventId, event]))
          : undefined;
        const result = work(state);
        if (prior) {
          for (const event of state.events) {
            const original = prior.get(event.eventId);
            prior.delete(event.eventId);
            if (
              original?.sessionId === event.sessionId &&
              original.text === event.text
            )
              continue;
            if (original)
              db.prepare(
                "DELETE FROM participant_history_fts WHERE principal=? AND event=?",
              ).run(principalId, event.eventId);
            db.prepare(
              "INSERT INTO participant_history_fts(principal,session,event,text) VALUES (?,?,?,?)",
            ).run(principalId, event.sessionId, event.eventId, event.text);
          }
          for (const eventId of prior.keys())
            db.prepare(
              "DELETE FROM participant_history_fts WHERE principal=? AND event=?",
            ).run(principalId, eventId);
        }
        db.prepare(
          "INSERT INTO participant_sessions(principal_id, document) VALUES (?, ?) ON CONFLICT(principal_id) DO UPDATE SET document=excluded.document",
        ).run(principalId, JSON.stringify(state));
        return result;
      });
    },
  };
}
export type ParticipantControllerInput = ReturnType<
  ReturnType<typeof createParticipantRuntime>["begin"]
>;
/** Roots authenticate and authorize a host before constructing this service.
 * Do not deserialize SessionAccess or stable participant mappings from request bodies.
 * This is a composition API, not an unauthenticated HTTP route. */
export function createParticipantSessionService(options: {
  store: ParticipantStore;
  access: SessionAccess;
  /** Resolves a verified host subject through trusted server identity mapping. */
  resolveParticipant: (subjectId: string) => SessionParticipant;
  controller: (
    input: ParticipantControllerInput,
    signal: AbortSignal,
  ) => Promise<string>;
  timeoutMs?: number;
  behaviorOperator?: import("@ifsoul/core/runtime").BehaviorOperatorPolicy;
}) {
  const runtime = createParticipantRuntime(options.store, {
    behaviorOperator: options.behaviorOperator,
  });
  const access = structuredClone(options.access);
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000)
    throw new RangeError("Invalid participant timeout");
  const port: SessionHostPort<
    ParticipantSession,
    AddressedEvent,
    { ticket: SessionTurn; outputEventId: string },
    AddressedEvent
  > = {
    async transition(request) {
      return runtime.transition(
        access,
        request.transitionId,
        request.expectedRevision,
        request.session,
      );
    },
    async append(event) {
      return runtime.append(access, event);
    },
    async history(request) {
      return runtime.history(access, request.sessionId, request.participantId);
    },
    async converse({ ticket, outputEventId }) {
      const input = runtime.begin(access, ticket);
      if (input.output) {
        if (input.output.eventId !== outputEventId)
          throw new SessionError("conflict");
        return input.output;
      }
      const signal = AbortSignal.timeout(timeout);
      let abort: () => void = () => {};
      try {
        const text = await Promise.race([
          options.controller(structuredClone(input), signal),
          new Promise<never>((_, reject) => {
            abort = () => reject(new SessionError("stale"));
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }),
        ]);
        if (signal.aborted) throw new SessionError("stale");
        return runtime.complete(access, ticket, {
          eventId: outputEventId,
          sessionId: ticket.sessionId,
          revision: ticket.revision,
          channelId: input.trigger.channelId,
          senderId: ticket.npcId,
          recipientIds: ticket.recipientIds,
          observerIds: ticket.observerIds,
          text,
        });
      } catch (error) {
        try {
          runtime.cancel(access, ticket);
        } catch {
          /* A completed or handed-off turn cannot be cancelled by this root. */
        }
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
  return {
    port,
    relationshipEvidence(sessionId: string, npcId: string, playerId: string) {
      return runtime.relationshipEvidence(access, sessionId, npcId, playerId);
    },
    /** Only trusted host subjects are accepted; the resolver owns the stable identity. */
    register(subjectId: string) {
      const mapped = options.resolveParticipant(subjectId);
      if (mapped.subjectId !== subjectId)
        throw new SessionError("unauthorized");
      return runtime.register(access, mapped);
    },
  };
}
