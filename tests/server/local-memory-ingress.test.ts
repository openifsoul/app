import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the real HTTP adapter, not just the Fetch API route handler: it has
// its own streaming body cap and must allow bounded archive envelopes through.
test("local HTTP ingress accepts bounded archive envelopes and retains other caps", async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const directory = await mkdtemp(join(tmpdir(), "ifsoul-ingress-"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/server/src/local.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        IFSOUL_DATA_DIR: directory,
        IFSOUL_RESOURCE_POLICY_FILE: undefined,
        IFSOUL_OLLAMA_PROMPT_BUDGET_BYTES: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const origin = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, padding = 0) =>
    fetch(origin + path, {
      method: "POST",
      headers: { origin, "Content-Type": "application/json" },
      body: JSON.stringify(body) + " ".repeat(padding),
    });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw Error(output);
      try {
        ready = (await fetch(origin + "/api/config")).ok;
      } catch {
        /* startup */
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, output);
    const created = await (
      await post("/api/memory/new", {
        characterId: "character-lumen",
        consent: true,
      })
    ).json();
    assert.ok(created.ok, JSON.stringify(created));
    const run = await (
      await post("/api/run", {
        characterId: created.value.memoryId,
        operation: "chat",
        requestId: "synthetic-ingress-chat",
        message: "A fictional archive check.",
        provider: "scenario",
        model: "synthetic-v1",
      })
    ).json();
    assert.ok(run.ok, JSON.stringify(run));
    const exported = await fetch(
      origin + `/api/memory/export?memoryId=${created.value.memoryId}`,
    ).then((r) => r.json());
    assert.ok(exported.ok, JSON.stringify(exported));
    const previewResponse = await post(
      "/api/memory/preview?test=bounded",
      { archive: exported.value },
      20_000,
    );
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.ok(preview.ok);
    const imported = await post(
      "/api/memory/import",
      {
        archive: exported.value,
        expectedDigest: preview.value.sha256,
      },
      20_000,
    );
    assert.equal(imported.status, 200);
    assert.ok((await imported.json()).ok);
    assert.equal(
      (await post("/api/memory/preview", {}, 2_010_001)).status,
      413,
    );
    assert.equal((await post("/api/memory/import", {}, 2_010_001)).status, 413);
    assert.equal((await post("/api/run", {}, 20_000)).status, 413);
    assert.equal((await post("/api/memory/new", {}, 20_000)).status, 413);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
