import { execFile, spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  checkUpdate,
  distributionPolicy,
  downloadUpdate,
  product,
} from "./update-feed.mjs";

const exec = promisify(execFile);
const bundleName = "IfSoul.app";
const executable = "Contents/MacOS/IfSoul";
const desktopApp = "Contents/Resources/app";
const gracefulStopMs = 5000;
const startupTimeoutMs = 35000;

async function syncDirectory(path) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function writeState(path, state) {
  const temporary = path + ".next";
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(state));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function stageMacBundle(image, workspace) {
  const mount = join(workspace, "mounted");
  const bundle = join(workspace, bundleName);
  await mkdir(mount, { mode: 0o700 });
  // Attach errors can still leave a mounted image. Always attempt detachment
  // after an attach attempt, and never delete a directory containing a mount.
  try {
    await exec(
      "/usr/bin/hdiutil",
      [
        "attach",
        "-readonly",
        "-nobrowse",
        "-noautoopen",
        "-mountpoint",
        mount,
        image,
      ],
      { timeout: 30000 },
    );
    if (!(await exists(join(mount, bundleName)))?.isDirectory())
      throw Error("Update image has no IfSoul application.");
    await exec("/usr/bin/ditto", [join(mount, bundleName), bundle], {
      timeout: 90000,
    });
  } finally {
    const mountIdentity = await stat(mount);
    const workspaceIdentity = await stat(workspace);
    if (mountIdentity.dev !== workspaceIdentity.dev) {
      try {
        await exec("/usr/bin/hdiutil", ["detach", mount], { timeout: 15000 });
      } catch {
        await exec("/usr/bin/hdiutil", ["detach", "-force", mount], {
          timeout: 15000,
        });
      }
    }
  }
  return bundle;
}

export async function verifyMacBundle(bundle, release, trust) {
  const { stdout } = await exec("/usr/libexec/PlistBuddy", [
    "-c",
    "Print CFBundleIdentifier",
    join(bundle, "Contents/Info.plist"),
  ]);
  if (stdout.trim() !== product)
    throw Error("Incorrect macOS bundle identity.");
  const { stdout: architectures } = await exec("/usr/bin/lipo", [
    "-archs",
    join(bundle, executable),
  ]);
  if (architectures.trim() !== "arm64")
    throw Error("Incorrect Desktop architecture.");
  const manifest = await readJSON(join(bundle, desktopApp, "package.json"));
  const composition = await readJSON(
    join(bundle, desktopApp, "update-compatibility.json"),
  );
  const bridge = await readJSON(
    join(bundle, desktopApp, "bridge/source-receipt.json"),
  );
  if (
    manifest.name !== "ifsoul-desktop" ||
    manifest.version !== release.version ||
    composition.protocol !== release.protocol ||
    composition.dataFormat !== release.dataFormat ||
    JSON.stringify(composition.bridges) !== JSON.stringify(release.bridges) ||
    bridge.format !== release.bridges["minecraft-mineflayer"]?.protocol ||
    bridge.sha256 !== release.bridges["minecraft-mineflayer"]?.sha256
  )
    throw Error(
      "Desktop or bundled bridge compatibility does not match the signed release.",
    );
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
    timeout: 90000,
  });
  if (trust.distribution === distributionPolicy) return;
  const { stderr } = await exec("/usr/bin/codesign", [
    "-dv",
    "--verbose=4",
    bundle,
  ]);
  if (!stderr.split("\n").includes(`TeamIdentifier=${trust.signingTeam}`))
    throw Error("Incorrect macOS signing identity.");
}

export async function probeMacBundle(
  bundle,
  workspace,
  timeout = startupTimeoutMs,
) {
  const result = join(workspace, "ready");
  const profile = join(workspace, "profile");
  const child = spawn(
    join(bundle, executable),
    ["--ifsoul-update-probe", profile, result],
    {
      stdio: "ignore",
      env: {
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        ...(process.env.IFSOUL_DESKTOP_APP_PORT && {
          IFSOUL_DESKTOP_APP_PORT: process.env.IFSOUL_DESKTOP_APP_PORT,
        }),
        ...(process.env.IFSOUL_DESKTOP_COMPANION_PORT && {
          IFSOUL_DESKTOP_COMPANION_PORT:
            process.env.IFSOUL_DESKTOP_COMPANION_PORT,
        }),
        PATH: "/usr/bin:/bin",
      },
    },
  );
  let exited = false;
  const exit = new Promise((resolve) => {
    child.once("error", () => {
      exited = true;
      resolve(false);
    });
    child.once("exit", (code) => {
      exited = true;
      resolve(code === 0);
    });
  });
  let timer;
  try {
    const healthy = await Promise.race([
      exit,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeout);
      }),
    ]);
    if (
      !healthy ||
      (await readFile(result, "utf8").catch(() => "")) !== "ready\n"
    )
      throw Error("Updated Desktop did not complete its startup check.");
  } finally {
    clearTimeout(timer);
    if (!exited) {
      child.kill("SIGTERM");
      await Promise.race([
        exit,
        delay(gracefulStopMs, undefined, { ref: false }),
      ]);
      if (!exited) {
        child.kill("SIGKILL");
        await exit;
      }
    }
  }
}

export async function exchangeMacBundles(current, candidate, helper) {
  await exec(helper, [current, candidate]);
  await syncDirectory(dirname(current));
  await syncDirectory(dirname(candidate));
}

async function bundleIdentity(path) {
  const { dev, ino } = await stat(path);
  return { dev, ino };
}

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function safeWorkName(name) {
  return (
    typeof name === "string" && /^\.ifsoul-update-[A-Za-z0-9]+$/.test(name)
  );
}

export async function recoverMacUpdate({
  current,
  statePath,
  exchange = exchangeMacBundles,
}) {
  const state = await readJSON(statePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return null;
  if (state.current !== current) return null;
  if (
    !safeWorkName(state.workspace) ||
    !["exchange", "pending", "booting", "accepted", "rejected"].includes(
      state.phase,
    )
  )
    throw Error("Invalid Desktop update recovery record.");
  if (state.phase === "rejected") return state;
  const workspace = join(dirname(current), state.workspace);
  const candidate = join(workspace, bundleName);
  const active = await bundleIdentity(current);
  const saved = await exists(candidate);
  if (state.phase === "accepted") {
    if (!sameIdentity(active, state.next))
      throw Error("Accepted Desktop bundle changed.");
    if (saved && !sameIdentity(saved, state.previous))
      throw Error("Saved Desktop bundle changed.");
    await rm(workspace, { recursive: true, force: true });
    await rm(statePath, { force: true });
    return null;
  }
  const beforeSwap = sameIdentity(active, state.previous);
  if (
    !saved ||
    !sameIdentity(saved, beforeSwap ? state.next : state.previous) ||
    (!beforeSwap && !sameIdentity(active, state.next))
  )
    throw Error("Desktop update bundles changed during recovery.");
  if (!beforeSwap && state.phase !== "pending") {
    const helper = join(candidate, desktopApp, "ifsoul-swap");
    await exchange(current, candidate, helper);
  }
  if (beforeSwap || state.phase !== "pending") {
    await writeState(statePath, { ...state, phase: "rejected" });
    await rm(workspace, { recursive: true, force: true });
    return { ...state, phase: "rejected", restart: !beforeSwap };
  }
  const booting = { ...state, phase: "booting" };
  await writeState(statePath, booting);
  return booting;
}

export async function finishMacUpdate({
  current,
  statePath,
  state,
  accepted,
  exchange = exchangeMacBundles,
}) {
  const candidate = join(dirname(current), state.workspace, bundleName);
  if (accepted) {
    await writeState(statePath, { ...state, phase: "accepted" });
    // The installed application is now committed. Cleanup is retried at next startup.
    await recoverMacUpdate({ current, statePath, exchange }).catch(
      console.warn,
    );
    return;
  }
  const helper = join(candidate, desktopApp, "ifsoul-swap");
  // Record intent first: an interruption on either side of the exchange is recoverable.
  await writeState(statePath, { ...state, phase: "exchange" });
  await exchange(current, candidate, helper);
  await recoverMacUpdate({ current, statePath, exchange });
}

export async function installMacUpdate({
  current,
  statePath,
  config,
  loadConfig,
  serviceData,
  currentVersion,
  check = checkUpdate,
  download = downloadUpdate,
  stage = stageMacBundle,
  verify = verifyMacBundle,
  probe = probeMacBundle,
  exchange = exchangeMacBundles,
  expectedSha256,
  beforeProbe,
  reportProgress = () => {},
}) {
  const previous = await recoverMacUpdate({ current, statePath, exchange });
  if (previous?.restart) return "relaunch";
  if (previous?.phase === "booting") return previous;
  config ??= await loadConfig?.();
  if (!config) return null;

  const release = await check({ ...config, currentVersion });
  if (
    !release ||
    previous?.sha256 === release.sha256 ||
    (expectedSha256 && release.sha256 !== expectedSha256)
  )
    return null;

  const workspace = await mkdtemp(join(dirname(current), ".ifsoul-update-"));
  let recorded = false;
  let readyToProbe = false;
  try {
    const image = join(workspace, "update.dmg");
    reportProgress("downloading");
    await download(release, image);
    reportProgress("verifying");
    const candidate = await stage(image, workspace);
    await verify(candidate, release, config);
    await beforeProbe?.();
    readyToProbe = true;
    reportProgress("preparing");
    if (serviceData && (await exists(serviceData))?.isDirectory()) {
      const profile = join(workspace, "profile");
      await mkdir(profile, { mode: 0o700 });
      await cp(serviceData, join(profile, "service"), {
        recursive: true,
        filter: (path) => !path.endsWith(".lock"),
      });
    }
    await probe(candidate, workspace);
    await rm(join(workspace, "profile"), { recursive: true, force: true });
    await rm(image, { force: true });
    const state = {
      current,
      workspace: basename(workspace),
      sha256: release.sha256,
      previous: await bundleIdentity(current),
      next: await bundleIdentity(candidate),
      phase: "exchange",
    };
    await writeState(statePath, state);
    recorded = true;
    await exchange(
      current,
      candidate,
      join(current, desktopApp, "ifsoul-swap"),
    );
    await writeState(statePath, { ...state, phase: "pending" });
    return "relaunch";
  } catch (error) {
    if (recorded) {
      const recovery = await recoverMacUpdate({ current, statePath, exchange });
      if (recovery?.restart) return "relaunch";
    } else {
      const mount = await exists(join(workspace, "mounted"));
      if (!mount || mount.dev === (await stat(workspace)).dev)
        await rm(workspace, { recursive: true, force: true });
      if (readyToProbe || !beforeProbe)
        await writeState(statePath, {
          current,
          workspace: basename(workspace),
          sha256: release.sha256,
          phase: "rejected",
        }).catch(console.warn);
    }
    throw error;
  }
}

export async function desktopUpdateConfiguration(root) {
  const path = join(root, "update-trust.json");
  const config = await readJSON(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!config) return null;
  if (
    typeof config.feed !== "string" ||
    typeof config.publicKey !== "string" ||
    (config.distribution !== distributionPolicy &&
      (config.distribution !== undefined ||
        !/^[A-Z0-9]{10}$/.test(config.signingTeam)))
  )
    throw Error("Invalid Desktop update trust configuration.");
  return config;
}
