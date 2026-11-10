import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
  type ComponentType,
} from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button";
import { BrandMark } from "../components/BrandMark";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { setAPITokenProvider } from "./api";

export interface RuntimeConfig {
  mode: "local" | "cloud";
  placement?: "local" | "selfhost" | "managed";
  publicOrigin?: string;
  auth: string;
  laboratory: boolean;
  requestTimeoutMs?: number;
}
export interface RuntimeAuth {
  config: RuntimeConfig;
  signedIn: boolean;
  userId: string;
  userName: string;
  /** Avatar supplied by the authenticated composing host, when available. */
  userImageUrl?: string;
  signIn(): void;
  signOut(): Promise<void>;
  signInView?: ReactNode;
  accountView?: ReactNode;
  /** Optional navigation owned by the composing host. */
  playgroundHref?: string;
}
export const RuntimeAuthContext = createContext<RuntimeAuth | null>(null);
export function useRuntimeAuth() {
  const value = useContext(RuntimeAuthContext);
  if (!value) throw new Error("Runtime authentication is unavailable");
  return value;
}
export function ConnectionScreen({
  title,
  children,
  retry,
  pending = false,
}: {
  title: string;
  children?: ReactNode;
  retry?: () => void;
  pending?: boolean;
}) {
  return (
    <main className="connection-state">
      <a href="/" className="wordmark">
        <BrandMark size={38} />
        <span>IfSoul</span>
      </a>
      {pending && <LoaderCircle className="animate-spin" aria-hidden="true" />}
      <h1>{title}</h1>
      <div role={pending ? "status" : "alert"}>{children}</div>
      {retry && (
        <Button variant="outline" onClick={retry}>
          <RefreshCw />
          Try again
        </Button>
      )}
      <a href="/">Back to home</a>
    </main>
  );
}
function LocalAuth({
  config,
  children,
}: {
  config: RuntimeConfig;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const cleanup = setAPITokenProvider(null);
    setReady(true);
    return cleanup;
  }, []);
  return ready ? (
    <RuntimeAuthContext.Provider
      value={{
        config,
        signedIn: true,
        userId: "local",
        userName: "Local workspace",
        signIn() {},
        async signOut() {},
      }}
    >
      {children}
    </RuntimeAuthContext.Provider>
  ) : (
    <ConnectionScreen title="Opening your local workspace" pending />
  );
}
function PasswordAuth({
  config,
  children,
}: {
  config: RuntimeConfig;
  children: ReactNode;
}) {
  const [ready, setReady] = useState<boolean | null>(null),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => setAPITokenProvider(null), []);
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/api/status", {
      credentials: "same-origin",
      signal: abort.signal,
    })
      .then((r) => r.json())
      .then((value) => {
        if (!abort.signal.aborted) setReady(value.authenticated === true);
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setReady(false);
          setError(
            "The service did not respond. Check its address and try signing in again.",
          );
        }
      });
    return () => abort.abort();
  }, []);
  async function login(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw Error();
      setPassword("");
      setReady(true);
    } catch {
      setPassword("");
      setError(
        "Sign-in failed. Check the owner password or wait a minute before trying again.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (ready === null)
    return (
      <ConnectionScreen title="Opening your service" pending>
        <p>Checking the owner session.</p>
      </ConnectionScreen>
    );
  if (!ready)
    return (
      <ConnectionScreen title="Sign in to your service">
        <form onSubmit={login} className="grid gap-3">
          <Label htmlFor="service-owner-password">Owner password</Label>
          <Input
            id="service-owner-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            required
          />
          <p>
            Your service stores the memory. This sign-in does not create an
            IfSoul billing account.
          </p>
          {error && <p role="alert">{error}</p>}
          <Button type="submit" disabled={busy || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </ConnectionScreen>
    );
  async function logout() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/logout", {
        method: "POST",
        credentials: "same-origin",
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw Error();
      setReady(false);
    } catch {
      const message =
        "Sign-out could not be confirmed. Retry before leaving this browser.";
      setError(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <RuntimeAuthContext.Provider
      value={{
        config,
        signedIn: true,
        userId: "service-owner",
        userName: "Service owner",
        signIn() {
          setReady(false);
        },
        signOut: logout,
        accountView: (
          <div>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void logout().catch(() => {})}
            >
              {busy ? "Signing out…" : "Sign out"}
            </Button>
            {error && <p role="alert">{error}</p>}
          </div>
        ),
      }}
    >
      {children}
    </RuntimeAuthContext.Provider>
  );
}
export function RuntimeBootstrap({
  children,
  cloudAuth: CloudAuth,
}: {
  children: ReactNode;
  cloudAuth?: ComponentType<{ config: RuntimeConfig; children: ReactNode }>;
}) {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void fetch("/api/config", {
      credentials: "same-origin",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
    })
      .then(async (response) => {
        if (!response.ok) throw Error("Configuration unavailable");
        const value: unknown = await response.json();
        if (!value || typeof value !== "object")
          throw Error("Invalid configuration");
        const next = value as RuntimeConfig;
        if (
          !(
            (next.mode === "local" &&
              ["local", "password"].includes(next.auth)) ||
            (next.mode === "cloud" &&
              typeof next.auth === "string" &&
              next.auth.length > 0)
          ) ||
          typeof next.laboratory !== "boolean" ||
          (next.requestTimeoutMs !== undefined &&
            (!Number.isSafeInteger(next.requestTimeoutMs) ||
              next.requestTimeoutMs < 1 ||
              next.requestTimeoutMs > 2147483647))
        )
          throw Error("Invalid configuration");
        if (!controller.signal.aborted) setConfig(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [attempt]);
  if (failed)
    return (
      <ConnectionScreen
        title="Could not open this runtime"
        retry={() => setAttempt((v) => v + 1)}
      >
        <p>
          Check that the local server is running or that this cloud runtime is
          reachable. Your saved work has not been changed.
        </p>
      </ConnectionScreen>
    );
  if (!config)
    return (
      <ConnectionScreen title="Opening IfSoul" pending>
        <p>Checking this runtime and its sign-in settings.</p>
      </ConnectionScreen>
    );
  if (config.publicOrigin && window.location.origin !== config.publicOrigin) {
    let target: string | undefined;
    try {
      const url = new URL(config.publicOrigin);
      if (
        url.origin === config.publicOrigin &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
      )
        target = url.origin;
    } catch {}
    return (
      <ConnectionScreen title="Open the configured service address">
        <p>
          Use the service's approved address before entering an owner password.
        </p>
        {target && <a href={target}>Open service</a>}
      </ConnectionScreen>
    );
  }
  if (config.auth === "password")
    return <PasswordAuth config={config}>{children}</PasswordAuth>;
  if (config.mode === "local")
    return <LocalAuth config={config}>{children}</LocalAuth>;
  if (!CloudAuth)
    return (
      <ConnectionScreen title="Cloud sign-in needs setup">
        <p>
          This runtime needs its host authentication adapter. Local IfSoul runs
          without an account.
        </p>
      </ConnectionScreen>
    );
  return <CloudAuth config={config}>{children}</CloudAuth>;
}
