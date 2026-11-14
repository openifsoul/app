const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "ifsoulDesktop",
  Object.freeze({
    getUpdateStatus: () => ipcRenderer.invoke("desktop:update-status"),
    installUpdate: () => ipcRenderer.invoke("desktop:install-update"),
    installServerBridge: (id) =>
      ipcRenderer.invoke("desktop:install-server-bridge", id),
    openService: (origin) => ipcRenderer.invoke("desktop:open-service", origin),
    approveMinecraft: () => ipcRenderer.invoke("desktop:approve-minecraft"),
  }),
);
