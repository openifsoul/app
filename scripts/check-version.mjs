import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = async (name) =>
  JSON.parse(await readFile(new URL("../" + name, import.meta.url), "utf8"));
const release = await read("release.json");
const manifest = await read("package.json");
assert.equal(manifest.version, release.version);
assert.equal(release.version, "0.3.0");
for (const value of Object.values(release.current))
  assert(value === release.version || value.endsWith("/" + release.version));
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
assert.deepEqual(release.legacy, {
  protocol: ["draft-0.1.0", "draft-0.2.0"],
  bridge: ["ifsoul-bridge/0.1"],
  appMemory: ["ifsoul-app-memory/0.1"],
});
