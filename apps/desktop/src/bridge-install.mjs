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
    "7fe0510c7f8d211fe33d3764cf016fe22c79f1fc717b8873d0d82c90154203b4",
  ],
  "minecraft-easy-npc": [
    "mods",
    "ifsoul-easy-npc.jar",
    "7eb8dd7845f2315bf1cc59bed8b263ff74e6f574a56c115a20914f31f444cb10",
  ],
  "minecraft-minecolonies": [
    "mods",
    "ifsoul-minecolonies.jar",
    "a0cf837c961bc8c31cf04ff7b591c1dd9e0217c5aa6415f23afadfd328608ae0",
  ],
  "minecraft-customnpcs": [
    "mods",
    "ifsoul-customnpcs.jar",
    "e60055308d06b5199b56b2be7fa09ee699be5b60ba8f461071a33f866d432429",
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
