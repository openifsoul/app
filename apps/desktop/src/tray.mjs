import { join } from "node:path";

export function attachDesktopTray({
  app,
  Menu,
  Tray,
  nativeImage,
  root,
  window,
}) {
  function open() {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  let tray;
  let quitting = false;
  try {
    const template = process.platform === "darwin";
    const icon = nativeImage.createFromPath(
      join(root, "icons", template ? "trayTemplate.png" : "tray.png"),
    );
    if (icon.isEmpty()) throw Error("Desktop tray icon could not be loaded.");
    if (template) icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip("IfSoul");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open IfSoul", click: open },
        { label: "Quit IfSoul", click: () => app.quit() },
      ]),
    );
    if (!template) tray.on("click", open);
  } catch (error) {
    tray?.destroy();
    tray = undefined;
    console.warn("Desktop tray unavailable:", error.message);
  }

  app.on("activate", open);
  app.on("second-instance", open);
  app.on("before-quit", () => {
    quitting = true;
    tray?.destroy();
  });
  window.on("close", (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    window.hide();
  });
}
