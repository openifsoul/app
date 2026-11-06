// Adapted from the official shadcn/ui sidebar-07 block (MIT).
import {
  ChevronRight,
  Database,
  FlaskConical,
  Gamepad2,
  Home,
  MessageCircle,
  Settings2,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { BrandMark } from "./BrandMark";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "./ui/sidebar";
import { useRuntimeAuth } from "../lib/runtime-auth";

export type AppSection =
  "characters" | "chat" | "memory" | "settings" | "laboratory";
export const SECTION_LABELS: Record<AppSection, string> = {
  characters: "Characters",
  chat: "Conversation",
  memory: "Memory",
  settings: "Settings",
  laboratory: "Laboratory",
};
const sections: { id: AppSection; icon: LucideIcon }[] = [
  { id: "chat", icon: MessageCircle },
  { id: "characters", icon: Users },
  { id: "memory", icon: Database },
  { id: "settings", icon: Settings2 },
];
export function AppSidebar({
  section,
  onNavigate,
}: {
  section: AppSection;
  onNavigate: (section: AppSection) => void;
}) {
  const auth = useRuntimeAuth();
  const { setOpenMobile } = useSidebar();
  function navigate(next: AppSection) {
    onNavigate(next);
    setOpenMobile(false);
  }
  return (
    <Sidebar collapsible="icon" variant="inset" aria-label="App navigation">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="IfSoul App">
              <a href="/" className="app-sidebar-brand">
                <BrandMark size={32} />
                <span>
                  <strong>IfSoul</strong>
                  <small>
                    App ·{" "}
                    {auth.config.mode === "local"
                      ? "This computer"
                      : "Cloud workspace"}
                  </small>
                </span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent role="navigation" aria-label="Workspace navigation">
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarMenu>
            <Collapsible asChild defaultOpen className="group/collapsible">
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton
                    tooltip="Your character"
                    isActive={section !== "laboratory"}
                  >
                    <Sparkles />
                    <span>Your character</span>
                    <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                  </SidebarMenuButton>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {sections.map(({ id, icon: Icon }) => (
                      <SidebarMenuSubItem key={id}>
                        <SidebarMenuSubButton asChild isActive={section === id}>
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
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
            {sections.map(({ id, icon: Icon }) => (
              <SidebarMenuItem
                key={id}
                className="hidden group-data-[collapsible=icon]:block"
              >
                <SidebarMenuButton
                  isActive={section === id}
                  tooltip={SECTION_LABELS[id]}
                  onClick={() => navigate(id)}
                  aria-label={SECTION_LABELS[id]}
                >
                  <Icon />
                  <span>{SECTION_LABELS[id]}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Explore</SidebarGroupLabel>
          <SidebarMenu>
            {auth.config.mode === "cloud" && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Playground">
                  <a href="/demo">
                    <Gamepad2 />
                    <span>Playground</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            {auth.config.mode === "local" && auth.config.laboratory && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Local Laboratory"
                  isActive={section === "laboratory"}
                  onClick={() => navigate("laboratory")}
                >
                  <FlaskConical />
                  <span>Laboratory</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Home">
              <a href="/">
                <Home />
                <span>Home</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="app-account">
          <span>
            {auth.config.mode === "local" ? "No account needed" : auth.userName}
          </span>
          {auth.accountView}
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
