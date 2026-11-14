import {
  bridgeCapabilities,
  resolveBridgeLimits,
  type BridgeLimits,
} from "@ifsoul/adapter-sdk/bridge";
import { BUFFERED_JSON_MAX_BYTES, MAX_TIMER_MS } from "@ifsoul/core/protocol";
import { resolveProviderLimits } from "@ifsoul/core/model-providers";
import type {
  ProviderLimits,
  ProviderBudgetPolicy,
  ModelContextBudget,
} from "@ifsoul/core/model-providers/types";
import { resolveRuntimeLimits, type RuntimeLimits } from "@ifsoul/core/runtime";

export class AppResourceError extends Error {
  constructor(
    readonly code: "configuration" | "unsupported-policy" | "budget-exceeded",
    readonly layer: string,
    readonly field: string,
  ) {
    super(`${code}: ${layer}.${field}`);
  }
}
interface ContextConfiguration {
  windowTokens: number;
  modelMaxTokens?: number;
  source: "operator" | "provider";
  /** Explicit estimate, not a tokenizer or provider-reported usage. */
  estimate?: { bytesPerToken: number; overheadTokens: number };
}
export interface AppResourceConfiguration {
  http?: {
    bodyBytes?: number;
    archiveBytes?: number;
    profileBytes?: number;
    requestTimeoutMs?: number;
    headersTimeoutMs?: number;
  };
  bridge?: Partial<BridgeLimits>;
  ollama?: {
    promptBytes?: number;
    promptCeilingBytes?: number;
    generationTimeoutMs?: number;
    limits?: Partial<ProviderLimits>;
    ceilings?: Partial<ProviderLimits>;
    contexts?: Record<string, ContextConfiguration>;
    compactReflection?: boolean;
    reflectionSourceBytes?: number;
    reflectionSources?: number;
  };
  runtime?: {
    limits?: Partial<RuntimeLimits>;
    ceilings?: Partial<RuntimeLimits>;
  };
  browserTimeoutMs?: number;
}
/** A conservative Desktop operating window for the installed Qwen3 8B tag. */
export const desktopOllamaContexts = {
  "qwen3:8b": {
    windowTokens: 8192,
    source: "operator",
    estimate: { bytesPerToken: 1.5, overheadTokens: 128 },
  },
} satisfies Record<string, ContextConfiguration>;
const objectKeys = (value: unknown, allowed: string[], layer: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppResourceError("configuration", layer, "object-required");
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new AppResourceError("configuration", layer, key);
};
function integer(
  value: number,
  layer: string,
  field: string,
  maximum = BUFFERED_JSON_MAX_BYTES,
) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new AppResourceError("configuration", layer, field);
  if (value > maximum)
    throw new AppResourceError("unsupported-policy", layer, field);
  return value;
}
export function resolveAppResourcePolicy(
  configuration: AppResourceConfiguration = {},
) {
  objectKeys(
    configuration,
    ["http", "bridge", "ollama", "runtime", "browserTimeoutMs"],
    "app-policy",
  );
  if (configuration.http)
    objectKeys(
      configuration.http,
      [
        "bodyBytes",
        "archiveBytes",
        "profileBytes",
        "requestTimeoutMs",
        "headersTimeoutMs",
      ],
      "http-ingress",
    );
  if (configuration.ollama)
    objectKeys(
      configuration.ollama,
      [
        "promptBytes",
        "promptCeilingBytes",
        "generationTimeoutMs",
        "limits",
        "ceilings",
        "contexts",
        "compactReflection",
        "reflectionSourceBytes",
        "reflectionSources",
      ],
      "ollama-policy",
    );
  if (configuration.runtime)
    objectKeys(configuration.runtime, ["limits", "ceilings"], "runtime-policy");
  const http = {
    bodyBytes: 16384,
    archiveBytes: 2010000,
    profileBytes: 70000,
    requestTimeoutMs: 65000,
    headersTimeoutMs: 10000,
    ...configuration.http,
  };
  for (const [field, value] of Object.entries(http))
    integer(
      value,
      "http-ingress",
      field,
      field.endsWith("TimeoutMs") ? MAX_TIMER_MS : BUFFERED_JSON_MAX_BYTES,
    );
  if (http.headersTimeoutMs > http.requestTimeoutMs)
    throw new AppResourceError(
      "configuration",
      "http-ingress",
      "header-timeout-exceeds-request-timeout",
    );
  const runtime = resolveRuntimeLimits(
    {
      controllerTimeoutMs: 60000,
      maxMemoryRecords: 100,
      maxMemoryBytes: 150000,
      ...configuration.runtime?.limits,
    },
    configuration.runtime?.ceilings,
  );
  if (runtime.status !== "accepted")
    throw new AppResourceError(
      runtime.status === "unsupported" ? "unsupported-policy" : "configuration",
      "runtime",
      runtime.failure?.field ?? "limits",
    );
  const browserTimeoutMs = integer(
    configuration.browserTimeoutMs ?? 60000,
    "browser",
    "timeoutMs",
    MAX_TIMER_MS,
  );
  const bridge = resolveBridgeLimits({
    ...configuration.bridge,
    timeoutMs: configuration.bridge?.timeoutMs ?? browserTimeoutMs,
  }).effective;
  if (bridge.maxRequestBytes > http.bodyBytes)
    throw new AppResourceError(
      "configuration",
      "http-ingress",
      "bridge-request-exceeds-bodyBytes",
    );
  // Existing frozen Core conversation content is at most 4000 characters and
  // utterance content at most 2000. Resource policy cannot change schema bytes.
  if (
    bridge.maxContextChars > 4000 ||
    bridge.maxSpeechChars > 2000 ||
    bridge.maxHistorySummaryChars > 600 ||
    bridge.maxHistoryEntries > 128
  )
    throw new AppResourceError(
      "unsupported-policy",
      "core-contract",
      "bridge-field-size",
    );
  const promptBytes = integer(
    configuration.ollama?.promptBytes ?? 10000,
    "prompt-packing",
    "promptBytes",
  );
  const promptCeilingBytes = integer(
    configuration.ollama?.promptCeilingBytes ?? 21000,
    "prompt-packing",
    "promptCeilingBytes",
  );
  if (promptBytes > promptCeilingBytes)
    throw new AppResourceError(
      "budget-exceeded",
      "prompt-packing",
      "promptBytes",
    );
  const generationTimeoutMs = integer(
    configuration.ollama?.generationTimeoutMs ?? 50000,
    "controller",
    "generationTimeoutMs",
    MAX_TIMER_MS - 5000,
  );
  const provider = resolveProviderLimits(
    { timeoutMs: 55000, ...configuration.ollama?.limits },
    { ceilings: configuration.ollama?.ceilings },
  );
  if (provider.status !== "accepted")
    throw new AppResourceError(
      provider.status === "unsupported"
        ? "unsupported-policy"
        : "configuration",
      "provider",
      provider.failure?.field ?? "limits",
    );
  if (
    generationTimeoutMs > provider.effective.timeoutMs ||
    provider.effective.timeoutMs > runtime.effective.controllerTimeoutMs ||
    runtime.effective.controllerTimeoutMs > browserTimeoutMs
  )
    throw new AppResourceError(
      "configuration",
      "deadline-chain",
      "generation-provider-runtime-browser",
    );
  if (
    configuration.ollama?.compactReflection !== undefined &&
    typeof configuration.ollama.compactReflection !== "boolean"
  )
    throw new AppResourceError(
      "configuration",
      "reflection",
      "compactReflection",
    );
  const contexts: Record<string, ModelContextBudget> = {};
  for (const [model, context] of Object.entries(
    configuration.ollama?.contexts ?? {},
  )) {
    objectKeys(
      context,
      ["windowTokens", "modelMaxTokens", "source", "estimate"],
      "model-context",
    );
    integer(
      context.windowTokens,
      "model-context",
      "windowTokens",
      Number.MAX_SAFE_INTEGER,
    );
    if (context.modelMaxTokens !== undefined)
      integer(
        context.modelMaxTokens,
        "model-context",
        "modelMaxTokens",
        Number.MAX_SAFE_INTEGER,
      );
    if (!["operator", "provider"].includes(context.source))
      throw new AppResourceError("configuration", "model-context", "source");
    if (
      context.modelMaxTokens !== undefined &&
      context.windowTokens > context.modelMaxTokens
    )
      throw new AppResourceError(
        "unsupported-policy",
        "model-context",
        "windowTokens",
      );
    if (context.estimate) {
      objectKeys(
        context.estimate,
        ["bytesPerToken", "overheadTokens"],
        "token-estimate",
      );
      if (
        !Number.isFinite(context.estimate.bytesPerToken) ||
        context.estimate.bytesPerToken <= 0 ||
        !Number.isSafeInteger(context.estimate.overheadTokens) ||
        context.estimate.overheadTokens < 0
      )
        throw new AppResourceError("configuration", "token-estimate", "bounds");
    }
    contexts[model] = {
      windowTokens: context.windowTokens,
      modelMaxTokens: context.modelMaxTokens,
      source: context.source,
      ...(context.estimate
        ? {
            countInputTokens: (input) => ({
              tokens:
                Math.ceil(
                  Buffer.byteLength(
                    JSON.stringify({
                      system: input.system,
                      prompt: input.prompt,
                      schema: input.schema,
                    }),
                  ) / context.estimate!.bytesPerToken,
                ) + context.estimate!.overheadTokens,
              kind: "estimate" as const,
              method: `utf8-bytes/${context.estimate!.bytesPerToken}+${context.estimate!.overheadTokens}`,
            }),
          }
        : {}),
    };
  }
  const reflectionSourceBytes = integer(
    configuration.ollama?.reflectionSourceBytes ?? 6000,
    "reflection-input",
    "sourceBytes",
    900000,
  );
  const reflectionSources = integer(
    configuration.ollama?.reflectionSources ?? 24,
    "reflection-input",
    "sources",
    10000,
  );
  return {
    http,
    bridge,
    runtime,
    runtimeCeilings: configuration.runtime?.ceilings,
    retainedHistoryEntries: configuration.bridge?.maxHistoryEntries ?? 8,
    browserTimeoutMs,
    ollama: {
      promptBytes,
      promptCeilingBytes,
      generationTimeoutMs,
      provider,
      contexts,
      compactReflection: configuration.ollama?.compactReflection ?? false,
      reflectionSourceBytes,
      reflectionSources,
      budgetPolicy: {
        ceilings: configuration.ollama?.ceilings,
        contexts,
      } satisfies ProviderBudgetPolicy,
    },
    metadata: {
      version: "ifsoul-app-resource-policy/0.4.0",
      bridge: bridgeCapabilities(bridge),
      http: {
        ...http,
        bufferedMaxBytes: BUFFERED_JSON_MAX_BYTES,
        transport: "buffered-json",
        streamingLargeMessages: false,
      },
      model: {
        provider,
        promptBytes,
        promptCeilingBytes,
        compactReflection: configuration.ollama?.compactReflection ?? false,
        optionalReflectionOutputTokens: configuration.ollama?.compactReflection
          ? Math.min(768, provider.effective.maxOutputTokens)
          : provider.effective.maxOutputTokens,
        outputTokens: provider.effective.maxOutputTokens,
        generationTimeoutMs,
        providerTimeoutMs: provider.effective.timeoutMs,
        contexts: Object.fromEntries(
          Object.entries(configuration.ollama?.contexts ?? {}).map(
            ([model, c]) => [
              model,
              { ...c, accounting: c.estimate ? "estimate" : "unknown" },
            ],
          ),
        ),
        contextWhenUnlisted: "unknown",
        bytesAreTokens: false,
      },
      runtime,
      browserTimeoutMs,
      persistence: {
        bridgeBytes: 900000,
        reflectionBytes: 96000,
        relationshipCitations: 4,
        fullArchive: false,
      },
    },
  };
}
export type AppResourcePolicy = ReturnType<typeof resolveAppResourcePolicy>;
export function httpBodyBudget(
  policy: AppResourcePolicy | undefined,
  pathname: string,
  method: string,
) {
  if (
    method === "POST" &&
    ["/api/memory/preview", "/api/memory/import"].includes(pathname)
  )
    return policy?.http.archiveBytes ?? 2010000;
  if (
    pathname === "/api/characters/import" ||
    (pathname === "/api/behavior" && method === "PUT")
  )
    return policy?.http.profileBytes ?? 70000;
  return policy?.http.bodyBytes ?? 16384;
}
