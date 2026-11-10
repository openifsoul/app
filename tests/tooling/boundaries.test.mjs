import assert from "node:assert/strict";
import test from "node:test";
import { dependencies } from "../../scripts/module-dependencies.mjs";
import { hasPotentialSecret } from "../../scripts/secret-scan.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, "../..");
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(resolve(directory, entry.name))
      : [resolve(directory, entry.name)],
  );
}
async function checkImports(source, file) {
  for (const { specifier, typeOnly } of await dependencies(source, file)) {
    assert.doesNotMatch(specifier, /@clerk|ifsoul\/(cloud|website)/, file);
    if (specifier.startsWith(".") || specifier.startsWith("/"))
      assert.ok(
        !relative(root, resolve(file, "..", specifier)).startsWith(".."),
        file,
      );
    if (
      file.includes("/laboratory/src/") &&
      /runtime-host|server\/|@ifsoul\/core|node:/.test(specifier)
    )
      assert.ok(
        typeOnly,
        `Browser backend import must be type-only: ${file}: ${specifier}`,
      );
  }
}
test("parser rejects reexports, side effects, dynamic imports and require bypasses", async () => {
  const browserFile = resolve(root, "apps/laboratory/src/regression.ts");
  for (const code of [
    'export * from "../../runtime-host/src/service";',
    'import "../../server/src/api";',
    'const api = import("../../server/src/api");',
    'const api = require("../../server/src/api");',
    'export {App} from "@ifsoul/cloud";',
    'import "@clerk/react";',
    'await import("../../../../cloud/index.ts");',
    'const api = module.require("../../../../website/index.ts");',
  ])
    await assert.rejects(() => checkImports(code, browserFile));
  await checkImports(
    'export type {LabSnapshot} from "../../runtime-host/src/service-types";',
    browserFile,
  );
  await checkImports(
    'type Value = import("@ifsoul/core/protocol").CharacterInstance;',
    browserFile,
  );
});
test("secret guard retains vendor and generic credential detection", () => {
  for (const prefix of ["sk_live_", "sk_test_", "GOCSPX-", "Bearer "])
    assert.equal(hasPotentialSecret(prefix + "a".repeat(40)), true);
  assert.equal(hasPotentialSecret('apiKey: "' + "a".repeat(32) + '"'), true);
  assert.equal(
    hasPotentialSecret('apiKey: "synthetic-test-value-for-a-fixture"'),
    false,
  );
});
test("public App has no private/account package, sibling import or browser backend execution", async () => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  for (const [name, version] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })) {
    assert.doesNotMatch(name, /@clerk|ifsoul\/(cloud|website)/);
    if (typeof version === "string")
      assert.doesNotMatch(version, /^(?:file:|link:|workspace:).*\.\./);
  }
  for (const file of files(resolve(root, "apps")).filter((p) =>
    /\.tsx?$/.test(p),
  )) {
    const source = readFileSync(file, "utf8");
    assert.equal(
      hasPotentialSecret(source),
      false,
      `Potential secret in ${file}`,
    );
    await checkImports(source, file);
  }
});
for (const [label, stem, receiptFile] of [
  ["Core", "ifsoul-core-0.4.0", "core-receipt.json"],
  ["SDK", "ifsoul-adapter-sdk-0.4.0", "sdk-receipt.json"],
  ...["core", "sdk"].map((label) => {
    const receiptFile = `${label}-participants-receipt.json`;
    const receipt = JSON.parse(
      readFileSync(resolve(root, `vendor/${receiptFile}`), "utf8"),
    );
    return [
      `${label} participant source`,
      receipt.archive.replace(/\.tgz$/, ""),
      receiptFile,
    ];
  }),
]) {
  test(`pinned ${label} archive contains no local data, identity service, executable automation or secrets`, () => {
    const receipt = JSON.parse(
      readFileSync(resolve(root, `vendor/${receiptFile}`), "utf8"),
    );
    assert.equal(
      createHash("sha256")
        .update(readFileSync(resolve(root, `vendor/${stem}.tgz`)))
        .digest("hex"),
      receipt.sha256,
    );
    assert.match(receipt.commit ?? receipt.baseCommit, /^[a-f0-9]{40}$/);
    const members = execFileSync(
      "tar",
      ["-tzf", resolve(root, `vendor/${stem}.tgz`)],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    const content = execFileSync(
      "tar",
      ["-xOf", resolve(root, `vendor/${stem}.tgz`)],
      { encoding: "utf8", maxBuffer: 10_000_000 },
    );
    assert.equal(
      hasPotentialSecret(content),
      false,
      `Potential secret in ${label} distribution`,
    );
    assert.ok(members.includes("package/package.json"));
    for (const member of members)
      assert.doesNotMatch(
        member,
        /(?:^|\/)(?:\.env[^/]*|\.local|\.git|\.github|data|backups|cloud|website)(?:\/|$)|\.(?:sqlite|db|pem|key)(?:$|\/)/,
      );
  });
}
