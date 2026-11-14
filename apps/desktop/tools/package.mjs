import { packager } from "@electron/packager";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataFormat, updateProtocol } from "../src/update-feed.mjs";
import { desktopUpdateConfiguration } from "../src/update-install.mjs";

const appRoot = fileURLToPath(new URL("../../../", import.meta.url));
const desktop = join(appRoot, "apps/desktop");
const [
  platform = process.platform,
  arch = process.arch,
  destination = "dist/desktop",
] = process.argv.slice(2);
if (!["darwin", "win32"].includes(platform) || !["arm64", "x64"].includes(arch))
  throw Error("Choose darwin or win32 and arm64 or x64.");
const out = resolve(destination);
const work = await mkdtemp(join(tmpdir(), "ifsoul-desktop-"));
const staging = join(work, "app");
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error || result.status !== 0)
    throw result.error ?? Error(`${command} failed`);
};
try {
  const vendor = join(desktop, "vendor");
  const receipt = JSON.parse(
    await readFile(join(vendor, "minecraft-companion.json"), "utf8"),
  );
  const archive = join(vendor, "minecraft-companion.tgz");
  if (
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex") !== receipt.sha256
  )
    throw Error(
      "Minecraft companion archive checksum does not match its receipt.",
    );
  const source = JSON.parse(
    await readFile(join(appRoot, "package.json"), "utf8"),
  );
  const runtimeManifest = {
    name: "ifsoul-desktop",
    productName: "IfSoul",
    version: source.version,
    description: "IfSoul desktop application",
    license: source.license,
    type: "module",
    main: "main.mjs",
    dependencies: source.dependencies,
  };
  await cp(join(desktop, "src"), staging, { recursive: true });
  if (
    platform === "darwin" &&
    arch === "arm64" &&
    process.platform === "darwin"
  ) {
    run(
      "/usr/bin/clang",
      [
        "-arch",
        "arm64",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        join(desktop, "tools/swap.c"),
        "-o",
        join(staging, "ifsoul-swap"),
      ],
      staging,
    );
    await writeFile(
      join(staging, "update-compatibility.json"),
      JSON.stringify({
        protocol: updateProtocol,
        dataFormat,
        bridges: {
          "minecraft-mineflayer": {
            protocol: receipt.format,
            sha256: receipt.sha256,
          },
        },
      }),
    );
    // A release integrator may supply a public trust record from a local directory.
    const trustSource = process.env.IFSOUL_DESKTOP_UPDATE_TRUST_DIR;
    if (trustSource) {
      const trust = await desktopUpdateConfiguration(resolve(trustSource));
      if (!trust) throw Error("No Desktop update trust record was supplied.");
      await writeFile(
        join(staging, "update-trust.json"),
        JSON.stringify(trust),
      );
    }
  }
  for (const path of [
    "dist/server",
    "dist/web",
    "vendor",
    "LICENSE",
    "NOTICE",
    "LICENSES",
  ])
    await cp(join(appRoot, path), join(staging, path), { recursive: true });
  // Both lockfiles and all local dependency archives remain available to the
  // local packaging machine. The installed app only executes staged modules.
  await cp(join(appRoot, "pnpm-lock.yaml"), join(staging, "pnpm-lock.yaml"));
  runtimeManifest.devDependencies = source.devDependencies;
  await writeFile(
    join(staging, "package.json"),
    JSON.stringify(runtimeManifest, null, 2),
  );
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw Error("Run desktop packaging through pnpm build:desktop.");
  const bridge = join(staging, "bridge");
  await mkdir(bridge);
  run("tar", ["-xzf", archive, "-C", bridge], staging);
  await cp(
    join(vendor, "minecraft-companion.json"),
    join(bridge, "source-receipt.json"),
  );
  for (const cwd of [staging, bridge])
    run(
      process.execPath,
      [
        pnpm,
        "install",
        "--prod",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--node-linker=hoisted",
      ],
      cwd,
    );
  for (const cwd of [staging, bridge]) {
    await rm(join(cwd, "vendor"), { recursive: true });
    await rm(join(cwd, "pnpm-lock.yaml"));
    await rm(join(cwd, "node_modules/.pnpm"), { recursive: true, force: true });
  }
  delete runtimeManifest.devDependencies;
  await writeFile(
    join(staging, "package.json"),
    JSON.stringify(runtimeManifest, null, 2),
  );
  const bundles = await packager({
    dir: staging,
    tmpdir: join(work, "packager"),
    out,
    name: "IfSoul",
    icon: join(desktop, "src/icons/IfSoul"),
    executableName: "IfSoul",
    appBundleId: "org.openifsoul.desktop",
    electronVersion: "45.3.1",
    platform,
    arch,
    ignore: (path) =>
      path.split("/").includes("node_modules") &&
      /^agents\.md$/i.test(basename(path)),
    asar: false,
    prune: false,
    overwrite: true,
    osxSign: false,
  });
  for (const bundle of bundles) {
    if (platform === "darwin" && process.platform === "darwin") {
      const macApp = join(bundle, "IfSoul.app");
      run(
        "/usr/bin/codesign",
        [
          "--sign",
          "-",
          "--force",
          "--deep",
          "--preserve-metadata=entitlements,requirements,flags,runtime",
          macApp,
        ],
        staging,
      );
      run(
        "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", macApp],
        staging,
      );
      run(
        "hdiutil",
        [
          "create",
          "-ov",
          "-fs",
          "HFS+",
          "-format",
          "UDZO",
          "-volname",
          "IfSoul",
          "-srcfolder",
          join(bundle, "IfSoul.app"),
          join(out, `IfSoul-macOS-${arch}.dmg`),
        ],
        staging,
      );
    }
    console.log(bundle);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
