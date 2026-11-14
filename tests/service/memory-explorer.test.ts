import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import type { Result } from "@ifsoul/core/memory/port";
import type { MemoryEvent } from "@ifsoul/core/protocol";
import { character, IDS } from "../../apps/runtime-host/src/default-context.js";
import { browseMemory } from "../../apps/runtime-host/src/memory-explorer.js";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw Error(JSON.stringify(result));
  return result.value;
}

test("browse spans large retained histories with stable cursors, exact filters and private scope", () => {
  const directory = mkdtempSync(join(tmpdir(), "ifsoul-memory-explorer-"));
  const path = join(directory, "memory.sqlite");
  let memory = unwrap(openSQLiteMemory(path));
  try {
    const owner = unwrap(memory.putCharacter(character()));
    const other = unwrap(
      memory.putCharacter({
        ...character(),
        characterId: "other-memory",
        participantId: "other-npc",
      }),
    );
    const record = (n: number): MemoryEvent => ({
      kind: "memory-event",
      schemaVersion: "0.4.0",
      memoryId: `synthetic-${n}`,
      characterId: owner.characterId,
      recordedAt: "2026-01-01T00:00:00Z",
      environmentId: ["garden", "friendly-21", "dungeon", "app-chat"][n % 4]!,
      sessionId: "session-one",
      scope: {
        audience: "participants",
        participantIds: [owner.participantId, IDS.localParticipant],
        export: "forbidden",
      },
      participantIds: [owner.participantId, IDS.localParticipant],
      provenance: {
        sources: [{ sourceType: "conversation", sourceId: `source-${n}` }],
      },
      eventType: "test-dialogue",
      recordedPayload: {
        content: n % 4 === 2 ? "A synthetic iris" : "A synthetic flower",
      },
    });
    for (let start = 0; start < 1200; start += 100)
      unwrap(
        memory.commit({
          exchanges: [],
          events: Array.from({ length: 100 }, (_, n) => record(start + n)),
        }),
      );
    unwrap(
      memory.commit({
        exchanges: [],
        events: [
          {
            ...record(1201),
            scope: {
              audience: "private",
              participantIds: ["hidden-player"],
              export: "forbidden",
            },
          },
          {
            ...record(1202),
            characterId: other.characterId,
            recordedPayload: { content: "Cross-tenant test secret" },
          },
        ],
      }),
    );
    const browse = (filters = {}) =>
      unwrap(
        browseMemory(
          memory,
          new URLSearchParams({ memoryId: owner.characterId, ...filters }),
        ),
      );
    const first = browse();
    assert.equal(first.records.length, 20);
    assert.equal(first.total, 1200);
    assert.deepEqual(
      { ...first.facets?.worlds },
      { garden: 300, "friendly-21": 300, dungeon: 300, "app-chat": 300 },
    );
    unwrap(memory.commit({ exchanges: [], events: [record(1203)] }));
    unwrap(memory.close());
    memory = unwrap(openSQLiteMemory(path));
    const retained = [...first.records];
    let cursor = first.next;
    while (cursor) {
      const page = browse({ cursor });
      assert.equal(page.total, 1200);
      retained.push(...page.records);
      cursor = page.next;
    }
    assert.equal(retained.length, 1200);
    assert.equal(new Set(retained.map((r) => r.id)).size, 1200);
    assert(
      !retained.some((row) =>
        ["synthetic-1201", "synthetic-1202", "synthetic-1203"].includes(row.id),
      ),
    );
    const filters = {
      world: "dungeon",
      session: "session-one",
      entity: owner.participantId,
      q: "iris",
      kind: "test-dialogue",
      since: "2026-01-01",
      until: "2026-01-01",
    };
    const matching = [];
    cursor = undefined;
    do {
      const page = browse({ ...filters, ...(cursor ? { cursor } : {}) });
      assert.equal(page.total, 300);
      assert.deepEqual({ ...page.facets?.worlds }, { dungeon: 300 });
      matching.push(...page.records);
      cursor = page.next;
    } while (cursor);
    assert.equal(matching.length, 300);
    assert(
      matching.every(
        (row) => row.worldId === "dungeon" && row.text.includes("iris"),
      ),
    );
    assert.equal(
      browse({ entity: owner.participantId.slice(0, -1) }).records.length,
      0,
    );
    const source = browse({ source: "source-7" });
    assert.deepEqual(
      source.records.map((row) => row.id),
      ["synthetic-7"],
    );
  } finally {
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
