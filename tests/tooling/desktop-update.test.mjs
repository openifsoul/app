import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  checkUpdate,
  downloadUpdate,
  distributionPolicy,
} from "../../apps/desktop/src/update-feed.mjs";
import {
  finishMacUpdate,
  installMacUpdate,
  recoverMacUpdate,
} from "../../apps/desktop/src/update-install.mjs";
import { attachDesktopTray } from "../../apps/desktop/src/tray.mjs";

const artifact = Buffer.from("synthetic artifact");
const sha256 = createHash("sha256").update(artifact).digest("hex");
const keys = generateKeyPairSync("ed25519");
const trust = {
  feed: "https://example.test/desktop/update.json",
  publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
};
const release = {
  product: "org.openifsoul.desktop",
  protocol: 1,
  dataFormat: "0.4.0",
  rollbackCompatible: true,
  bridges: { "minecraft-mineflayer": { protocol: "0.4.0", sha256 } },
  version: "0.6.1",
  platform: "darwin",
  arch: "arm64",
  expiresAt: 100000,
  artifact: "./release.dmg",
  bytes: artifact.length,
  sha256,
};

function signedFetch(value, privateKey = keys.privateKey) {
  const payload = Buffer.from(JSON.stringify(value));
  const signature = sign(null, payload, privateKey);
  return async () =>
    Response.json({
      payload: payload.toString("base64url"),
      signature: signature.toString("base64url"),
    });
}

test("accepts signed compatible upgrades only", async () => {
  const options = { ...trust, currentVersion: "0.6.0" };
  const accepted = await checkUpdate(options, signedFetch(release), 1000);
  assert.equal(
    accepted.artifact.href,
    "https://example.test/desktop/release.dmg",
  );
  assert.equal(
    await checkUpdate(
      { ...options, currentVersion: "0.6.2" },
      signedFetch(release),
      1000,
    ),
    null,
  );
  await assert.rejects(
    checkUpdate(
      options,
      signedFetch(release, generateKeyPairSync("ed25519").privateKey),
      1000,
    ),
    /signature/,
  );
  for (const fields of [
    { expiresAt: 999 },
    { arch: "x64" },
    { dataFormat: "0.5.0" },
    { bridges: { "minecraft-mineflayer": { protocol: "0.5.0", sha256 } } },
    { artifact: "https://other.test/example.dmg" },
  ])
    await assert.rejects(
      checkUpdate(options, signedFetch({ ...release, ...fields }), 1000),
    );
});

test("downloads exact signed bytes and rejects truncation, overflow and substitution", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ifsoul-feed-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const signedRelease = {
    ...release,
    artifact: new URL(release.artifact, trust.feed),
  };
  await downloadUpdate(
    signedRelease,
    join(dir, "valid"),
    async () => new Response(artifact),
  );
  assert.deepEqual(await readFile(join(dir, "valid")), artifact);
  for (const [name, body] of [
    ["short", artifact.subarray(1)],
    ["long", Buffer.concat([artifact, artifact])],
    ["substituted", Buffer.alloc(artifact.length)],
  ])
    await assert.rejects(
      downloadUpdate(
        signedRelease,
        join(dir, name),
        async () => new Response(body),
      ),
    );
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "ifsoul-updater-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const current = join(dir, "IfSoul.app");
  const data = join(dir, "profile");
  await mkdir(current);
  await mkdir(data);
  await writeFile(join(current, "version"), "old");
  await writeFile(join(data, "owner-memory"), "durable");
  const statePath = join(data, "update.json");
  const exchange = async (previous, candidate) => {
    const temporary = join(dir, "exchange-test");
    await rename(previous, temporary);
    await rename(candidate, previous);
    await rename(temporary, candidate);
  };
  const options = {
    current,
    statePath,
    exchange,
    currentVersion: "0.6.0",
    config: trust,
    check: async () => release,
    download: async () => {},
    stage: async (_image, work) => {
      const candidate = join(work, "IfSoul.app");
      await mkdir(candidate);
      await writeFile(join(candidate, "version"), "new");
      return candidate;
    },
    verify: async () => {},
    probe: async () => {},
  };
  return {
    ...options,
    data,
    appBytes: () => readFile(join(current, "version"), "utf8"),
    ownerBytes: () => readFile(join(data, "owner-memory"), "utf8"),
  };
}

test("commits the candidate only after startup health check", async (t) => {
  const f = await fixture(t);
  let probed = false;
  const installed = await installMacUpdate({
    ...f,
    probe: async () => {
      assert.equal(await f.appBytes(), "old");
      probed = true;
    },
  });
  assert.equal(installed, "relaunch");
  assert.ok(probed);
  assert.equal(await f.appBytes(), "new");
  const state = await recoverMacUpdate(f);
  assert.equal(state.phase, "booting");
  await finishMacUpdate({ ...f, state, accepted: true });
  assert.equal(await recoverMacUpdate(f), null);
  assert.equal(await f.appBytes(), "new");
  assert.equal(await f.ownerBytes(), "durable");
});

test("previous installation survives download, staging, verification and trial startup errors", async (t) => {
  for (const phase of ["download", "stage", "verify", "probe", "exchange"]) {
    const f = await fixture(t);
    await assert.rejects(
      installMacUpdate({
        ...f,
        [phase]: async () => {
          throw Error(phase);
        },
      }),
      new RegExp(phase),
    );
    assert.equal(await f.appBytes(), "old");
    assert.equal(await f.ownerBytes(), "durable");
  }
});

test("live first-start failure restores previous version automatically", async (t) => {
  const f = await fixture(t);
  assert.equal(await installMacUpdate(f), "relaunch");
  const state = await recoverMacUpdate(f);
  await finishMacUpdate({ ...f, state, accepted: false });
  assert.equal(await f.appBytes(), "old");
  assert.equal(await f.ownerBytes(), "durable");
  assert.equal(await installMacUpdate(f), null);
});

test("an interrupted live first start rolls back on the next launch", async (t) => {
  const f = await fixture(t);
  assert.equal(await installMacUpdate(f), "relaunch");
  const interrupted = await recoverMacUpdate(f);
  assert.equal(interrupted.phase, "booting");
  const recovered = await recoverMacUpdate(f);
  assert.equal(recovered.phase, "rejected");
  assert.equal(recovered.restart, true);
  assert.equal(await f.appBytes(), "old");
  assert.equal(await f.ownerBytes(), "durable");
});

test("an interrupted exchange rolls back before the new app starts", async (t) => {
  const f = await fixture(t);
  await installMacUpdate(f);
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  await writeFile(f.statePath, JSON.stringify({ ...state, phase: "exchange" }));
  assert.equal((await recoverMacUpdate(f)).restart, true);
  assert.equal(await f.appBytes(), "old");
});

test("tray reopens the existing window and explicit quit permits close", () => {
  const app = new EventEmitter();
  const window = new EventEmitter();
  let opens = 0;
  let hides = 0;
  let prevented = 0;
  let destroyed = 0;
  let menu;
  Object.assign(window, {
    isDestroyed: () => false,
    isMinimized: () => false,
    show: () => {
      opens++;
    },
    hide: () => {
      hides++;
    },
    focus: () => {},
  });
  app.quit = () => app.emit("before-quit");
  class Tray extends EventEmitter {
    setToolTip() {}
    setContextMenu(value) {
      menu = value;
    }
    destroy() {
      destroyed++;
    }
  }
  const fixtures = {
    app,
    window,
    Tray,
    root: dirname(import.meta.filename),
    Menu: { buildFromTemplate: (value) => value },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => false, setTemplateImage() {} }),
    },
  };
  attachDesktopTray(fixtures);
  const close = () =>
    window.emit("close", {
      preventDefault: () => {
        prevented++;
      },
    });
  close();
  menu[0].click();
  app.emit("activate");
  app.emit("second-instance");
  assert.deepEqual([opens, hides, prevented], [3, 1, 1]);
  menu[1].click();
  close();
  assert.deepEqual([hides, prevented, destroyed], [1, 1, 1]);
});

test("a changed feed artifact cannot replace the confirmed download", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await installMacUpdate({
      ...f,
      expectedSha256: "0".repeat(64),
      download: async () => assert.fail("downloaded a different artifact"),
    }),
    null,
  );
  assert.equal(await f.appBytes(), "old");
});

test("a game starting during download defers install without rejecting its artifact", async (t) => {
  const f = await fixture(t);
  const progress = [];
  await assert.rejects(
    installMacUpdate({
      ...f,
      expectedSha256: release.sha256,
      beforeProbe: async () => {
        throw Error("game active");
      },
      probe: async () => assert.fail("probed while a game was active"),
      reportProgress: (stage) => progress.push(stage),
    }),
    /game active/,
  );
  assert.deepEqual(progress, ["downloading", "verifying"]);
  assert.equal(await recoverMacUpdate(f), null);
  assert.equal(await f.appBytes(), "old");
  assert.equal(await f.ownerBytes(), "durable");
  assert.equal(await installMacUpdate(f), "relaunch");
});

test("Ed25519 distribution mode requires its signed policy and rejects old manifests", async () => {
  const options = {
    ...trust,
    distribution: distributionPolicy,
    currentVersion: "0.6.0",
  };
  const signedRelease = { ...release, distribution: distributionPolicy };
  assert.equal(
    (await checkUpdate(options, signedFetch(signedRelease), 1000)).version,
    "0.6.1",
  );
  await assert.rejects(
    checkUpdate(options, signedFetch(release), 1000),
    /incompatible/,
  );
  await assert.rejects(
    checkUpdate(
      { ...trust, currentVersion: "0.6.0" },
      signedFetch(signedRelease),
      1000,
    ),
    /incompatible/,
  );
  assert.equal(
    await checkUpdate(
      { ...options, currentVersion: "0.6.1" },
      signedFetch(signedRelease),
      1000,
    ),
    null,
  );
});
