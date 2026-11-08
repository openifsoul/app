import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("operator JSON file configures actual local HTTP ingress and advertised SDK capability without source edits", async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const directory = await mkdtemp(join(tmpdir(), "ifsoul-resource-policy-"));
  const policyFile = join(directory, "resources.json");
  await writeFile(
    policyFile,
    JSON.stringify({
      http: { bodyBytes: 65536 },
      bridge: { maxRequestBytes: 65536 },
    }),
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/server/src/local.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        IFSOUL_DATA_DIR: join(directory, "data"),
        IFSOUL_RESOURCE_POLICY_FILE: policyFile,
        IFSOUL_OLLAMA_PROMPT_BUDGET_BYTES: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (c) => {
    output += c;
  });
  child.stderr.on("data", (c) => {
    output += c;
  });
  const origin = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw Error(output);
      try {
        ready = (await fetch(origin + "/api/config")).ok;
      } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, output);
    const metadata = await (
      await fetch(origin + "/api/resource-policy")
    ).json();
    assert.equal(metadata.http.bodyBytes, 65536);
    assert.equal(metadata.bridge.limits.maxRequestBytes, 65536);
    const body =
      JSON.stringify({ characterId: "character-lumen", consent: true }) +
      " ".repeat(32768);
    assert.equal(
      (
        await fetch(origin + "/api/memory/new", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body,
        })
      ).status,
      200,
    );
    const declared = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        origin + "/api/memory/new",
        {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            "content-length": String(1024 ** 3),
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          assert.equal(response.headers.connection, "close");
          response.resume();
          response.on("end", () => {
            request.destroy();
            resolve(status);
          });
        },
      );
      request.on("error", reject);
      request.setTimeout(3000, () => {
        request.destroy();
        reject(Error("owned request deadline"));
      });
      request.end("{}");
    });
    assert.equal(declared, 413);
    const chunked = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        origin + "/api/memory/new",
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          response.resume();
          response.on("end", () => {
            request.destroy();
            resolve(status);
          });
        },
      );
      request.on("error", reject);
      request.setTimeout(3000, () => {
        request.destroy();
        reject(Error("owned request deadline"));
      });
      request.write(" ".repeat(32768));
      request.write(" ".repeat(32768));
      request.end(" ");
    });
    assert.equal(chunked, 413);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
