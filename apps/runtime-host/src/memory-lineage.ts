import type { MemoryPort } from "@ifsoul/core/memory/port";
import { createHash } from "node:crypto";

export interface MemoryLineage {
  sourceMemoryId: string;
  archiveDigest: string;
  eventOrigins?: Record<string, string>;
  profiles: Record<string, string>;
  playerSubjectId: string;
}
export function memoryLineage(
  memory: MemoryPort,
  owner: string,
): MemoryLineage | undefined {
  const result = memory.getExchange(`memory-fork:${owner}`);
  if (!result.ok) throw Error("Memory lineage unavailable");
  return result.value?.result as MemoryLineage | undefined;
}
export function historicalCharacter(
  memory: MemoryPort,
  owner: string,
  character: string,
) {
  const profiles = memoryLineage(memory, owner)?.profiles;
  return profiles && Object.hasOwn(profiles, character)
    ? profiles[character]!
    : character;
}
export function historicalPlayer(memory: MemoryPort, owner: string) {
  return (
    memoryLineage(memory, owner)?.playerSubjectId ??
    `player:${createHash("sha256").update(JSON.stringify(owner)).digest("hex").slice(0, 20)}`
  );
}
