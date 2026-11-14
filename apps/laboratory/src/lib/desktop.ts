export type DesktopUpdateProgress =
  "downloading" | "verifying" | "preparing" | "restarting";
export type DesktopUpdateResult =
  | "active-game"
  | "cancelled"
  | "failed"
  | "rejected"
  | "restarting"
  | "unavailable";

export interface DesktopBridge {
  getUpdateStatus(): Promise<{
    version?: string;
    progress?: DesktopUpdateProgress;
  }>;
  installUpdate(): Promise<{ status: DesktopUpdateResult }>;

  installServerBridge(
    id: string,
  ): Promise<{ status: "installed" | "cancelled" | "unavailable" }>;
  openService(origin: string): Promise<boolean>;
  approveMinecraft(): Promise<{ ok: boolean; expiresAt?: number }>;
}

export function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { ifsoulDesktop?: DesktopBridge }).ifsoulDesktop;
}
