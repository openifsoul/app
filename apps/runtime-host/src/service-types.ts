import type {
  CharacterInstance,
  ConversationDelivery,
  ConversationResponse,
  MemoryEvent,
  PlanDecision,
  PlanProposal,
  TaskReport,
} from "@ifsoul/core/protocol";
import type { MemoryPort, Result } from "@ifsoul/core/memory/port";
import type { inspectBridgeMemory } from "./bridge-memory.js";
import type { AgentController } from "@ifsoul/core/runtime";
import type {
  ModelClient,
  ProviderSelection,
} from "@ifsoul/core/model-providers/types";
export type {
  ProviderId,
  ProviderSelection,
} from "@ifsoul/core/model-providers/types";

export interface LabRunRequest extends ProviderSelection {
  characterId?: string;
  memoryCharacterId?: string;
  operation: "plan" | "chat";
  requestId: string;
  message?: string;
}
export interface LabStage {
  stage: string;
  operation?: string;
  requestId?: string;
  status?: string;
  memoryIds?: string[];
}
export type LabOperationResult =
  | {
      type: "plan";
      proposal: PlanProposal;
      decision: PlanDecision;
      reports: TaskReport[];
    }
  | {
      type: "chat";
      response: ConversationResponse;
      delivery: ConversationDelivery;
    }
  | { type: "failure"; error: { code: string; message: string } };
export interface LabRun {
  persona?: { characterId: string; name: string };
  requestId: string;
  operation: "plan" | "chat";
  provider: ProviderSelection["provider"];
  model: string;
  message?: string;
  startedAt: string;
  completedAt: string;
  status: "completed" | "failed";
  stages: LabStage[];
  selectedMemoryIds: string[];
  result: LabOperationResult;
}
export interface LabSnapshot {
  bridgeReflection?: ReturnType<typeof inspectBridgeMemory>["reflection"];
  persona?: CharacterInstance;
  character: CharacterInstance;
  memories: MemoryEvent[];
  runs: LabRun[];
}
export interface LabRunResponse extends LabSnapshot {
  run: LabRun;
  stages: LabStage[];
  result: LabOperationResult;
}
export interface LabServiceOptions {
  /** Neutral application conversation; synthetic planning remains a local-only host. */
  chatEnvironment?: "app";
  runtimeLimits?: Partial<import("@ifsoul/core/runtime").RuntimeLimits>;
  runtimeCeilings?: Partial<import("@ifsoul/core/runtime").RuntimeLimits>;
  character?: CharacterInstance;
  persona?: CharacterInstance;
  clientFor?: (selection: ProviderSelection) => Promise<ModelClient>;
  memory: MemoryPort;
  controllerFor: (selection: ProviderSelection) => AgentController;
  now?: () => Date;
}
export interface LabService {
  snapshot(): Result<LabSnapshot>;
  run(request: LabRunRequest): Promise<Result<LabRunResponse>>;
}

export interface CharacterDraft {
  requestId: string;
  name: string;
  description: string;
  speechStyle: string;
  biography: string;
}
export interface CharacterSummary {
  characterId: string;
  name: string;
  description: string;
}
export interface CharacterWorkspace extends LabService {
  exportMemory(
    memoryId: string,
  ): ReturnType<typeof import("./memory-archive.js").exportMemoryArchive>;
  previewMemory(
    archive: unknown,
  ): ReturnType<typeof import("./memory-archive.js").previewMemoryArchive>;
  importMemory(
    archive: unknown,
    expectedDigest: unknown,
  ): ReturnType<typeof import("./memory-archive.js").importMemoryArchive>;
  createExportableMemory(
    characterId: unknown,
    consent: unknown,
  ): ReturnType<typeof import("./memory-archive.js").createExportableMemory>;
  listCharacters(): Result<CharacterSummary[]>;
  createCharacter(draft: CharacterDraft): Result<LabSnapshot>;
  snapshot(
    characterId?: string,
    memoryCharacterId?: string,
  ): Result<LabSnapshot>;
  importCharacter(request: {
    requestId: string;
    template: unknown;
  }): Result<LabSnapshot>;
  exportCharacter(characterId: string): Result<CharacterTemplate>;
  generateCharacter(
    request: GenerationRequest,
  ): Promise<Result<CharacterTemplate>>;
}

/** Laboratory source type for the current and supported legacy template schemas. */
export interface CharacterTemplate {
  schemaVersion: "0.3.0" | "draft-0.2.0";
  kind: "character-template";
  templateId: string;
  revision: number;
  profile: CharacterInstance["profile"];
  authorship: { authors: string[]; license: string; source?: string };
  extensions?: Record<string, unknown>;
  requiredExtensions?: string[];
}
export interface GenerationRequest extends ProviderSelection {
  requestId: string;
  brief: string;
}
