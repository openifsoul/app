import assert from "node:assert/strict";
import test from "node:test";
import { previewMemoryArchive } from "../../apps/runtime-host/src/memory-archive.js";
test("old and wrong-family outer archives reject without mutating their bytes", () => {
  for (const version of [
    "ifsoul-app-memory/0.1",
    "ifsoul-app-memory/0.3.0",
    "ifsoul-bridge/0.4.0",
    "ifsoul-app-memory/9.9",
  ]) {
    const archive = {
      version,
      sha256: "0".repeat(64),
      payload: { sourceMemoryId: "synthetic-old" },
    };
    const bytes = JSON.stringify(archive);
    assert.equal(previewMemoryArchive(archive).ok, false);
    assert.equal(JSON.stringify(archive), bytes);
  }
});

test("old persisted owner records stop initialization without creating a replacement starter", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { MEMORY_SCHEMA } = await import("@ifsoul/core/memory/sql");
  const { openSQLiteMemory } = await import("@ifsoul/core/memory/sqlite");
  const { character } =
    await import("../../apps/runtime-host/src/default-context.js");
  const { createCharacterWorkspace } =
    await import("../../apps/runtime-host/src/characters.js");
  const { createScenarioController } =
    await import("../../apps/runtime-host/src/service.js");
  const dir = mkdtempSync(join(tmpdir(), "ifsoul-app-old-store-"));
  const file = join(dir, "synthetic.sqlite");
  const old = {
    ...character(),
    characterId: "old-owner",
    schemaVersion: "draft-0.2.0",
  };
  const bytes = JSON.stringify(old);
  try {
    const db = new DatabaseSync(file);
    db.exec(MEMORY_SCHEMA);
    db.prepare("INSERT INTO characters(id,document) VALUES(?,?)").run(
      old.characterId,
      bytes,
    );
    db.close();
    for (let n = 0; n < 2; n++) {
      const opened = openSQLiteMemory(file);
      assert(opened.ok);
      if (!opened.ok) throw Error();
      const workspace = createCharacterWorkspace({
        memory: opened.value,
        controllerFor: () => createScenarioController(),
      });
      const result = workspace.listCharacters();
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "unsupported");
      const { createAPI } = await import("../../apps/server/src/api.js");
      const api = createAPI({
        mode: "local",
        access: { kind: "local", origin: "http://127.0.0.1:8793" },
        password: "",
        encryptionKey: "synthetic",
        store: { get: () => undefined, set: () => {}, delete: () => {} },
        service: workspace,
        providers: async () => [],
      });
      for (const path of ["characters", "snapshot"]) {
        const response = await api(
          new Request(`http://127.0.0.1:8793/api/${path}`, {
            headers: { host: "127.0.0.1:8793" },
          }),
        );
        assert.equal(response.status, 409);
        assert.equal(
          (await response.json()).error.code,
          "stored-format-unsupported",
        );
      }
      opened.value.close();
      const check = new DatabaseSync(file);
      assert.equal(
        check.prepare("SELECT count(*) AS n FROM characters").get()?.n,
        1,
      );
      assert.equal(
        check
          .prepare("SELECT document FROM characters WHERE id=?")
          .get(old.characterId)?.document,
        bytes,
      );
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
