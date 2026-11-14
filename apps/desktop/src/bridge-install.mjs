import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const profiles = Object.freeze({
  "minecraft-citizens": [
    "plugins",
    "IfSoulCitizens.jar",
    "cc4423a1381202c126d6ddab15b2ef52e4e3c318cbe545245e05d7e03f38c2b8",
  ],
  "minecraft-easy-npc": [
    "mods",
    "ifsoul-easy-npc.jar",
    "918843482b5462cbd3686aa09d902a8cd95ae28abe202e64218eabe74b41159b",
  ],
  "minecraft-minecolonies": [
    "mods",
    "ifsoul-minecolonies.jar",
    "1d7b22d692ad2bc2d19ff7fd203c50e220880ee4a5167a80ccf0ae897d03880f",
  ],
  "minecraft-customnpcs": [
    "mods",
    "ifsoul-customnpcs.jar",
    "fe12ca6ae8b871c5f094bd9721d37d35cb72f9030bd7971f3953fb50ee450478",
  ],
});

export function bridgeInstallProfile(id) {
  return typeof id === "string" && Object.hasOwn(profiles, id)
    ? profiles[id]
    : undefined;
}

export async function installLocalBridge(id, archive, serverDirectory) {
  const profile = bridgeInstallProfile(id);
  if (!profile) throw Error("Unknown bridge");
  const [directory, filename, digest] = profile;
  const source = await lstat(archive);
  if (!source.isFile() || source.size > 1024 * 1024)
    throw Error("Invalid bridge file");
  const bytes = await readFile(archive);
  if (
    bytes.length !== source.size ||
    createHash("sha256").update(bytes).digest("hex") !== digest
  )
    throw Error("Bridge checksum mismatch");

  const root = await realpath(serverDirectory);
  const destination = resolve(root, directory);
  const marker = await lstat(join(root, "server.properties"));
  if (
    !marker.isFile() ||
    (await realpath(destination)) !== destination ||
    !(await lstat(destination)).isDirectory()
  )
    throw Error("Choose a prepared Minecraft server");
  const target = join(destination, filename);
  const staging = await mkdtemp(join(destination, ".ifsoul-install-"));
  try {
    const staged = join(staging, filename);
    await writeFile(staged, bytes, { mode: 0o644, flag: "wx" });
    // Hard-link publication is atomic and fails if the final filename exists.
    await link(staged, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return filename;
}
