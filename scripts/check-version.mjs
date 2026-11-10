import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = async (name) =>
  JSON.parse(await readFile(new URL("../" + name, import.meta.url), "utf8"));
const release = await read("release.json");
const manifest = await read("package.json");
assert.equal(manifest.version, release.version);
assert.equal(release.version, "0.5.0");
for (const value of Object.values(release.current))
  assert(
    value === "0.4.0" || value.endsWith("/0.4.0"),
    "Compatible format family must remain unchanged",
  );
for (const [name, pin] of Object.entries({
  ...manifest.dependencies,
  ...manifest.devDependencies,
}))
  if (name.startsWith("@ifsoul/") && pin.startsWith("file:"))
    assert(
      pin.endsWith("-" + release.version + ".tgz"),
      name + " stale release pin",
    );
console.log(manifest.name + " release " + release.version + " aligned");

assert.deepEqual(
  Object.keys(release.current).sort(),
  [
    "protocol",
    "modelProvider",
    "bridge",
    "bridgeResourcePolicy",
    "appResourcePolicy",
    "appMemory",
  ].sort(),
);
assert.equal(
  Object.hasOwn(release, "legacy"),
  false,
  "Obsolete format allowlists must not return",
);
