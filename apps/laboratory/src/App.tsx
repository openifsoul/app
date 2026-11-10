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
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "./components/ui/breadcrumb";
import {
  WorkspaceBreadcrumbContext,
  type WorkspaceTrail,
} from "./lib/workspace-breadcrumbs";
import { useRuntimeAuth } from "./lib/runtime-auth";
import { BrandMark } from "./components/BrandMark";
import { Characters } from "./components/Characters";
import { Memories } from "./components/Memories";
import { Games } from "./components/Games";
import { BillingSettings } from "./components/BillingSettings";
import { Laboratory } from "./components/Laboratory";
import type {
  CharacterDraft,
  CharacterTemplate,
  CharacterSummary,
} from "../../runtime-host/src/service-types";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "./components/ui/button";
import { Label } from "./components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Settings } from "./components/Settings";
import { BehaviorSettings } from "./components/BehaviorSettings";
import { ChatPanel } from "./components/Workspace";
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

function ContextSelection({
  scope,
  characters,
  profileId,
  memoryId,
  busy,
  onSelect,
}: {
  scope: string;
  characters: CharacterSummary[];
  profileId: string;
  memoryId: string;
  busy: boolean;
  onSelect: (profileId: string, memoryId: string) => Promise<void>;
}) {
  const [error, setError] = useState("");
  async function select(profile: string, memory: string) {
    setError("");
    try {
      await onSelect(profile, memory);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  }
  return (
    <fieldset
      className="app-context-selection"
      disabled={busy}
      aria-label={`${scope} character and memory`}
    >
      <div>
        <Label htmlFor={`${scope}-profile`}>Character profile</Label>
        <Select
          value={profileId}
          disabled={busy}
          onValueChange={(id) => void select(id, memoryId)}
        >
          <SelectTrigger id={`${scope}-profile`}>
            <SelectValue placeholder="Choose a character" />
          </SelectTrigger>
          <SelectContent>
            {characters.map((character) => (
              <SelectItem
                key={character.characterId}
                value={character.characterId}
              >
                {character.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor={`${scope}-memory`}>Memory history</Label>
        <Select
          value={memoryId}
          disabled={busy}
          onValueChange={(id) => void select(profileId, id)}
        >
          <SelectTrigger id={`${scope}-memory`}>
            <SelectValue placeholder="Choose a memory" />
          </SelectTrigger>
          <SelectContent>
            {characters.map((character) => (
              <SelectItem
                key={character.characterId}
                value={character.characterId}
              >
                {character.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error && (
        <p className="app-context-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

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
  const [sectionTrails, setSectionTrails] = useState<
    Record<string, WorkspaceTrail>
  >({});
  const registerTrail = useCallback(
    (section: string, trail: WorkspaceTrail) => {
      setSectionTrails((previous) => ({ ...previous, [section]: trail }));
    },
    [],
  );
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
  const trail: WorkspaceTrail = sectionTrails[section] ?? { items: [] };
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
  useEffect(() => {
    document.title = `IfSoul · ${[SECTION_LABELS[section], ...trail.items.map((item) => item.label)].join(" · ")}`;
  }, [section, trail]);
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
          timeoutMs: auth.config.requestTimeoutMs,
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
        bridgeReflection: result.bridgeReflection,
        runs: result.runs,
      });
      if (result.result.type === "failure") {
        retry.current = null; // A recorded failure is resolved; the next explicit attempt gets a new ID.
        throw new ApiError(result.result.error.code);
      }
      retry.current = null;
      if (operation === "chat") setDraft("");
      return result;
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
    <WorkspaceBreadcrumbContext.Provider value={registerTrail}>
      <SidebarProvider className="app-workspace">
        <AppSidebar section={section} onNavigate={navigate} />
        <SidebarInset className="ifsoul-app-inset">
          <header className="app-topbar">
            <SidebarTrigger className="touch-target" />
            <Separator orientation="vertical" className="h-5" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  {trail.items.length ? (
                    <BreadcrumbLink
                      href={`/app/${section}`}
                      aria-disabled={trail.disabled || undefined}
                      onClick={(event) => {
                        event.preventDefault();
                        if (!trail.disabled) {
                          if (trail.onRoot) trail.onRoot();
                          else navigate(section);
                        }
                      }}
                    >
                      {SECTION_LABELS[section]}
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{SECTION_LABELS[section]}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
                {trail.items.map((item, index) => (
                  <Fragment key={`${index}-${item.label}`}>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      {item.onNavigate && index < trail.items.length - 1 ? (
                        <BreadcrumbLink
                          href={`/app/${section}`}
                          aria-disabled={trail.disabled || undefined}
                          onClick={(event) => {
                            event.preventDefault();
                            if (!trail.disabled) item.onNavigate?.();
                          }}
                          title={item.label}
                        >
                          {item.label}
                        </BreadcrumbLink>
                      ) : (
                        <BreadcrumbPage title={item.label}>
                          {item.label}
                        </BreadcrumbPage>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
            <div className="app-topbar-actions">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void reload()}
                disabled={loading || Boolean(pending)}
                aria-label="Refresh workspace"
                title="Refresh workspace"
              >
                <RefreshCw className={loading ? "animate-spin" : ""} />
              </Button>
            </div>
          </header>
          <div className="app-page">
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
                    Still waiting for the provider. The request is bounded to
                    one minute; your draft stays here.
                  </div>
                )}
                <section
                  hidden={section !== "characters"}
                  aria-label="Character profiles"
                >
                  <Characters
                    characters={characters}
                    profile={
                      (snapshot?.persona ?? snapshot?.character)?.profile
                    }
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
                  hidden={section !== "behavior"}
                  aria-label="Behavior configuration"
                >
                  <BehaviorSettings
                    active={section === "behavior"}
                    characterId={
                      snapshot?.persona?.characterId ??
                      snapshot?.character.characterId
                    }
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
                  hidden={section !== "balance"}
                  aria-label="Balance and billing"
                  className="app-narrow-panel"
                >
                  <BillingSettings />
                </section>
                <section hidden={section !== "games"} aria-label="Games">
                  <Games
                    providers={status.providers}
                    selectedProvider={provider}
                    selectedModel={selectedModel}
                  />
                </section>
                <section
                  hidden={section !== "chat"}
                  aria-label="Character conversation"
                >
                  <ContextSelection
                    scope="conversation"
                    characters={characters}
                    profileId={
                      snapshot?.persona?.characterId ??
                      snapshot?.character.characterId ??
                      "character-lumen"
                    }
                    memoryId={
                      snapshot?.character.characterId ?? "character-lumen"
                    }
                    busy={Boolean(pending) || characterBusy}
                    onSelect={chooseCharacter}
                  />
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
                  <Memories
                    characters={characters}
                    snapshot={snapshot}
                    busy={Boolean(pending) || characterBusy}
                    onSelect={chooseCharacter}
                    onImported={async (id) => {
                      setCharacters(
                        await api<CharacterSummary[]>("characters"),
                      );
                      await chooseCharacter(id, id);
                    }}
                  />
                </section>
                {laboratoryAvailable && section === "laboratory" && (
                  <section
                    className="app-laboratory"
                    aria-label="Local Laboratory"
                  >
                    <Laboratory
                      snapshot={snapshot}
                      characters={characters}
                      pending={Boolean(pending) || characterBusy}
                      running={pending === "plan"}
                      ready={ready}
                      provider={selectedProvider?.label ?? "Provider"}
                      model={selectedModel}
                      onSelect={chooseCharacter}
                      onRun={() => run("plan")}
                    />
                  </section>
                )}
              </>
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </WorkspaceBreadcrumbContext.Provider>
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
