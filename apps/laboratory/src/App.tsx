import {
  AppSidebar,
  SECTION_LABELS,
  type AppSection,
} from "./components/AppSidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "./components/ui/sidebar";
import { Separator } from "./components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "./components/ui/breadcrumb";
import { useRuntimeAuth } from "./lib/runtime-auth";
import { BrandMark } from "./components/BrandMark";
import { useTheme } from "./lib/theme";
import { Characters } from "./components/Characters";
import type {
  CharacterDraft,
  CharacterTemplate,
  CharacterSummary,
} from "../../runtime-host/src/service-types";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  FlaskConical,
  LoaderCircle,
  Moon,
  RefreshCw,
  Sun,
} from "lucide-react";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Settings } from "./components/Settings";
import { ChatPanel, EvidencePanel, PlanPanel } from "./components/Workspace";
import {
  api,
  ApiError,
  friendlyError,
  type LabRunResponse,
  type LabSnapshot,
  type LabStatus,
  type ProviderId,
} from "./lib/api";

type PendingOperation = "plan" | "chat" | null;
const readDraft = (id = "character-lumen", userId = "local") => {
  try {
    return sessionStorage.getItem(`ifsoul-app-draft:${userId}:${id}`) ?? "";
  } catch {
    return "";
  }
};

function WorkspaceApp() {
  const auth = useRuntimeAuth();
  const laboratoryAvailable =
    auth.config.mode === "local" && auth.config.laboratory;
  const sectionForPath = (): AppSection => {
    const value =
      window.location.pathname === "/lab"
        ? "laboratory"
        : window.location.pathname.split("/")[2];
    return value &&
      Object.hasOwn(SECTION_LABELS, value) &&
      (value !== "laboratory" || laboratoryAvailable)
      ? (value as AppSection)
      : "chat";
  };
  const [section, setSection] = useState<AppSection>(sectionForPath);
  function navigate(next: AppSection) {
    if (next === "laboratory" && !laboratoryAvailable) return;
    setSection(next);
    window.history.pushState(null, "", `/app/${next}`);
  }
  useEffect(() => {
    const update = () => setSection(sectionForPath());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, [laboratoryAvailable]);
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [snapshot, setSnapshot] = useState<LabSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [provider, setProvider] = useState<ProviderId>("scenario");
  const [model, setModel] = useState("");
  const [pending, setPending] = useState<PendingOperation>(null);
  const [slow, setSlow] = useState(false);
  const [draft, setDraft] = useState(() =>
    readDraft("character-lumen", auth.userId),
  );
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [characterBusy, setCharacterBusy] = useState(false);
  const selectedCharacter = useRef("character-lumen");
  const selectedMemory = useRef("character-lumen");
  const draftKey = (profile: string, memory: string) =>
    profile === memory ? profile : `${profile}:${memory}`;
  const { theme, toggleTheme } = useTheme();
  useEffect(() => {
    document.title = `IfSoul · ${SECTION_LABELS[section]}`;
  }, [section]);
  const active = useRef(false);
  const retry = useRef<{ fingerprint: string; requestId: string } | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const characterId = selectedCharacter.current;
    const memoryCharacterId = selectedMemory.current;
    const next = await api<LabStatus>("status", { signal });
    const nextSnapshot = next.authenticated
      ? (next.snapshot ??
        (await api<LabSnapshot>(
          `snapshot?characterId=${encodeURIComponent(characterId)}&memoryCharacterId=${encodeURIComponent(memoryCharacterId)}`,
          { signal },
        )))
      : null;
    const catalog = next.authenticated
      ? await api<CharacterSummary[]>("characters", { signal })
      : [];
    if (
      signal?.aborted ||
      selectedCharacter.current !== characterId ||
      selectedMemory.current !== memoryCharacterId
    )
      return;
    setCharacters(catalog);
    setStatus(next);
    setSnapshot(nextSnapshot);
    setError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(friendlyError(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (!snapshot) return;
    try {
      sessionStorage.setItem(
        `ifsoul-app-draft:${auth.userId}:${draftKey(snapshot.persona?.characterId ?? snapshot.character.characterId, snapshot.character.characterId)}`,
        draft,
      );
    } catch {
      /* The in-memory draft remains available. */
    }
  }, [draft, snapshot?.character.characterId, snapshot?.persona?.characterId]);
  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(timer);
  }, [pending]);

  const selectedProvider = status?.providers.find(
    (item) => item.id === provider,
  );
  const selectedModel = selectedProvider?.models.some(
    (item) => item.id === model,
  )
    ? model
    : (selectedProvider?.models[0]?.id ?? "");
  const ready = Boolean(
    selectedProvider?.available && selectedModel && !pending && !characterBusy,
  );

  async function run(operation: "plan" | "chat") {
    if (active.current || !ready || (operation === "chat" && !draft.trim()))
      return;
    active.current = true;
    setPending(operation);
    setOperationError(null);
    const message = operation === "chat" ? draft.trim() : undefined;
    const characterId = selectedCharacter.current;
    const memoryCharacterId = selectedMemory.current;
    const fingerprint = JSON.stringify({
      characterId,
      memoryCharacterId,
      operation,
      provider,
      model: selectedModel,
      message,
    });
    if (retry.current?.fingerprint !== fingerprint)
      retry.current = { fingerprint, requestId: `web-${crypto.randomUUID()}` };
    try {
      const result = await api<LabRunResponse>(
        operation === "chat" ? "chat" : "lab/run",
        {
          method: "POST",
          body: {
            characterId,
            memoryCharacterId,
            operation,
            requestId: retry.current.requestId,
            provider,
            model: selectedModel,
            ...(message ? { message } : {}),
          },
        },
      );
      setSnapshot({
        character: result.character,
        persona: result.persona,
        memories: result.memories,
        runs: result.runs,
      });
      if (result.result.type === "failure") {
        retry.current = null; // A recorded failure is resolved; the next explicit attempt gets a new ID.
        throw new ApiError(result.result.error.code);
      }
      retry.current = null;
      if (operation === "chat") setDraft("");
    } catch (reason) {
      setOperationError(friendlyError(reason));
      if (reason instanceof ApiError && reason.code === "unauthorized")
        setStatus((old) => (old ? { ...old, authenticated: false } : old));
    } finally {
      setPending(null);
      active.current = false;
    }
  }

  async function chooseCharacter(
    id: string,
    memoryId = selectedMemory.current,
  ) {
    if (active.current) throw new ApiError("busy");
    active.current = true;
    setCharacterBusy(true);
    try {
      const next = await api<LabSnapshot>(
        `snapshot?characterId=${encodeURIComponent(id)}&memoryCharacterId=${encodeURIComponent(memoryId)}`,
      );
      selectedCharacter.current = id;
      selectedMemory.current = memoryId;
      setSnapshot(next);
      setDraft(readDraft(draftKey(id, memoryId), auth.userId));
      retry.current = null;
      setOperationError(null);
    } finally {
      active.current = false;
      setCharacterBusy(false);
    }
  }
  async function createCharacter(
    draft: CharacterDraft | { requestId: string; template: CharacterTemplate },
  ) {
    if (active.current) throw new ApiError("busy");
    active.current = true;
    setCharacterBusy(true);
    try {
      const next = await api<LabSnapshot>(
        "template" in draft ? "characters/import" : "characters",
        {
          method: "POST",
          body: draft,
        },
      );
      // The successful creation response is sufficient; do not turn a catalog refresh failure into a failed creation.
      setCharacters((old) => [
        ...old.filter((c) => c.characterId !== next.character.characterId),
        {
          characterId: next.character.characterId,
          name: next.character.profile.name,
          description: next.character.profile.description,
        },
      ]);
      selectedCharacter.current = next.character.characterId;
      selectedMemory.current = next.character.characterId;
      setSnapshot(next);
      setDraft(readDraft(next.character.characterId, auth.userId));
      retry.current = null;
      setOperationError(null);
    } finally {
      active.current = false;
      setCharacterBusy(false);
    }
  }

  async function reload() {
    setLoading(true);
    try {
      await refresh();
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setLoading(false);
    }
  }

  return (
    <SidebarProvider>
      <AppSidebar section={section} onNavigate={navigate} />
      <SidebarInset className="ifsoul-app-inset">
        <header className="app-topbar">
          <SidebarTrigger className="touch-target" />
          <Separator orientation="vertical" className="h-5" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>{SECTION_LABELS[section]}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="app-topbar-actions">
            <Badge variant="outline">
              {auth.config.mode === "local" ? "Local runtime" : "Cloud runtime"}
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              onClick={toggleTheme}
            >
              {theme === "dark" ? <Sun /> : <Moon />}
            </Button>
          </div>
        </header>
        <div className="app-page">
          <div className="app-page-heading">
            <div>
              <div className="eyebrow">IFSOUL APP</div>
              <h1>{SECTION_LABELS[section]}</h1>
              <p>
                {section === "chat"
                  ? "One character. A conversation that continues."
                  : section === "characters"
                    ? "Create a character, then choose which history it carries."
                    : section === "memory"
                      ? "The events and conversations your character can recall."
                      : section === "settings"
                        ? "Choose where it runs and how it thinks."
                        : "Local synthetic host, plans and diagnostic evidence."}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => void reload()}
              disabled={loading || Boolean(pending)}
              aria-label="Refresh workspace"
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
              <span>Refresh</span>
            </Button>
          </div>
          {error && (
            <div className="feedback error" role="alert">
              {error}
            </div>
          )}
          {loading && !status ? (
            <div className="connection-state" role="status">
              <LoaderCircle className="animate-spin" />
              <p>Opening your characters and memory…</p>
            </div>
          ) : !status || !status.authenticated ? (
            <div className="feedback error" role="alert">
              <p>
                {error ??
                  "This session is unavailable. Refresh the page to reconnect."}
              </p>
              <Button variant="outline" onClick={() => void reload()}>
                Try again
              </Button>
            </div>
          ) : (
            <>
              <div className="character-bar app-character-bar">
                <div className="character-avatar" aria-hidden="true">
                  {(snapshot?.persona ?? snapshot?.character)?.profile.name
                    .split(" ")
                    .map((word) => word[0])
                    .slice(0, 2)
                    .join("") ?? "IF"}
                  <span />
                </div>
                <div>
                  <h2>
                    {(snapshot?.persona ?? snapshot?.character)?.profile.name ??
                      "Your character"}
                  </h2>
                  <p>
                    Memory:{" "}
                    {snapshot?.character.profile.name ?? "Not connected"}
                  </p>
                </div>
                <Button variant="ghost" onClick={() => navigate("characters")}>
                  Choose character
                  <ArrowRight size={14} />
                </Button>
              </div>
              {!selectedProvider?.available && section !== "settings" && (
                <div className="feedback notice" role="status">
                  <p>
                    {provider === "openai"
                      ? "Connect your OpenAI key in Settings to use this model."
                      : "Choose an available model connection in Settings."}
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => navigate("settings")}
                  >
                    Open Settings
                  </Button>
                </div>
              )}
              {operationError && (
                <div className="feedback error" role="alert">
                  <span>{operationError}</span>
                  <Button
                    variant="outline"
                    disabled={Boolean(pending)}
                    onClick={() =>
                      void run(
                        section === "laboratory" &&
                          retry.current?.fingerprint.includes(
                            '"operation":"plan"',
                          )
                          ? "plan"
                          : "chat",
                      )
                    }
                  >
                    Retry request
                  </Button>
                </div>
              )}
              {slow && (
                <div className="feedback notice" role="status">
                  <LoaderCircle className="animate-spin" />
                  Still waiting for the provider. The request is bounded to one
                  minute; your draft stays here.
                </div>
              )}
              <section
                hidden={section !== "characters"}
                aria-label="Character profiles"
                className="app-narrow-panel"
              >
                <Characters
                  characters={characters}
                  selected={
                    snapshot?.persona?.characterId ??
                    snapshot?.character.characterId ??
                    "character-lumen"
                  }
                  memorySelected={
                    snapshot?.character.characterId ?? "character-lumen"
                  }
                  onMemory={(id) =>
                    chooseCharacter(selectedCharacter.current, id)
                  }
                  provider={provider}
                  model={selectedModel}
                  canGenerate={ready && provider !== "scenario"}
                  busy={Boolean(pending) || characterBusy}
                  onSelect={chooseCharacter}
                  onCreate={createCharacter}
                />
              </section>
              <section
                hidden={section !== "settings"}
                aria-label="App settings"
                className="app-narrow-panel"
              >
                <Settings
                  status={status}
                  provider={provider}
                  model={selectedModel}
                  busy={Boolean(pending) || characterBusy}
                  onProvider={(value) => {
                    setProvider(value);
                    setModel("");
                    setOperationError(null);
                  }}
                  onModel={setModel}
                  onRefresh={refresh}
                />
              </section>
              <section
                hidden={section !== "chat"}
                aria-label="Character conversation"
              >
                <ChatPanel
                  snapshot={snapshot}
                  draft={draft}
                  setDraft={setDraft}
                  pending={pending}
                  ready={ready}
                  provider={selectedProvider?.label ?? "Provider"}
                  model={selectedModel}
                  onSend={() => void run("chat")}
                />
              </section>
              <section
                hidden={section !== "memory"}
                aria-label="Character memory"
              >
                <EvidencePanel
                  snapshot={snapshot}
                  disabled={Boolean(pending) || characterBusy}
                  onMemoryImported={async (id) => {
                    setCharacters(await api<CharacterSummary[]>("characters"));
                    await chooseCharacter(id, id);
                  }}
                />
              </section>
              {laboratoryAvailable && section === "laboratory" && (
                <section
                  className="app-laboratory"
                  aria-label="Local Laboratory"
                >
                  <div className="feedback notice">
                    <FlaskConical size={18} />
                    <p>
                      This local synthetic host is a development tool. Plans
                      remain proposals; it does not control a game or an NPC.
                    </p>
                  </div>
                  <PlanPanel
                    snapshot={snapshot}
                    pending={pending}
                    ready={ready}
                    onPlan={() => void run("plan")}
                  />
                  <EvidencePanel
                    snapshot={snapshot}
                    debug
                    disabled={Boolean(pending) || characterBusy}
                    onMemoryImported={async (id) => {
                      setCharacters(
                        await api<CharacterSummary[]>("characters"),
                      );
                      await chooseCharacter(id, id);
                    }}
                  />
                </section>
              )}
            </>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function App() {
  const auth = useRuntimeAuth();
  if (!auth.signedIn)
    return (
      <main className="app-sign-in">
        <a href="/" className="wordmark">
          <BrandMark size={36} />
          <span>IfSoul App</span>
        </a>
        <div className="app-sign-in-copy">
          <h1>Continue your character’s story.</h1>
          <p>Sign in to open your characters and memory.</p>
        </div>
        {auth.signInView}
        {auth.playgroundHref && (
          <a href={auth.playgroundHref}>Explore the free scenario playground</a>
        )}
      </main>
    );
  return <WorkspaceApp key={auth.userId} />;
}
