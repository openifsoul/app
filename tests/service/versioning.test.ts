import { recordBridgeRequest } from "../../apps/runtime-host/src/bridge-memory.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSQLiteMemory } from "@ifsoul/core/memory/sqlite";
import {
  previewMemoryArchive,
  importMemoryArchive,
  exportMemoryArchive,
} from "../../apps/runtime-host/src/memory-archive.js";
import type { Result } from "@ifsoul/core/memory/port";
const value = <T>(r: Result<T>): T => {
  assert(r.ok, JSON.stringify(r));
  if (!r.ok) throw Error();
  return r.value;
};
test("golden original legacy archive keeps checksum and evidence; import forks identity and reopens", () => {
  const bytes = readFileSync(
    new URL("./fixtures/legacy-memory-archive.json", import.meta.url),
    "utf8",
  );
  const legacy = JSON.parse(bytes);
  const original = JSON.stringify(legacy);
  assert(previewMemoryArchive(legacy).ok);
  assert(
    !previewMemoryArchive({ ...legacy, version: "ifsoul-app-memory/9.9" }).ok,
  );
  assert(
    !previewMemoryArchive({ ...legacy, version: "ifsoul-bridge/0.3.0" }).ok,
  );
  assert(!previewMemoryArchive({ ...legacy, sha256: "0".repeat(64) }).ok);
  const dir = mkdtempSync(join(tmpdir(), "ifsoul-legacy-030-"));
  let memory = value(openSQLiteMemory(join(dir, "test.sqlite")));
  try {
    const fork = value(importMemoryArchive(memory, legacy, legacy.sha256));
    assert.notEqual(fork.characterId, legacy.payload.sourceMemoryId);
    assert.equal(JSON.stringify(legacy), original);
    const stored = value(memory.getCharacter(fork.memoryId));
    assert.equal(stored?.schemaVersion, "draft-0.2.0");
    assert.equal(exportMemoryArchive(memory, fork.memoryId).ok, false);
    memory.close();
    memory = value(openSQLiteMemory(join(dir, "test.sqlite")));
    assert.deepEqual(value(memory.getCharacter(fork.memoryId)), stored);
    recordBridgeRequest(memory, fork.memoryId, {
      version: "ifsoul-bridge/0.3.0",
      hostId: "original-observatory",
      memoryId: fork.memoryId,
      character: {
        id: fork.characterId,
        name: "Original",
        temperament: "careful",
      },
      requestId: "after-reopen",
      operation: "chat",
      context: "A new report",
      choices: [],
      fallbackChoiceId: "",
      history: [
        {
          id: "new-observation",
          hostId: "original-observatory",
          kind: "observation",
          summary: "The player reported repairing a fictional basket.",
          actor: "user",
          recipient: "agent",
          observer: "agent",
          perspectiveCharacterId: fork.characterId,
        },
      ],
    });
    const current = value(exportMemoryArchive(memory, fork.memoryId));
    assert.equal(current.version, "ifsoul-app-memory/0.3.0");
    assert(previewMemoryArchive(current).ok);
    assert.equal(JSON.stringify(JSON.parse(bytes)), original);
    assert.equal(
      readFileSync(
        new URL("./fixtures/legacy-memory-archive.json", import.meta.url),
        "utf8",
      ),
      bytes,
    );
  } finally {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
