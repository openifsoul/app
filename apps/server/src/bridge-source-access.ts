import { createHash } from "node:crypto";
import type { PrivateStore } from "./api.js";
import type { BridgeSourceAccess } from "../../runtime-host/src/bridge-memory.js";

type Restriction = { worldId: string; sourceId?: string };
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);

/** Local trusted service policy for historical browser report projection. */
export function createBridgeSourcePolicy(store: PrivateStore) {
  const key = (memoryId: string) => `bridge-source-policy-v1:${memoryId}`;
  const read = (memoryId: string): Restriction[] => {
    const raw = store.get(key(memoryId));
    const value: unknown = raw === undefined ? [] : JSON.parse(raw);
    if (
      !Array.isArray(value) ||
      value.length > 1000 ||
      value.some(
        (entry) =>
          !entry ||
          !validId(entry.worldId) ||
          (entry.sourceId !== undefined && !validId(entry.sourceId)),
      )
    )
      throw Error("Memory source policy is invalid.");
    return value;
  };
  return {
    snapshot(memoryId: string) {
      const entries = read(memoryId);
      const worldDeny = new Set(
        entries
          .filter((entry) => !entry.sourceId)
          .map((entry) => entry.worldId),
      );
      const sourceDeny = new Set(
        entries
          .filter((entry) => entry.sourceId)
          .map((entry) => JSON.stringify([entry.worldId, entry.sourceId])),
      );
      const serialized = JSON.stringify(entries);
      const allows: BridgeSourceAccess = (worldId, sourceId) =>
        validId(worldId) &&
        validId(sourceId) &&
        !worldDeny.has(worldId) &&
        !sourceDeny.has(JSON.stringify([worldId, sourceId]));
      return {
        allows,
        cursorKey: createHash("sha256").update(serialized).digest("hex"),
        validate() {
          if (JSON.stringify(read(memoryId)) !== serialized)
            throw Error("Memory source access changed.");
        },
      };
    },
    revoke(memoryId: string, worldId: string, sourceId?: string) {
      if (
        !validId(memoryId) ||
        !validId(worldId) ||
        (sourceId !== undefined && !validId(sourceId))
      )
        throw Error("Invalid memory source restriction.");
      const restrictions = read(memoryId);
      if (
        restrictions.some(
          (entry) =>
            entry.worldId === worldId &&
            (!entry.sourceId || entry.sourceId === sourceId),
        )
      )
        return;
      const next =
        sourceId === undefined
          ? restrictions.filter((entry) => entry.worldId !== worldId)
          : restrictions;
      if (next.length >= 1000)
        throw Error("Memory source policy limit reached.");
      store.set(
        key(memoryId),
        JSON.stringify([...next, { worldId, sourceId }]),
      );
    },
  };
}
