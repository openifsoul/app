import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { rollbackMacTrial } from "./update-install.mjs";

const startupDeadlineMs = 35000;
const stopDeadlineMs = 5000;

async function trialState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8")).phase;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "accepted";
  }
}

function launch(executable, statePath, trial) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.IFSOUL_DESKTOP_UPDATE_TRIAL;
  if (trial) env.IFSOUL_DESKTOP_UPDATE_TRIAL = statePath;
  return spawn(executable, ["--user-data-dir=" + dirname(statePath)], {
    detached: true,
    stdio: "ignore",
    env,
  });
}

function watchChild(child) {
  const controller = new AbortController();
  const exited = new Promise((resolve) => {
    const finish = () => {
      controller.abort();
      resolve();
    };
    child.once("error", finish);
    child.once("exit", finish);
  });
  return { exited, signal: controller.signal };
}

function signalGroup(child, signal) {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

async function stopTrial(child, exited, graceMs) {
  async function waitForGroup() {
    const deadline = Date.now() + graceMs;
    while (signalGroup(child, 0)) {
      if (Date.now() >= deadline) return false;
      await delay(50);
    }
    return true;
  }
  if (signalGroup(child, "SIGTERM") && !(await waitForGroup())) {
    signalGroup(child, "SIGKILL");
    if (!(await waitForGroup()))
      throw Error("The candidate process group did not exit.");
  }
  await exited;
}

export async function superviseMacTrial({
  current,
  statePath,
  start = launch,
  rollback = rollbackMacTrial,
  startupMs = startupDeadlineMs,
  stopMs = stopDeadlineMs,
}) {
  const executable = join(current, "Contents/MacOS/IfSoul");
  const child = start(executable, statePath, true);
  const { exited, signal } = watchChild(child);
  const deadline = Date.now() + startupMs;
  while (!signal.aborted && Date.now() < deadline) {
    if ((await trialState(statePath)) === "accepted") {
      child.unref();
      return "accepted";
    }
    await delay(100, undefined, { signal }).catch((error) => {
      if (error.name !== "AbortError") throw error;
    });
  }
  if ((await trialState(statePath)) === "accepted") {
    child.unref();
    return "accepted";
  }
  await stopTrial(child, exited, stopMs);
  if (!(await rollback({ current, statePath }))) {
    child.unref();
    return "accepted";
  }
  const previous = start(executable, statePath, false);
  await new Promise((resolve, reject) => {
    previous.once("spawn", resolve);
    previous.once("error", reject);
  });
  previous.unref();
  return "restored";
}

if (process.send && process.argv[1]?.endsWith("/update-supervisor.mjs")) {
  const [current, statePath] = process.argv.slice(2);
  process.once("disconnect", () => {
    void superviseMacTrial({ current, statePath }).catch(() => {
      process.exitCode = 1;
    });
  });
  process.send("ready");
}
