import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./ui/sheet";
import { SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";
import { desktopBridge, type DesktopUpdateProgress } from "../lib/desktop";

const assets = [
  {
    label: "macOS (Apple silicon)",
    url: import.meta.env?.VITE_IFSOUL_MACOS_DOWNLOAD as string | undefined,
  },
  {
    label: "Windows (x64)",
    url: import.meta.env?.VITE_IFSOUL_WINDOWS_DOWNLOAD as string | undefined,
  },
].flatMap(({ label, url }) => {
  if (!url) return [];
  try {
    const link = new URL(url);
    if (
      link.protocol === "https:" &&
      !link.username &&
      !link.password &&
      !link.hash
    )
      return [{ label, href: link.href }];
  } catch {}
  return [];
});

const updateProgress: Record<DesktopUpdateProgress, string> = {
  downloading: "Downloading the update…",
  verifying: "Verifying the downloaded update…",
  preparing: "Checking that the update opens your workspace…",
  restarting: "Restarting IfSoul…",
};

export function SidebarDesktopAction() {
  const bridge = desktopBridge();
  const [version, setVersion] = useState<string>();
  const [progress, setProgress] = useState<DesktopUpdateProgress>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!bridge?.getUpdateStatus) return;
    let active = true;
    const refresh = () =>
      void bridge
        .getUpdateStatus()
        .then((status) => {
          if (!active) return;
          if (!pending) setVersion(status.version);
          setProgress(status.progress);
        })
        .catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, pending ? 1000 : 60000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [bridge, pending]);

  if (!bridge)
    return (
      <SidebarMenuItem>
        <Sheet>
          <SheetTrigger asChild>
            <SidebarMenuButton
              className="touch-target"
              tooltip="Download app"
              aria-label="Download app"
            >
              <Download aria-hidden="true" />
              <span>Download app</span>
            </SidebarMenuButton>
          </SheetTrigger>
          <SheetContent side="left">
            <SheetHeader>
              <SheetTitle>Download IfSoul Desktop</SheetTitle>
              <SheetDescription>
                {assets.length
                  ? "Unsigned test builds for macOS (Apple silicon) and Windows (x64). Windows has not been tested on a native system. macOS may warn or block installation. Windows updates are manual."
                  : "Desktop installers aren’t available to download yet. You can keep using IfSoul in your browser."}
              </SheetDescription>
            </SheetHeader>
            {assets.length > 0 && (
              <ul className="grid gap-2">
                {assets.map(({ label, href }) => (
                  <li key={label}>
                    <a
                      className="inline-flex min-h-11 items-center underline"
                      href={href}
                    >
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </SheetContent>
        </Sheet>
      </SidebarMenuItem>
    );

  if (!version && !message) return null;
  const install = async () => {
    if (pending) return;
    setPending(true);
    setMessage("");
    try {
      const { status } = await bridge.installUpdate();
      if (status === "restarting") {
        setProgress("restarting");
        return;
      }
      if (status === "unavailable") {
        setVersion(undefined);
        setMessage(
          "That update is no longer available. IfSoul will check again.",
        );
      } else if (status === "active-game") {
        setMessage(
          "End your game session. Stop the companion or revoke the server bridge connection in Games, then try again.",
        );
      } else if (status === "rejected") {
        setVersion(undefined);
        setMessage(
          "The update couldn’t open your workspace. You can continue using this version.",
        );
      } else if (status === "failed") {
        setMessage("The update couldn’t be installed. Try again.");
      }
    } catch {
      setMessage("The update couldn’t be installed. Try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <SidebarMenuItem>
      {version && (
        <SidebarMenuButton
          className="touch-target"
          disabled={pending || progress === "restarting"}
          onClick={() => void install()}
          tooltip={`Update to IfSoul ${version}`}
          aria-label={`Update to IfSoul ${version}`}
        >
          <RefreshCw aria-hidden="true" />
          <span>{pending ? "Updating…" : "Update"}</span>
        </SidebarMenuButton>
      )}
      <p
        className="px-2 text-xs group-data-[collapsible=icon]:sr-only"
        role="status"
      >
        {progress
          ? updateProgress[progress]
          : pending
            ? "Preparing the update…"
            : message}
      </p>
    </SidebarMenuItem>
  );
}
