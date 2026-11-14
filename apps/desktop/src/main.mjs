import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
  utilityProcess,
} from "electron";
import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  desktopLoopbackOrigins,
  isOrigin,
  validatedServiceOrigin,
} from "./security.mjs";

import {
  desktopUpdateConfiguration,
  finishMacUpdate,
  installMacUpdate,
  recoverMacUpdate,
} from "./update-install.mjs";
import { checkUpdate } from "./update-feed.mjs";
import { attachDesktopTray } from "./tray.mjs";
import { bridgeInstallProfile, installLocalBridge } from "./bridge-install.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const { appOrigin, companionOrigin } = desktopLoopbackOrigins(process.env);
const probeIndex = process.argv.indexOf("--ifsoul-update-probe");
const probeProfile = probeIndex === -1 ? null : process.argv[probeIndex + 1];
const probeResult = probeIndex === -1 ? null : process.argv[probeIndex + 2];
const probing = probeIndex !== -1;
const secret = randomBytes(32).toString("base64url");
const responseKey = randomBytes(32).toString("base64url");
const proofFor = (nonce) =>
  createHmac("sha256", responseKey).update(nonce).digest("base64url");
const children = new Map();
let window;
let controlToken;
let approving = false;
let quitting = false;
let restarting = false;
let serviceData;
let pendingUpdate;
let serviceFailure = false;
let checkingUpdate = false;
let quitAfterUpdate = false;
let updateLocation;

function awaitMessage(child, types, send) {
  return new Promise((resolve, reject) => {
    function finish(error, message) {
      clearTimeout(timer);
      child.off("exit", exited);
      child.off("message", received);
      child.off("error", failed);
      if (error) reject(error);
      else resolve(message);
    }
    const exited = () => finish(Error("Process exited"));
    const failed = () => finish(Error("Process failed"));
    const received = (message) => {
      if (types.includes(message?.type)) finish(null, message);
    };
    const timer = setTimeout(() => finish(Error("Process timed out")), 15000);
    child.once("exit", exited);
    child.once("error", failed);
    child.on("message", received);
    send?.();
  });
}

async function launch(name, entry, env) {
  const child = utilityProcess.fork(join(root, entry), [], {
    cwd: root,
    serviceName: name,
    stdio: "ignore",
    env: {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      IFSOUL_DESKTOP_SECRET: secret,
      IFSOUL_DESKTOP_RESPONSE_KEY: responseKey,
      IFSOUL_DESKTOP_COMPANION_PORT: new URL(companionOrigin).port,
      ...env,
    },
  });
  const exited = new Promise((resolve) => {
    child.once("exit", async () => {
      if (name === "IfSoul Service" && pid) {
        const lock = join(serviceData, "memory.sqlite.lock");
        try {
          const owner = JSON.parse(await readFile(lock, "utf8"));
          // The tracked utility process has already exited. Only release its lock.
          if (owner.pid === pid) await unlink(lock);
        } catch {}
      }
      if (name === "IfSoul Service") serviceFailure = true;
      children.delete(child);
      resolve();
      if (!quitting && !restarting) void recover();
    });
  });
  let pid;
  child.once("spawn", () => {
    pid = child.pid;
  });
  children.set(child, exited);
  try {
    await awaitMessage(child, ["ready"]);
    return child;
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function closeProcesses() {
  await Promise.all(
    [...children].map(async ([child, exited]) => {
      child.postMessage("stop");
      const timeout = setTimeout(() => child.kill(), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
}

async function recover() {
  restarting = true;
  if (window && !window.isDestroyed()) window.hide();
  await closeProcesses();
  if (quitting) return;
  if (probing) {
    app.exit(1);
    return;
  }
  if (pendingUpdate) {
    try {
      await finishMacUpdate({
        ...updateLocation,
        state: pendingUpdate,
        accepted: false,
      });
      app.relaunch();
      app.quit();
      return;
    } catch (error) {
      console.warn(
        "Could not recover the previous Desktop bundle:",
        error.message,
      );
      app.exit(1);
      return;
    }
  }
  const result = await dialog.showMessageBox({
    type: "error",
    title: "IfSoul Desktop",
    message: "A local IfSoul process stopped.",
    detail: `Restart IfSoul with available ports. This launch uses service port ${new URL(appOrigin).port} and companion port ${new URL(companionOrigin).port}. Your saved data remains in its application folder.`,
    buttons: ["Restart IfSoul", "Quit"],
    cancelId: 1,
  });
  if (result.response === 0) app.relaunch();
  app.quit();
}

function trusted(event, allowRestart = false) {
  return (
    window &&
    !quitting &&
    (!restarting || allowRestart) &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    isOrigin(event.senderFrame?.url, appOrigin)
  );
}

async function privateRequest(origin, path, body) {
  const nonce = randomBytes(24).toString("base64url");
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(12000),
    headers: {
      Origin: appOrigin,
      "X-IfSoul-Desktop": secret,
      "X-IfSoul-Desktop-Nonce": nonce,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (
    !response.ok ||
    response.headers.get("x-ifsoul-desktop-proof") !== proofFor(nonce)
  )
    throw Error("Request rejected");
  return response.json();
}

async function configureSession(contents) {
  const network = contents.session;
  await network.setProxy({ mode: "direct" });
  network.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  network.setPermissionCheckHandler(() => false);
  network.on("will-download", (event) => event.preventDefault());
  const proofs = new Map();
  const filter = { urls: [appOrigin + "/*"] };
  network.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = { ...details.requestHeaders };
    if (details.webContentsId === contents.id) {
      const nonce = randomBytes(24).toString("base64url");
      proofs.set(details.id, proofFor(nonce));
      headers["X-IfSoul-Desktop"] = secret;
      headers["X-IfSoul-Desktop-Nonce"] = nonce;
      if (
        new URL(details.url).pathname.startsWith("/api/desktop/companion/") &&
        controlToken
      ) {
        headers.Authorization = "Bearer " + controlToken;
      }
    }
    callback({ requestHeaders: headers });
  });
  network.webRequest.onHeadersReceived(filter, (details, callback) => {
    const headers = { ...details.responseHeaders };
    const proofHeader = Object.keys(headers).find(
      (key) => key.toLowerCase() === "x-ifsoul-desktop-proof",
    );
    const expected = proofs.get(details.id);
    if (
      details.webContentsId !== contents.id ||
      !proofHeader ||
      !expected ||
      headers[proofHeader]?.[0] !== expected
    ) {
      callback({ cancel: true });
      return;
    }
    delete headers[proofHeader];
    callback({ responseHeaders: headers });
  });
  network.webRequest.onCompleted(filter, (details) =>
    proofs.delete(details.id),
  );
  network.webRequest.onErrorOccurred(filter, (details) =>
    proofs.delete(details.id),
  );
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://github.com/openifsoul/"))
      void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!isOrigin(url, appOrigin)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isOrigin(url, appOrigin)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("render-process-gone", () => {
    if (!quitting && !restarting) void recover();
    else if (restarting && window && !window.isDestroyed()) window.destroy();
  });
}

async function assertWorkspaceReady(contents) {
  // This only reads the trusted same-origin DOM and service. The preload exposes no readiness IPC.
  const script = `(async () => {
    const timeout = Date.now() + 8000;
    while (!document.querySelector(".app-workspace") && Date.now() < timeout)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (!document.querySelector(".app-workspace")) return false;
    const response = await fetch("/api/status", { signal: AbortSignal.timeout(5000) });
    if (!response.ok || !(await response.json()).authenticated) return false;
    const characters = await fetch("/api/characters", { signal: AbortSignal.timeout(5000) });
    return characters.ok && (await characters.json()).ok === true;
  })()`;
  if (!(await contents.executeJavaScript(script)))
    throw Error("Desktop workspace did not finish startup.");
}

function desktopUpdateLocation(userData) {
  if (
    probing ||
    !app.isPackaged ||
    process.platform !== "darwin" ||
    process.arch !== "arm64"
  )
    return undefined;
  const current = dirname(dirname(dirname(process.execPath)));
  return basename(current) === "IfSoul.app"
    ? { current, statePath: join(userData, "desktop-update.json") }
    : undefined;
}

async function start() {
  const userData = app.getPath("userData");
  await mkdir(userData, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(userData, 0o700);
  serviceData = join(userData, "service");
  restarting = true;
  updateLocation = desktopUpdateLocation(userData);
  const recovered = updateLocation && (await recoverMacUpdate(updateLocation));
  if (recovered?.restart) {
    app.relaunch();
    app.quit();
    return;
  }
  if (recovered?.phase === "booting") pendingUpdate = recovered;
  let rejectedSha =
    recovered?.phase === "rejected" ? recovered.sha256 : undefined;
  const serviceEnvironment = {
    PORT: new URL(appOrigin).port,
    IFSOUL_DATA_DIR: serviceData,
  };
  const launchService = () =>
    launch(
      "IfSoul Service",
      "dist/server/apps/server/src/local.js",
      serviceEnvironment,
    );
  await launchService();
  let bridge;
  let release;
  let progress;
  let configuration;
  let statusRequest;
  const updateStatus = () => ({
    ...(release ? { version: release.version } : {}),
    ...(progress ? { progress } : {}),
  });

  async function activeGame() {
    if (approving) return true;
    if (bridge) {
      const status = await awaitMessage(bridge, ["update-status"], () =>
        bridge.postMessage("update-status"),
      );
      if (status.running !== false) return true;
    }
    const result = await privateRequest(appOrigin, "/api/game-connections");
    if (!Array.isArray(result.connections))
      throw Error("Game status unavailable.");
    // Server adapters lack a disconnect signal. A ready grant remains active until revoked or expired.
    const now = Date.now();
    return result.connections.some(
      (binding) =>
        !binding.revoked &&
        binding.expiresAt > now &&
        binding.lastSeen !== undefined,
    );
  }

  ipcMain.handle("desktop:update-status", async (event, ...args) => {
    if (!trusted(event, true) || args.length || !updateLocation) return {};
    if (checkingUpdate) return updateStatus();
    statusRequest ??= (async () => {
      try {
        configuration = await desktopUpdateConfiguration(root);
        const next =
          configuration &&
          (await checkUpdate({
            ...configuration,
            currentVersion: app.getVersion(),
          }));
        release = next && next.sha256 !== rejectedSha ? next : undefined;
      } catch {
        release = undefined;
      }
    })().finally(() => {
      statusRequest = undefined;
    });
    await statusRequest;
    return trusted(event) ? updateStatus() : {};
  });

  ipcMain.handle("desktop:install-update", async (event, ...args) => {
    if (
      !trusted(event) ||
      args.length ||
      !updateLocation ||
      !release ||
      checkingUpdate
    )
      return { status: "unavailable" };
    const expected = release;
    let stopped = false;
    let blocked = false;
    let cancelled = false;
    checkingUpdate = true;
    try {
      if (await activeGame()) return { status: "active-game" };
      if (!trusted(event)) return { status: "unavailable" };
      const result = await installMacUpdate({
        ...updateLocation,
        config: configuration,
        currentVersion: app.getVersion(),
        expectedSha256: expected.sha256,
        serviceData,
        reportProgress: (step) => {
          progress = step;
        },
        beforeProbe: async () => {
          const answer = await dialog.showMessageBox(window, {
            type: "question",
            title: "Update IfSoul",
            message: `Install IfSoul ${expected.version} and restart?`,
            detail:
              "Save any open drafts before restarting. Saved conversations and memory stay in this workspace.",
            buttons: ["Cancel", "Update and restart"],
            cancelId: 0,
            defaultId: 0,
          });
          if (answer.response !== 1 || !trusted(event) || quitAfterUpdate) {
            cancelled = true;
            throw Error("Update restart cancelled.");
          }
          if (await activeGame()) {
            blocked = true;
            throw Error("Game started during update preparation.");
          }
          restarting = true;
          stopped = true;
          controlToken = undefined;
          await closeProcesses();
          bridge = undefined;
        },
      });
      if (result === "relaunch") {
        progress = "restarting";
        if (!quitAfterUpdate) app.relaunch();
        checkingUpdate = false;
        app.quit();
        return { status: "restarting" };
      }
      release = undefined;
      return { status: "unavailable" };
    } catch {
      if (stopped) {
        rejectedSha = expected.sha256;
        release = undefined;
        return { status: "rejected" };
      }
      return {
        status: cancelled ? "cancelled" : blocked ? "active-game" : "failed",
      };
    } finally {
      if (progress !== "restarting") {
        if (stopped && !quitAfterUpdate) {
          try {
            serviceFailure = false;
            await launchService();
            restarting = false;
          } catch {
            void recover();
          }
        }
        progress = undefined;
        checkingUpdate = false;
        if (quitAfterUpdate) app.quit();
      }
    }
  });
  ipcMain.handle("desktop:approve-minecraft", async (event, ...args) => {
    if (!trusted(event) || args.length || approving || checkingUpdate)
      return { ok: false };
    approving = true;
    try {
      const confirmation = await dialog.showMessageBox(window, {
        type: "question",
        title: "Minecraft companion",
        message:
          "Allow IfSoul Desktop to manage the bundled Minecraft companion?",
        detail:
          "IfSoul will start the local companion. Review your server, player and character settings before connecting. Approving again pauses any existing companion connection.",
        buttons: ["Cancel", "Allow"],
        defaultId: 0,
        cancelId: 0,
      });
      if (confirmation.response !== 1 || !trusted(event)) return { ok: false };
      controlToken = undefined;
      if (!bridge) {
        try {
          bridge = await launch(
            "IfSoul Minecraft Companion",
            "bridge-worker.mjs",
            {
              IFSOUL_COMPANION_DATA_DIR: join(userData, "minecraft"),
              IFSOUL_DESKTOP_ORIGIN: appOrigin,
            },
          );
        } catch {
          return { ok: false };
        }
      }
      const approval = await awaitMessage(
        bridge,
        ["approved", "approval-failed"],
        () => bridge.postMessage("approve"),
      );
      if (approval.type !== "approved" || !trusted(event)) return { ok: false };
      const proof = await privateRequest(
        appOrigin,
        "/api/game-connections/control-proof",
        {},
      );
      const paired = await privateRequest(companionOrigin, "/pair", {
        code: approval.code,
        ownerProof: proof.code,
      });
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(paired.controlToken) ||
        !Number.isSafeInteger(paired.expiresAt) ||
        paired.expiresAt <= Date.now()
      )
        return { ok: false };
      controlToken = paired.controlToken;
      return { ok: true, expiresAt: paired.expiresAt };
    } catch {
      return { ok: false };
    } finally {
      approving = false;
    }
  });
  ipcMain.handle(
    "desktop:install-server-bridge",
    async (event, id, ...args) => {
      if (!trusted(event) || args.length || !bridgeInstallProfile(id))
        return { status: "unavailable" };
      try {
        const archive = await dialog.showOpenDialog(window, {
          properties: ["openFile"],
          filters: [{ name: "IfSoul bridge JAR", extensions: ["jar"] }],
        });
        if (archive.canceled || !trusted(event)) return { status: "cancelled" };
        const directory = await dialog.showOpenDialog(window, {
          title: "Choose your stopped Minecraft server folder",
          properties: ["openDirectory"],
        });
        if (directory.canceled || !trusted(event))
          return { status: "cancelled" };
        const confirm = await dialog.showMessageBox(window, {
          message:
            "Install this IfSoul bridge in the selected Minecraft server?",
          detail:
            "Stop the server before continuing. Existing files will not be replaced.",
          buttons: ["Cancel", "Install"],
          defaultId: 0,
          cancelId: 0,
        });
        if (confirm.response !== 1 || !trusted(event))
          return { status: "cancelled" };
        await installLocalBridge(
          id,
          archive.filePaths[0],
          directory.filePaths[0],
        );
        return { status: "installed" };
      } catch {
        return { status: "unavailable" };
      }
    },
  );
  ipcMain.handle("desktop:open-service", async (event, value, ...args) => {
    if (!trusted(event) || args.length) return false;
    const origin = validatedServiceOrigin(value);
    if (!origin) return false;
    const result = await dialog.showMessageBox(window, {
      type: "question",
      title: "Open an IfSoul service",
      message: `Open ${origin} in your browser?`,
      detail:
        "Sign in to that service in your browser. Local memory stays in IfSoul Desktop.",
      buttons: ["Cancel", "Open in browser"],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1 || !trusted(event)) return false;
    try {
      await shell.openExternal(origin + "/app");
      return true;
    } catch {
      return false;
    }
  });
  window = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 360,
    minHeight: 520,
    show: false,
    icon: join(root, "icons", "tray.png"),
    webPreferences: {
      session: session.fromPartition("ifsoul-desktop"),
      preload: join(root, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  });
  await configureSession(window.webContents);
  const timeout = setTimeout(() => {
    if (!window.isDestroyed()) window.destroy();
  }, 15000);
  try {
    await window.loadURL(appOrigin);
    if (probing || pendingUpdate)
      await assertWorkspaceReady(window.webContents);
  } finally {
    clearTimeout(timeout);
  }
  if ((probing || pendingUpdate) && serviceFailure)
    throw Error("Desktop service stopped during startup.");
  if (probing) {
    await launch("IfSoul Minecraft Companion", "bridge-worker.mjs", {
      IFSOUL_COMPANION_DATA_DIR: join(userData, "minecraft"),
      IFSOUL_DESKTOP_ORIGIN: appOrigin,
    });
    await closeProcesses();
    await writeFile(probeResult, "ready\n", { flag: "wx", mode: 0o600 });
    app.quit();
    return;
  }
  if (pendingUpdate) {
    await finishMacUpdate({
      ...updateLocation,
      state: pendingUpdate,
      accepted: true,
    });
    pendingUpdate = undefined;
  }
  restarting = false;
  attachDesktopTray({ app, Menu, Tray, nativeImage, root, window });
  window.show();
}

app.enableSandbox();
if (probing) {
  if (
    !probeProfile ||
    !probeResult ||
    !isAbsolute(probeProfile) ||
    !isAbsolute(probeResult) ||
    dirname(probeProfile) !== dirname(probeResult) ||
    !basename(dirname(probeProfile)).startsWith(".ifsoul-update-") ||
    basename(probeProfile) !== "profile" ||
    basename(probeResult) !== "ready"
  )
    app.exit(1);
  else app.setPath("userData", probeProfile);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("window-all-closed", () => {
    if (!restarting) app.quit();
  });
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (checkingUpdate) {
      quitAfterUpdate = true;
      return;
    }
    quitting = true;
    void closeProcesses().finally(() => app.quit());
  });
  app
    .whenReady()
    .then(start)
    .catch(() => void recover());
}
