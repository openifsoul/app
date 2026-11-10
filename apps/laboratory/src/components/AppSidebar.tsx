// Adapted from the official shadcn/ui sidebar-07 block (MIT).
import { useState } from "react";
import { Avatar, DropdownMenu } from "radix-ui";
import {
  ChevronsUpDown,
  CircleHelp,
  Database,
  FlaskConical,
  Gamepad2,
  LoaderCircle,
  LogOut,
  MessageCircle,
  Moon,
  Settings2,
  Sparkles,
  Sun,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { BrandMark } from "./BrandMark";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "./ui/sidebar";
import { useRuntimeAuth } from "../lib/runtime-auth";
import { useTheme } from "../lib/theme";

export type AppSection =
  | "characters"
  | "chat"
  | "memory"
  | "behavior"
  | "settings"
  | "games"
  | "balance"
  | "laboratory";
export const SECTION_LABELS: Record<AppSection, string> = {
  characters: "Characters",
  chat: "Conversation",
  memory: "Memory",
  settings: "Settings",
  behavior: "Behavior",
  laboratory: "Laboratory",
  games: "Games",
  balance: "Balance",
};
const sections: { id: AppSection; icon: LucideIcon }[] = [
  { id: "chat", icon: MessageCircle },
  { id: "characters", icon: Users },
  { id: "memory", icon: Database },
  { id: "behavior", icon: Sparkles },
  { id: "games", icon: Gamepad2 },
  { id: "balance", icon: Wallet },
];

export function AppSidebar({
  section,
  onNavigate,
}: {
  section: AppSection;
  onNavigate: (section: AppSection) => void;
}) {
  const auth = useRuntimeAuth();
  const { isMobile, setOpenMobile } = useSidebar();
  const { theme, toggleTheme } = useTheme();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const runtimeLabel =
    auth.config.placement === "selfhost"
      ? "Self-hosted"
      : auth.config.mode === "local"
        ? "Local"
        : "Cloud";
  const canSignOut = auth.config.auth !== "local";
  const initials =
    auth.userName
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase() || "IF";
  function navigate(next: AppSection) {
    setMenuOpen(false);
    onNavigate(next);
    setOpenMobile(false);
  }
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError("");
    try {
      await auth.signOut();
      setMenuOpen(false);
    } catch {
      setSignOutError("Could not sign out. Please try again.");
    } finally {
      setSigningOut(false);
    }
  }
  return (
    <Sidebar collapsible="icon" variant="inset" aria-label="App navigation">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="IfSoul App">
              <a
                href="/"
                className="app-sidebar-brand"
                aria-label="IfSoul App home"
              >
                <BrandMark size={64} />
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent role="navigation" aria-label="Workspace navigation">
        <SidebarGroup>
          <SidebarMenu>
            {sections.map(({ id, icon: Icon }) => (
              <SidebarMenuItem key={id}>
                <SidebarMenuButton
                  asChild
                  isActive={section === id}
                  tooltip={SECTION_LABELS[id]}
                >
                  <a
                    href={`/app/${id}`}
                    aria-current={section === id ? "page" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(id);
                    }}
                  >
                    <Icon />
                    <span>{SECTION_LABELS[id]}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        {(auth.playgroundHref ||
          (auth.config.mode === "local" && auth.config.laboratory)) && (
          <SidebarGroup>
            <SidebarGroupLabel>Explore</SidebarGroupLabel>
            <SidebarMenu>
              {auth.playgroundHref && (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="Playground">
                    <a href={auth.playgroundHref}>
                      <Gamepad2 />
                      <span>Playground</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {auth.config.mode === "local" && auth.config.laboratory && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip="Local Laboratory"
                    isActive={section === "laboratory"}
                  >
                    <a
                      href="/app/laboratory"
                      aria-current={
                        section === "laboratory" ? "page" : undefined
                      }
                      onClick={(event) => {
                        event.preventDefault();
                        navigate("laboratory");
                      }}
                    >
                      <FlaskConical />
                      <span>Laboratory</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Help on Telegram">
              <a
                href="https://t.me/h3lpkey"
                target="_blank"
                rel="noopener noreferrer"
              >
                <CircleHelp aria-hidden="true" />
                <span>Help</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenu.Trigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="app-user-trigger"
                  tooltip="Workspace menu"
                  aria-label="Workspace menu"
                >
                  <Avatar.Root className="app-user-avatar">
                    <Avatar.Image src={auth.userImageUrl} alt="" />
                    <Avatar.Fallback>{initials}</Avatar.Fallback>
                  </Avatar.Root>
                  <span className="app-user-copy">
                    <strong>{auth.userName}</strong>
                    <small>{runtimeLabel}</small>
                  </span>
                  <ChevronsUpDown className="ml-auto" />
                </SidebarMenuButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="app-user-menu"
                  side={isMobile ? "top" : "right"}
                  align="end"
                  sideOffset={8}
                  collisionPadding={12}
                >
                  <DropdownMenu.Label className="app-user-menu-label">
                    <strong>{auth.userName}</strong>
                    <span>{runtimeLabel}</span>
                  </DropdownMenu.Label>
                  <DropdownMenu.Separator className="app-user-menu-separator" />
                  <DropdownMenu.Item
                    className="app-user-menu-item"
                    onSelect={() => navigate("settings")}
                  >
                    <Settings2 />
                    <span>Settings</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="app-user-menu-item"
                    onSelect={(event) => {
                      event.preventDefault();
                      toggleTheme();
                    }}
                  >
                    {theme === "dark" ? <Sun /> : <Moon />}
                    <span>
                      Switch to {theme === "dark" ? "light" : "dark"} theme
                    </span>
                  </DropdownMenu.Item>
                  {canSignOut && (
                    <>
                      <DropdownMenu.Separator className="app-user-menu-separator" />
                      <DropdownMenu.Item
                        className="app-user-menu-item"
                        disabled={signingOut}
                        onSelect={(event) => {
                          event.preventDefault();
                          void signOut();
                        }}
                      >
                        {signingOut ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <LogOut />
                        )}
                        <span>{signingOut ? "Signing out…" : "Sign out"}</span>
                      </DropdownMenu.Item>
                    </>
                  )}
                  {signOutError && (
                    <p className="app-user-menu-error" role="alert">
                      {signOutError}
                    </p>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
