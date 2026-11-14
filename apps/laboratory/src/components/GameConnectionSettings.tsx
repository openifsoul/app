import { desktopBridge } from "../lib/desktop";
import { OptionSelect, SelectItem } from "./ui/select";
import { useEffect, useRef, useState } from "react";
import type { ProviderOption } from "../lib/api";
import { useRuntimeAuth } from "../lib/runtime-auth";
import {
  ArrowUpRight,
  Check,
  Copy,
  Gamepad2,
  LoaderCircle,
  Play,
  RefreshCw,
  Square,
  Unplug,
} from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  COMPANION_ORIGIN,
  CompanionRequestError,
  commandCompanion,
  configureCompanion,
  createGameConnection,
  gameConnectionError,
  pairCompanion,
  readCompanionStatus,
  readGameConnections,
  readOwnedCharacters,
  revokeGameConnection,
  type CharacterSummary,
  type CompanionStatus,
  type GameBinding,
  type GamePairRequest,
  type MinecraftConnection,
} from "../lib/game-connections-api";
const selectClass =
  "min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60";
const minecraftName = /^[A-Za-z0-9_]{3,16}$/;
const phaseLabels: Record<string, string> = {
  unconfigured: "Not configured",
  stopped: "Stopped",
  starting: "Starting",
  connecting: "Connecting",
  running: "Running",
  ready: "Ready for private dialogue",
  failed: "Needs attention",
  error: "Needs attention",
  "waiting-player": "Waiting for selected player",
  configured: "Configured",
  blocked: "Needs attention",
  "other-service": "Configured for another App",
  idle: "Stopped",
};
function phase(status: CompanionStatus) {
  if (status.requiresOwnerSwitch || status.phase === "other-owner")
    return "Configured for another account";
  return status.requiresServiceSwitch
    ? "Configured for another App"
    : status.connector?.ready
      ? "Ready for private dialogue"
      : (phaseLabels[status.phase] ??
        (status.running
          ? "Running — checking readiness"
          : "Check companion status"));
}
export function GameConnectionSettings({
  providers,
  selectedProvider,
  selectedModel,
}: {
  providers: ProviderOption[];
  selectedProvider: string;
  selectedModel: string;
}) {
  const auth = useRuntimeAuth();
  const [characters, setCharacters] = useState<CharacterSummary[]>([]),
    [connections, setConnections] = useState<GameBinding[]>([]),
    [loadingService, setLoadingService] = useState(true),
    [serviceFailure, setServiceFailure] = useState<string | null>(null),
    [serviceReady, setServiceReady] = useState(false);
  const [characterId, setCharacterId] = useState(""),
    [memoryId, setMemoryId] = useState(""),
    [provider, setProvider] = useState<GamePairRequest["provider"]>(
      selectedProvider as GamePairRequest["provider"],
    ),
    [model, setModel] = useState(selectedModel),
    [consent, setConsent] = useState(false);
  const [host, setHost] = useState("127.0.0.1"),
    [port, setPort] = useState("25565"),
    [botName, setBotName] = useState("IfSoulBot"),
    [playerName, setPlayerName] = useState(""),
    [trusted, setTrusted] = useState(false);
  const [pairCode, setPairCode] = useState(""),
    [pairing, setPairing] = useState(false),
    [controlExpires, setControlExpires] = useState(0),
    [companion, setCompanion] = useState<CompanionStatus | null>(null),
    [loadingStatus, setLoadingStatus] = useState(false),
    [companionFailure, setCompanionFailure] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [configuring, setConfiguring] = useState(false),
    [action, setAction] = useState<string | null>(null),
    [confirmClear, setConfirmClear] = useState(false),
    [revokeId, setRevokeId] = useState<string | null>(null),
    [revoking, setRevoking] = useState<string | null>(null);
  const ownerId = useRef(auth.userId);
  ownerId.current = auth.userId;
  const controlToken = useRef<string | null>(null),
    serviceController = useRef<AbortController | null>(null),
    localController = useRef<AbortController | null>(null),
    statusController = useRef<AbortController | null>(null),
    hydrated = useRef(false),
    statusInFlight = useRef(false);
  const activeProvider = providers.find(
      (p) => p.id === provider && p.available,
    ),
    availableProviders = providers.filter((p) => p.available),
    models = activeProvider?.models ?? [];
  const hasControl = Boolean(
      controlToken.current && controlExpires > Date.now(),
    ),
    otherOwner = Boolean(
      companion?.requiresOwnerSwitch || companion?.phase === "other-owner",
    ),
    otherService = Boolean(companion?.requiresServiceSwitch || otherOwner),
    localBusy = pairing || configuring || Boolean(action);
  const [serverFieldsTouched, setServerFieldsTouched] = useState({
    host: false,
    port: false,
  });
  const portNumber = Number(port);
  const validHost =
    host.trim().length > 0 &&
    host.trim().length <= 253 &&
    !/[\s\\/?#@]/.test(host);
  const validPort =
    /^\d{1,5}$/.test(port) &&
    Number.isInteger(portNumber) &&
    portNumber > 0 &&
    portNumber <= 65535;
  const serverValid =
    validHost &&
    validPort &&
    minecraftName.test(botName) &&
    minecraftName.test(playerName) &&
    botName !== playerName;
  const hostError = serverFieldsTouched.host && !validHost;
  const portError = serverFieldsTouched.port && !validPort;
  const formValid =
    serverValid &&
    trusted &&
    consent &&
    Boolean(characterId) &&
    Boolean(memoryId) &&
    Boolean(activeProvider) &&
    models.some((m) => m.id === model);
  useEffect(() => {
    if (!activeProvider) {
      const first = availableProviders[0];
      if (first) {
        setProvider(first.id);
        setModel(first.models[0]?.id ?? "");
      }
    } else if (!models.some((m) => m.id === model))
      setModel(models[0]?.id ?? "");
  }, [providers, provider, model]);
  async function loadService() {
    serviceController.current?.abort();
    const current = new AbortController();
    serviceController.current = current;
    setLoadingService(true);
    setServiceFailure(null);
    const [library, rows] = await Promise.allSettled([
      readOwnedCharacters(current.signal),
      readGameConnections(current.signal),
    ]);
    if (current.signal.aborted) return;
    if (library.status === "fulfilled") {
      setCharacters(library.value);
      setCharacterId((id) =>
        library.value.some((c) => c.characterId === id)
          ? id
          : (library.value[0]?.characterId ?? ""),
      );
      setMemoryId((id) =>
        library.value.some((c) => c.characterId === id)
          ? id
          : (library.value[0]?.characterId ?? ""),
      );
    }
    if (rows.status === "fulfilled") {
      setConnections(rows.value.connections);
      setServiceReady(true);
    } else setServiceReady(false);
    if (library.status === "rejected" || rows.status === "rejected")
      setServiceFailure(
        gameConnectionError(
          library.status === "rejected"
            ? library.reason
            : rows.status === "rejected"
              ? rows.reason
              : null,
        ),
      );
    setLoadingService(false);
  }
  function token() {
    if (!controlToken.current || controlExpires <= Date.now()) {
      controlToken.current = null;
      setControlExpires(0);
      throw new CompanionRequestError("expired");
    }
    return controlToken.current;
  }
  function adoptStatus(next: CompanionStatus) {
    setCompanion(next);
    if (
      next.config &&
      next.config.serviceEndpoint === window.location.origin &&
      !next.requiresServiceSwitch &&
      !next.requiresOwnerSwitch &&
      next.phase !== "other-owner" &&
      !hydrated.current
    ) {
      setHost(next.config.minecraft.host);
      setPort(String(next.config.minecraft.port));
      setBotName(next.config.minecraft.botName);
      setPlayerName(next.config.minecraft.playerName);
      setTrusted(true);
      setCharacterId(next.config.connection.characterId);
      setMemoryId(next.config.connection.memoryId);
      setProvider(next.config.connection.provider);
      setModel(next.config.connection.model);
      hydrated.current = true;
    }
  }
  function localFailure(error: unknown) {
    if (
      error instanceof CompanionRequestError &&
      ["expired", "unauthorized", "forbidden", "origin-not-approved"].includes(
        error.code,
      )
    ) {
      controlToken.current = null;
      setControlExpires(0);
      setCompanion(null);
    }
    setCompanionFailure(gameConnectionError(error, true));
  }
  function pauseStatusReads() {
    statusController.current?.abort();
    statusController.current = null;
    statusInFlight.current = false;
    setLoadingStatus(false);
  }
  async function refreshStatus() {
    if (!controlToken.current || statusInFlight.current) return;
    statusInFlight.current = true;
    statusController.current?.abort();
    const current = new AbortController();
    statusController.current = current;
    setLoadingStatus(true);
    try {
      const next = await readCompanionStatus(token(), current.signal);
      if (!current.signal.aborted) {
        adoptStatus(next);
        setCompanionFailure(null);
      }
    } catch (error) {
      if (!current.signal.aborted) localFailure(error);
    } finally {
      if (statusController.current === current) {
        setLoadingStatus(false);
        statusInFlight.current = false;
      }
    }
  }
  useEffect(() => {
    controlToken.current = null;
    hydrated.current = false;
    statusInFlight.current = false;
    setControlExpires(0);
    setCompanion(null);
    setPairCode("");
    setCharacters([]);
    setConnections([]);
    setCharacterId("");
    setMemoryId("");
    setConsent(false);
    setTrusted(false);
    setHost("127.0.0.1");
    setPort("25565");
    setBotName("IfSoulBot");
    setPlayerName("");
    setPairing(false);
    setLoadingStatus(false);
    setConfiguring(false);
    setAction(null);
    setConfirmClear(false);
    setRevokeId(null);
    setRevoking(null);
    setNotice(null);
    setCompanionFailure(null);
    void loadService();
    return () => {
      serviceController.current?.abort();
      localController.current?.abort();
      statusController.current?.abort();
      controlToken.current = null;
    };
  }, [auth.userId]);
  useEffect(() => {
    if (!controlExpires) return;
    const remaining = controlExpires - Date.now();
    const timer = setTimeout(
      () => {
        controlToken.current = null;
        setControlExpires(0);
        setCompanionFailure(
          desktopBridge()
            ? "The companion control session expired. Start and approve it again to manage your saved connection."
            : "The companion control session expired. Pair again on its local page; its saved game connection remains intact.",
        );
      },
      Math.max(0, Math.min(remaining, 2147483647)),
    );
    return () => clearTimeout(timer);
  }, [controlExpires]);
  useEffect(() => {
    if (!hasControl || !companion?.running || localBusy) return;
    const timer = setInterval(() => void refreshStatus(), 5000);
    return () => clearInterval(timer);
  }, [hasControl, companion?.running, localBusy]);
  async function pair() {
    const desktop = desktopBridge();
    if ((!desktop && !pairCode.trim()) || localBusy) return;
    pauseStatusReads();
    localController.current?.abort();
    const current = new AbortController();
    localController.current = current;
    setPairing(true);
    setCompanionFailure(null);
    setNotice(null);
    try {
      const approval = desktop ? await desktop.approveMinecraft() : undefined;
      if (approval && (!approval.ok || !approval.expiresAt)) {
        controlToken.current = null;
        setControlExpires(0);
        setCompanion(null);
        if (!current.signal.aborted)
          setCompanionFailure(
            "Companion approval did not complete. Try again, or close other apps using the companion port.",
          );
        return;
      }
      const grant = approval?.expiresAt
        ? { controlToken: "desktop", expiresAt: approval.expiresAt }
        : await pairCompanion(pairCode.trim(), current.signal);
      if (current.signal.aborted) return;
      controlToken.current = grant.controlToken;
      setControlExpires(grant.expiresAt);
      setPairCode("");
      const next = await readCompanionStatus(
        grant.controlToken,
        current.signal,
      );
      if (!current.signal.aborted) {
        adoptStatus(next);
        setNotice(
          "Companion paired with this App. Choose your server and connection settings below.",
        );
      }
    } catch (error) {
      if (!current.signal.aborted) localFailure(error);
    } finally {
      if (localController.current === current) setPairing(false);
    }
  }
  async function configure() {
    if (!hasControl || !formValid || !serviceReady || localBusy || otherService)
      return;
    localController.current?.abort();
    const current = new AbortController();
    localController.current = current;
    pauseStatusReads();
    setConfiguring(true);
    setServiceFailure(null);
    setCompanionFailure(null);
    setNotice(null);
    let created = false;
    try {
      const access = token();
      const saved = companion?.config;
      const reuseConnection =
        saved?.serviceEndpoint === window.location.origin &&
        !companion?.requiresServiceSwitch &&
        saved.connection.characterId === characterId &&
        saved.connection.memoryId === memoryId &&
        saved.minecraft.host === host.trim() &&
        saved.minecraft.port === portNumber &&
        saved.minecraft.version === "1.20.2" &&
        saved.minecraft.auth === "offline" &&
        saved.minecraft.botName === botName &&
        saved.minecraft.playerName === playerName;
      const grant = await createGameConnection(
        {
          characterId,
          memoryId,
          provider,
          model,
          consent: true,
          ...(reuseConnection
            ? { connectionId: saved.connection.connectionId }
            : {}),
        },
        current.signal,
      );
      created = true;
      const minecraft: MinecraftConnection = {
        host: host.trim(),
        port: portNumber,
        version: "1.20.2",
        auth: "offline",
        trustedServerApproved: true,
        botName,
        playerName,
      };
      await configureCompanion(access, grant.code, minecraft, current.signal);
      if (current.signal.aborted) return;
      hydrated.current = true;
      adoptStatus(await readCompanionStatus(access, current.signal));
      setNotice(
        "Connection saved by the companion. Start it when the Minecraft server and your player are ready.",
      );
      await loadService();
    } catch (error) {
      if (!current.signal.aborted) {
        if (created)
          setCompanionFailure(
            "The service connection was created, but companion confirmation is unavailable. Refresh status before retrying, or revoke the connection below.",
          );
        else setServiceFailure(gameConnectionError(error));
        if (created) await loadService();
      }
    } finally {
      if (localController.current === current) setConfiguring(false);
    }
  }
  async function command(command: "start" | "stop" | "reconnect" | "clear") {
    if (!hasControl || localBusy) return;
    localController.current?.abort();
    const current = new AbortController();
    localController.current = current;
    pauseStatusReads();
    setAction(command);
    setCompanionFailure(null);
    setNotice(null);
    try {
      const access = token();
      await commandCompanion(access, command, current.signal);
      if (current.signal.aborted) return;
      if (command === "clear") {
        setConfirmClear(false);
        hydrated.current = false;
        setConsent(false);
        setTrusted(false);
      }
      adoptStatus(await readCompanionStatus(access, current.signal));
      setNotice(
        command === "clear"
          ? "Local companion configuration cleared. Any old service connection can be revoked in its owning App."
          : command === "stop"
            ? "Companion stopped. Its saved connection and memory remain available."
            : "Command accepted. Check readiness below before sending a private whisper.",
      );
    } catch (error) {
      if (!current.signal.aborted) localFailure(error);
    } finally {
      if (localController.current === current) setAction(null);
    }
  }
  async function revoke(connection: GameBinding) {
    if (revoking) return;
    const owner = auth.userId;
    setRevoking(connection.connectionId);
    setServiceFailure(null);
    try {
      await revokeGameConnection(connection.connectionId);
      if (ownerId.current !== owner) return;
      setRevokeId(null);
      setNotice(
        "Service access revoked. This connection can no longer make authorized requests.",
      );
      if (
        hasControl &&
        companion?.config?.connection.connectionId === connection.connectionId
      ) {
        try {
          await commandCompanion(token(), "stop");
          await refreshStatus();
        } catch {
          setCompanionFailure(
            "Service access is revoked. Stop the companion on its local page if it is still running.",
          );
        }
      }
      await loadService();
    } catch (error) {
      if (ownerId.current === owner)
        setServiceFailure(gameConnectionError(error));
    } finally {
      if (ownerId.current === owner) setRevoking(null);
    }
  }
  async function copyOrigin() {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      setNotice(
        "App origin copied. Approve this exact address on the companion’s local page.",
      );
    } catch {
      setNotice(
        "Select and copy the App address below, then approve it on the companion’s local page.",
      );
    }
  }
  return (
    <Card className="mt-6" aria-label="Minecraft game connection">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gamepad2 className="size-4" />
          Minecraft connection
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Private dialogue for Minecraft Java 1.20.2 on a trusted offline-mode
          server. The game retains all movement, combat and mechanics.
        </p>
      </CardHeader>
      <CardContent className="grid gap-6">
        {notice && (
          <p role="status" className="feedback notice">
            {notice}
          </p>
        )}
        <section className="grid gap-4" aria-labelledby="game-companion-title">
          <h3 id="game-companion-title" className="font-medium">
            1. Pair the local companion
          </h3>
          {desktopBridge() ? (
            <p className="text-sm text-muted-foreground">
              Start the Minecraft companion included with IfSoul Desktop, then
              approve access in the desktop dialog.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Use the companion source supplied by your service owner, or get
                the bridge repository below. Run the installation commands once
                in a terminal on this computer, then keep the companion running.
              </p>
              <Button
                asChild
                variant="outline"
                className="min-h-11 justify-self-start"
              >
                <a
                  href="https://github.com/openifsoul/bridge-minecraft-mineflayer"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Get Mineflayer bridge source
                  <ArrowUpRight />
                </a>
              </Button>
              <p className="text-xs text-muted-foreground">
                Prerequisites: Node.js 22.18–24 and pnpm 10.15.0. If you
                received a prepared source folder, open that folder and run the
                last two commands.
              </p>
              <pre className="overflow-x-auto rounded-lg border p-3 text-xs">
                <code>
                  {
                    "git clone https://github.com/openifsoul/bridge-minecraft-mineflayer.git\ncd bridge-minecraft-mineflayer\npnpm install --frozen-lockfile\npnpm companion"
                  }
                </code>
              </pre>
              <p className="text-sm text-muted-foreground">
                Open the local consent page, enter and approve this exact App
                origin, then copy its one-use code here. The browser does not
                install the companion.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button asChild variant="outline" className="min-h-11">
                  <a
                    href={COMPANION_ORIGIN + "/"}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open companion consent page
                    <ArrowUpRight />
                  </a>
                </Button>
                <Button
                  variant="ghost"
                  className="min-h-11"
                  onClick={() => void copyOrigin()}
                >
                  <Copy />
                  Copy App origin
                </Button>
              </div>
              <code className="break-all rounded-md border p-3 text-xs">
                {window.location.origin}
              </code>
              <div className="grid gap-2">
                <Label htmlFor="game-companion-code">
                  Companion pairing code
                </Label>
                <Input
                  id="game-companion-code"
                  className="min-h-11"
                  value={pairCode}
                  maxLength={128}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setPairCode(e.target.value)}
                  disabled={localBusy}
                />
                <p className="text-xs text-muted-foreground">
                  Codes expire after five minutes and work once. Control access
                  stays in this tab only.
                </p>
              </div>
            </>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              className="min-h-11"
              disabled={(!desktopBridge() && !pairCode.trim()) || localBusy}
              onClick={() => void pair()}
            >
              {pairing ? <LoaderCircle className="animate-spin" /> : <Unplug />}
              {pairing
                ? "Pairing…"
                : desktopBridge()
                  ? "Start and approve companion"
                  : "Pair companion"}
            </Button>
            {hasControl && (
              <Badge variant="outline">
                <Check className="size-3" />
                Paired until {new Date(controlExpires).toLocaleTimeString()}
              </Badge>
            )}
          </div>
          {companionFailure && (
            <p role="alert" className="feedback error">
              {companionFailure}
            </p>
          )}
        </section>
        <section
          className="app-field-section grid gap-4"
          aria-labelledby="game-server-title"
        >
          <h3 id="game-server-title" className="font-medium">
            2. Choose the Minecraft server
          </h3>
          <div className="app-field-row grid gap-4 sm:grid-cols-[2fr_1fr]">
            <div className="app-form-field grid gap-2">
              <Label htmlFor="game-minecraft-host">Minecraft host *</Label>
              <Input
                id="game-minecraft-host"
                className="min-h-11"
                value={host}
                aria-invalid={hostError || undefined}
                aria-describedby="game-host-feedback"
                onBlur={() =>
                  setServerFieldsTouched((current) => ({
                    ...current,
                    host: true,
                  }))
                }
                maxLength={253}
                onChange={(e) => setHost(e.target.value)}
                disabled={localBusy}
              />
              <p
                id="game-host-feedback"
                className={
                  hostError
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {hostError
                  ? "Enter a host name or IP address without spaces, a URL or a port."
                  : "Use the Minecraft server address."}
              </p>
            </div>
            <div className="app-form-field grid gap-2">
              <Label htmlFor="game-minecraft-port">Minecraft port *</Label>
              <Input
                id="game-minecraft-port"
                className="min-h-11"
                value={port}
                aria-invalid={portError || undefined}
                aria-describedby={portError ? "game-port-error" : undefined}
                onBlur={() =>
                  setServerFieldsTouched((current) => ({
                    ...current,
                    port: true,
                  }))
                }
                maxLength={5}
                inputMode="numeric"
                onChange={(e) => setPort(e.target.value)}
                disabled={localBusy}
              />
              {portError && (
                <p id="game-port-error" className="text-xs text-destructive">
                  Enter a port from 1 to 65535.
                </p>
              )}
            </div>
          </div>
          <div className="app-field-row grid gap-4 sm:grid-cols-2">
            <div className="app-form-field grid gap-2">
              <Label htmlFor="game-bot-name">Bot name *</Label>
              <Input
                id="game-bot-name"
                className="min-h-11"
                value={botName}
                maxLength={16}
                onChange={(e) => setBotName(e.target.value)}
                disabled={localBusy}
              />
            </div>
            <div className="app-form-field grid gap-2">
              <Label htmlFor="game-player-name">Your player name *</Label>
              <Input
                id="game-player-name"
                className="min-h-11"
                value={playerName}
                maxLength={16}
                onChange={(e) => setPlayerName(e.target.value)}
                disabled={localBusy}
              />
            </div>
          </div>
          {Boolean(companion?.players?.length) && (
            <div className="grid gap-2">
              <Label htmlFor="game-live-player">
                Choose a connected player
              </Label>
              <OptionSelect
                id="game-live-player"
                className={selectClass}
                value={
                  companion!.players!.some((p) => p.name === playerName)
                    ? playerName
                    : ""
                }
                onValueChange={(value) => setPlayerName(value)}
                disabled={localBusy}
              >
                <SelectItem value="">Choose a live player</SelectItem>
                {companion!.players!.map((p) => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.name}
                  </SelectItem>
                ))}
              </OptionSelect>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Java 1.20.2 · offline authentication. Names use 3–16 letters, digits
            or underscores; bot and player names must differ.
          </p>
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input
              className="mt-1 size-5 shrink-0"
              type="checkbox"
              checked={trusted}
              onChange={(e) => setTrusted(e.target.checked)}
              disabled={localBusy}
            />
            I own or trust this offline-mode Minecraft server and approve the
            bot joining it.
          </label>
        </section>
        <section
          className="app-field-section grid gap-4"
          aria-labelledby="game-service-title"
        >
          <h3 id="game-service-title" className="font-medium">
            3. Choose the character, memory and model
          </h3>
          <p className="break-all text-sm">
            Current App service: <strong>{window.location.origin}</strong>
          </p>
          <p className="text-sm text-muted-foreground">
            To use another local, self-hosted or managed service, open its App
            first. This wizard uses the current service and does not copy
            memory.
          </p>
          {loadingService && (
            <p role="status" className="text-sm">
              Loading owned characters and service connections…
            </p>
          )}
          {serviceFailure && (
            <p role="alert" className="feedback error">
              {serviceFailure}
            </p>
          )}
          <Button
            variant="outline"
            className="min-h-11 justify-self-start"
            disabled={loadingService || configuring}
            onClick={() => void loadService()}
          >
            <RefreshCw className={loadingService ? "animate-spin" : ""} />
            Refresh service choices
          </Button>
          {!loadingService && characters.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Create an owned character in the Characters section before
              configuring the game connection.
            </p>
          )}
          <div className="app-field-row grid gap-4 sm:grid-cols-2">
            <div className="app-form-field grid gap-2">
              <Label htmlFor="game-character">Character profile *</Label>
              <OptionSelect
                id="game-character"
                className={selectClass}
                value={characterId}
                disabled={localBusy || !characters.length}
                onValueChange={(value) => setCharacterId(value)}
              >
                <SelectItem value="">Choose character</SelectItem>
                {characters.map((c) => (
                  <SelectItem key={c.characterId} value={c.characterId}>
                    {c.name}
                  </SelectItem>
                ))}
              </OptionSelect>
            </div>
            <div className="app-form-field grid gap-2">
              <Label htmlFor="game-memory">Owned memory *</Label>
              <OptionSelect
                id="game-memory"
                className={selectClass}
                value={memoryId}
                disabled={localBusy || !characters.length}
                onValueChange={(value) => setMemoryId(value)}
              >
                <SelectItem value="">Choose memory</SelectItem>
                {characters.map((c) => (
                  <SelectItem key={c.characterId} value={c.characterId}>
                    {c.name}
                  </SelectItem>
                ))}
              </OptionSelect>
            </div>
            <div className="app-form-field grid gap-2">
              <Label htmlFor="game-provider">Available provider *</Label>
              <OptionSelect
                id="game-provider"
                className={selectClass}
                value={provider}
                disabled={localBusy || !availableProviders.length}
                onValueChange={(value) => {
                  setProvider(value as GamePairRequest["provider"]);
                  setModel("");
                }}
              >
                {availableProviders.length === 0 && (
                  <SelectItem value="">No provider available</SelectItem>
                )}
                {availableProviders.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </OptionSelect>
            </div>
            <div className="app-form-field grid gap-2">
              <Label htmlFor="game-model">Model *</Label>
              <OptionSelect
                id="game-model"
                className={selectClass}
                value={model}
                disabled={localBusy || !models.length}
                onValueChange={(value) => setModel(value)}
              >
                {models.length === 0 && (
                  <SelectItem value="">No model available</SelectItem>
                )}
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </OptionSelect>
            </div>
          </div>
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input
              className="mt-1 size-5 shrink-0"
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              disabled={localBusy}
            />
            I approve private dialogue with the selected player using this
            character, memory and model. This does not grant game mechanics or
            public chat access.
          </label>
          {!serverValid && (
            <p className="text-sm text-muted-foreground">
              Check the server host, port and distinct Minecraft names before
              saving.
            </p>
          )}
          {!hasControl && (
            <p className="text-sm text-muted-foreground">
              Pair the companion above to save and manage a connection. Its
              persisted configuration survives an App reload.
            </p>
          )}
          {otherService && (
            <p role="alert" className="feedback notice">
              {otherOwner
                ? "The saved connection belongs to another account. Explicitly clear local configuration below before setting up this account."
                : "The companion is configured for another App. Open that App to revoke its connection, or explicitly clear local configuration below before setting up this service."}
            </p>
          )}
          <Button
            className="min-h-11 justify-self-start"
            disabled={
              !hasControl ||
              !formValid ||
              !serviceReady ||
              localBusy ||
              otherService
            }
            onClick={() => void configure()}
          >
            {configuring ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Check />
            )}
            {configuring
              ? "Saving connection…"
              : "Save connection in companion"}
          </Button>
        </section>
        <section className="grid gap-4" aria-labelledby="game-status-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="game-status-title" className="font-medium">
              4. Start and check readiness
            </h3>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={!hasControl || loadingStatus || localBusy}
              onClick={() => void refreshStatus()}
            >
              <RefreshCw className={loadingStatus ? "animate-spin" : ""} />
              Refresh companion status
            </Button>
          </div>
          {companion ? (
            <div className="grid gap-2 rounded-lg border p-4 text-sm">
              <strong>{phase(companion)}</strong>
              <span>
                {companion.running
                  ? "The local connector process is running."
                  : "The local connector is stopped."}
              </span>
              {companion.error && (
                <span className="text-muted-foreground">{companion.error}</span>
              )}
              {companion.config &&
                !otherService &&
                companion.config.serviceEndpoint === window.location.origin && (
                  <span className="break-words text-muted-foreground">
                    Saved server: {companion.config.minecraft.host}:
                    {companion.config.minecraft.port} · player{" "}
                    {companion.config.minecraft.playerName} · character{" "}
                    {companion.config.connection.character.name}
                  </span>
                )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Pair to inspect the companion. Starting is separate from saving
              configuration.
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              className="min-h-11"
              disabled={
                !hasControl ||
                !companion?.configured ||
                companion.running ||
                localBusy ||
                otherService
              }
              onClick={() => void command("start")}
            >
              <Play />
              {action === "start" ? "Starting…" : "Start companion"}
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={
                !hasControl ||
                !companion?.configured ||
                localBusy ||
                otherService
              }
              onClick={() => void command("reconnect")}
            >
              <RefreshCw />
              {action === "reconnect" ? "Reconnecting…" : "Reconnect"}
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={!hasControl || !companion?.configured || localBusy}
              onClick={() => void command("stop")}
            >
              <Square />
              {action === "stop" ? "Stopping…" : "Stop companion"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Use a private Minecraft whisper addressed to the bot. Reconnect
            preserves the saved identity and memory; an unconfirmed delivery is
            not replayed automatically.
          </p>
          {companion?.configured && (
            <>
              {confirmClear ? (
                <div className="grid gap-3 rounded-lg border p-4 text-sm">
                  <p>
                    Stop the local connector and remove its saved connection?
                    The companion will try to revoke service access. If it
                    cannot confirm this, revoke the old connection from its
                    owning App.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={localBusy}
                      onClick={() => setConfirmClear(false)}
                    >
                      Keep configuration
                    </Button>
                    <Button
                      variant="destructive"
                      className="min-h-11"
                      disabled={localBusy || !hasControl}
                      onClick={() => void command("clear")}
                    >
                      Clear local configuration
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  className="min-h-11 justify-self-start"
                  disabled={!hasControl || localBusy}
                  onClick={() => setConfirmClear(true)}
                >
                  Clear saved companion configuration
                </Button>
              )}
            </>
          )}
        </section>
        <section
          className="grid gap-4 border-t pt-5"
          aria-labelledby="game-access-title"
        >
          <h3 id="game-access-title" className="font-medium">
            Service connection access
          </h3>
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No game connections on this service yet. Saving configuration
              creates a one-use grant for the companion.
            </p>
          ) : (
            <ul className="grid gap-3">
              {connections.map((connection) => {
                const expired = connection.expiresAt <= Date.now();
                return (
                  <li
                    key={connection.connectionId}
                    className="grid gap-3 rounded-lg border p-4 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <strong>{connection.character.name}</strong>
                      <Badge variant="outline">
                        {connection.revoked
                          ? "Revoked"
                          : expired
                            ? "Expired"
                            : "Authorized"}
                      </Badge>
                    </div>
                    <p className="break-all text-xs text-muted-foreground">
                      {connection.provider} · {connection.model}
                      {connection.player
                        ? ` · player ${connection.player.name}`
                        : " · waiting for player readiness"}{" "}
                      · expires{" "}
                      {new Date(connection.expiresAt).toLocaleString()}
                    </p>
                    {!connection.revoked &&
                      !expired &&
                      (revokeId === connection.connectionId ? (
                        <div className="grid gap-3">
                          <p>
                            Revoke this connection’s service access?
                            Reconnecting afterward requires a new grant.
                          </p>
                          <div className="flex flex-wrap gap-3">
                            <Button
                              variant="outline"
                              className="min-h-11"
                              disabled={Boolean(revoking)}
                              onClick={() => setRevokeId(null)}
                            >
                              Keep access
                            </Button>
                            <Button
                              variant="destructive"
                              className="min-h-11"
                              disabled={Boolean(revoking)}
                              onClick={() => void revoke(connection)}
                            >
                              {revoking === connection.connectionId
                                ? "Revoking…"
                                : "Revoke service access"}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          className="min-h-11 justify-self-start"
                          disabled={Boolean(revoking)}
                          onClick={() => setRevokeId(connection.connectionId)}
                        >
                          Revoke connection
                        </Button>
                      ))}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
