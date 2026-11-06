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
import { setAPITokenProvider } from "./api";

export interface RuntimeConfig {
  mode: "local" | "cloud";
  auth: string;
  laboratory: boolean;
}
export interface RuntimeAuth {
  config: RuntimeConfig;
  signedIn: boolean;
  userId: string;
  userName: string;
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
            (next.mode === "local" && next.auth === "local") ||
            (next.mode === "cloud" &&
              typeof next.auth === "string" &&
              next.auth.length > 0)
          ) ||
          typeof next.laboratory !== "boolean"
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
