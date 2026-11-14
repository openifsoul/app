export const minecraftConnectors = {
  "minecraft-mineflayer": {
    label: "Mineflayer",
    loader: "Vanilla",
    version: "1.20.2",
    java: 17,
    upstream: "4.39.0",
  },
  "minecraft-citizens": {
    label: "Citizens",
    loader: "Paper",
    version: "1.21.4",
    java: 21,
    upstream: "2.0.37-b3763",
  },
  "minecraft-easy-npc": {
    label: "Easy NPC",
    loader: "NeoForge",
    version: "1.21.1",
    java: 21,
    upstream: "6.0.2",
  },
  "minecraft-minecolonies": {
    label: "MineColonies",
    loader: "NeoForge",
    version: "1.21.1",
    java: 21,
    upstream: "1.1.1403",
  },
  "minecraft-customnpcs": {
    label: "CustomNPCs-Unofficial",
    loader: "NeoForge",
    version: "1.21.1",
    java: 21,
    upstream: "1.21.1.20251230",
  },
} as const;

type ServerConnector = Exclude<
  keyof typeof minecraftConnectors,
  "minecraft-mineflayer"
>;

export interface MinecraftTarget {
  connector: ServerConnector;
  playerId: string;
  npcId: string;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const colonyCitizen =
  /^[a-z0-9_.-]+:[a-z0-9_/.-]+\/[1-9][0-9]{0,9}\/[1-9][0-9]{0,9}$/;

export function validMinecraftTarget(value: unknown): value is MinecraftTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (
    Object.keys(target).length === 3 &&
    typeof target.connector === "string" &&
    target.connector !== "minecraft-mineflayer" &&
    Object.hasOwn(minecraftConnectors, target.connector) &&
    typeof target.playerId === "string" &&
    uuid.test(target.playerId) &&
    typeof target.npcId === "string" &&
    target.npcId.length <= 128 &&
    (target.connector === "minecraft-minecolonies" ? colonyCitizen : uuid).test(
      target.npcId,
    )
  );
}

export function sameMinecraftTarget(a?: MinecraftTarget, b?: MinecraftTarget) {
  return (
    a?.connector === b?.connector &&
    a?.playerId === b?.playerId &&
    a?.npcId === b?.npcId
  );
}
