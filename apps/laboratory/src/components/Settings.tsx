import { desktopBridge } from "../lib/desktop";
import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Cloud,
  Cpu,
  KeyRound,
  LoaderCircle,
  Monitor,
  Server,
  Settings2,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  api,
  friendlyError,
  type LabStatus,
  type ProviderId,
} from "../lib/api";

export function Settings({
  status,
  provider,
  model,
  busy,
  onProvider,
  onModel,
  onRefresh,
}: {
  status: LabStatus;
  provider: ProviderId;
  model: string;
  busy: boolean;
  onProvider: (provider: ProviderId) => void;
  onModel: (model: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const currentPlacement =
    status.placement ?? (status.mode === "local" ? "local" : "managed");
  const [location, setLocation] = useState<"local" | "selfhost" | "managed">(
    currentPlacement,
  );
  const [selfhostOrigin, setSelfhostOrigin] = useState(
    currentPlacement === "selfhost" ? window.location.origin : "",
  );
  const [localOrigin, setLocalOrigin] = useState("http://127.0.0.1:8788");
  const [cloudOrigin, setCloudOrigin] = useState(
    status.mode === "cloud" ? window.location.origin : "",
  );
  const [locationError, setLocationError] = useState<string | null>(null);
  const selected = status.providers.find((item) => item.id === provider);
  const openai = status.providers.find((item) => item.id === "openai");
  const disabled = busy || saving;

  async function saveKey(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!key.trim() || disabled) return;
    setSaving(true);
    setFailure(null);
    setNotice(null);
    try {
      await api("credentials/openai", {
        method: "POST",
        body: { key: key.trim() },
      });
      setKey("");
      setNotice("Key encrypted and connected to this runtime.");
      try {
        await onRefresh();
      } catch {
        setNotice(
          "Key saved. Refresh the workspace to update provider availability.",
        );
      }
    } catch (reason) {
      setFailure(friendlyError(reason));
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (disabled) return;
    setSaving(true);
    setFailure(null);
    setNotice(null);
    try {
      await api("credentials/openai", { method: "DELETE" });
      setKey("");
      setConfirmDisconnect(false);
      setNotice("OpenAI key disconnected.");
      try {
        await onRefresh();
      } catch {
        setNotice("Key disconnected. Refresh to update provider availability.");
      }
    } catch (reason) {
      setFailure(friendlyError(reason));
    } finally {
      setSaving(false);
    }
  }

  async function navigate() {
    setLocationError(null);
    try {
      const url = new URL(
        location === "local"
          ? localOrigin
          : location === "selfhost"
            ? selfhostOrigin
            : cloudOrigin,
      );
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw new Error();
      if (
        location === "local" &&
        (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
      )
        throw new Error();
      if (location !== "local" && url.protocol !== "https:") throw new Error();
      const desktop = desktopBridge();
      if (desktop) {
        if (location === "local") return;
        await desktop.openService(url.origin);
      } else {
        window.location.assign(`${url.origin}/app`);
      }
    } catch {
      setLocationError(
        location === "local"
          ? "Use a local address such as http://127.0.0.1:8788 with no path or credentials."
          : "Enter the HTTPS address of the service, with no path or credentials.",
      );
    }
  }

  return (
    <>
      <Card className="settings-card">
        <CardHeader>
          <CardTitle>
            <Settings2 size={17} />
            Runtime and model
          </CardTitle>
        </CardHeader>
        <CardContent>
          <section className="settings-section">
            <div className="section-label">
              <Server size={14} /> RUNTIME LOCATION
            </div>
            <Label htmlFor="runtime-location">
              Run character and memory on
            </Label>
            <Select
              value={location}
              onValueChange={(value) => {
                setLocation(value as "local" | "selfhost" | "managed");
                setLocationError(null);
              }}
              disabled={disabled}
            >
              <SelectTrigger id="runtime-location" className="wide">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="managed">
                  <Cloud size={15} />
                  Managed service
                </SelectItem>
                <SelectItem value="selfhost">
                  <Server size={15} />
                  Self-hosted service
                </SelectItem>
                <SelectItem value="local">
                  <Monitor size={15} />
                  Local service · this computer
                </SelectItem>
              </SelectContent>
            </Select>
            <div className="runtime-caption flex-wrap">
              <span className="status-dot" />
              Memory stays on the current service
              {currentPlacement === "local"
                ? " on this computer"
                : currentPlacement === "selfhost"
                  ? " on your server"
                  : " in the managed service"}
              .<span className="break-all">{window.location.origin}</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Changing a model or payment method keeps this memory here. Opening
              another service selects its own store; nothing is automatically
              copied.
            </p>
            {(location === "selfhost" || location !== currentPlacement) && (
              <div className="runtime-switch">
                <Label htmlFor="runtime-address">
                  {location === "local"
                    ? "Local App address"
                    : location === "selfhost"
                      ? "Self-hosted App address"
                      : "Managed App address"}
                </Label>
                <Input
                  id="runtime-address"
                  type="url"
                  value={
                    location === "local"
                      ? localOrigin
                      : location === "selfhost"
                        ? selfhostOrigin
                        : cloudOrigin
                  }
                  placeholder={
                    location === "local"
                      ? "http://127.0.0.1:8788"
                      : "https://your-laboratory.example"
                  }
                  onChange={(event) => {
                    if (location === "local")
                      setLocalOrigin(event.target.value);
                    else if (location === "selfhost")
                      setSelfhostOrigin(event.target.value);
                    else setCloudOrigin(event.target.value);
                    setLocationError(null);
                  }}
                  aria-describedby="runtime-switch-note"
                />
                <p id="runtime-switch-note">
                  Opens the other runtime. Each runtime has its own memory
                  store; nothing is automatically copied.
                </p>
                {locationError && (
                  <p className="field-error" role="alert">
                    {locationError}
                  </p>
                )}
                <Button
                  variant="outline"
                  className="wide"
                  onClick={navigate}
                  disabled={disabled}
                >
                  Open{" "}
                  {location === "local"
                    ? "local"
                    : location === "selfhost"
                      ? "self-hosted"
                      : "managed"}{" "}
                  service
                  <ArrowUpRight />
                </Button>
              </div>
            )}
          </section>
          <section className="settings-section">
            <div className="section-label">
              <Cpu size={14} /> MODEL CONNECTION
            </div>
            <Label htmlFor="model-provider">Provider</Label>
            <Select
              value={provider}
              onValueChange={(value) => onProvider(value as ProviderId)}
              disabled={disabled}
            >
              <SelectTrigger id="model-provider" className="wide">
                <SelectValue placeholder="Choose a provider" />
              </SelectTrigger>
              <SelectContent>
                {status.providers.map((item) => (
                  <SelectItem
                    key={item.id}
                    value={item.id}
                    disabled={status.mode === "cloud" && item.id === "ollama"}
                  >
                    {item.label}
                    {!item.available ? " · not connected" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Label htmlFor="model-selection">Model</Label>
            <Select
              value={model}
              onValueChange={onModel}
              disabled={disabled || !selected?.models.length}
            >
              <SelectTrigger id="model-selection" className="wide">
                <SelectValue placeholder="Connect a provider first" />
              </SelectTrigger>
              <SelectContent>
                {selected?.models.map((item) => (
                  <SelectItem
                    key={item.id}
                    value={item.id}
                    disabled={status.mode === "cloud" && item.id === "ollama"}
                  >
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="provider-note">
              {provider === "scenario" ? (
                <>
                  <SparkleMark />
                  Synthetic controller. Deterministic scenario, with no model
                  request.
                </>
              ) : provider === "ollama" ? (
                <>
                  <Monitor size={14} />
                  {status.mode === "cloud"
                    ? "Ollama needs a local runtime on your computer. Open it above to use local models."
                    : (selected?.reason ??
                      "Models are served by Ollama on this computer. The runtime stays separate from the model.")}
                </>
              ) : provider === "openai" ? (
                <>
                  <ShieldCheck size={14} />
                  Uses your key for requests to OpenAI. Character memory stays
                  on this runtime.
                </>
              ) : (
                <>
                  <Cloud size={14} />
                  Inference uses this runtime's Cloudflare connection. Character
                  memory stays here.
                </>
              )}
            </div>
          </section>
          <section className="settings-section key-section">
            <div className="key-heading">
              <div className="section-label">
                <KeyRound size={14} /> OPENAI KEY
              </div>
              <Badge
                variant="outline"
                className={openai?.available ? "connected-badge" : ""}
              >
                {openai?.available ? "Connected" : "Not connected"}
              </Badge>
            </div>
            <form onSubmit={(event) => void saveKey(event)}>
              <Label htmlFor="openai-key">
                {openai?.available ? "Replace key" : "Connect your key"}
              </Label>
              <Input
                id="openai-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(event) => {
                  setKey(event.target.value);
                  setFailure(null);
                  setNotice(null);
                }}
                placeholder="Paste an OpenAI API key"
                disabled={disabled}
                aria-describedby="key-note"
              />
              <p id="key-note">
                Write-only. Never shown back or saved in browser storage.
              </p>
              {failure && (
                <p className="field-error" role="alert">
                  {failure}
                </p>
              )}
              {notice && (
                <p className="field-success" role="status">
                  <Check size={13} />
                  {notice}
                </p>
              )}
              <Button
                type="submit"
                variant="secondary"
                className="wide"
                disabled={!key.trim() || disabled}
              >
                {saving ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <KeyRound />
                )}
                {saving
                  ? "Updating connection…"
                  : openai?.available
                    ? "Replace key"
                    : "Connect key"}
              </Button>
            </form>
            {openai?.available &&
              (confirmDisconnect ? (
                <div className="disconnect-confirm">
                  <p>Disconnect this session's OpenAI key?</p>
                  <div>
                    <Button
                      variant="outline"
                      disabled={disabled}
                      onClick={() => setConfirmDisconnect(false)}
                    >
                      Keep key
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={disabled}
                      onClick={() => void disconnect()}
                    >
                      Disconnect
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  className="wide disconnect-button"
                  disabled={disabled}
                  onClick={() => setConfirmDisconnect(true)}
                >
                  <Unplug size={14} />
                  Disconnect key
                </Button>
              ))}
          </section>
          <div className="settings-footnote">
            <ShieldCheck size={14} />
            <span>
              Memory location, model provider and provider payment are
              independent.
            </span>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function SparkleMark() {
  return <ChevronDown size={14} className="scenario-mark" />;
}
