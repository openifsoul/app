import { startCompanion } from "./bridge/src/companion.mjs";

const port = process.parentPort;
const companion = await startCompanion({
  port: Number(process.env.IFSOUL_DESKTOP_COMPANION_PORT),
  hostSecret: process.env.IFSOUL_DESKTOP_SECRET,
  desktopOrigin: process.env.IFSOUL_DESKTOP_ORIGIN,
  responseKey: process.env.IFSOUL_DESKTOP_RESPONSE_KEY,
});
port.on("message", async ({ data }) => {
  if (data === "stop") {
    await companion.stop();
    process.exit(0);
  }
  if (data === "update-status") {
    port.postMessage({
      type: "update-status",
      running: companion.status().running,
    });
  }
  if (data === "approve") {
    try {
      port.postMessage({
        type: "approved",
        code: companion.approve(process.env.IFSOUL_DESKTOP_ORIGIN),
      });
    } catch {
      port.postMessage({ type: "approval-failed" });
    }
  }
});
port.postMessage({ type: "ready" });
