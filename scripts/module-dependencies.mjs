// Reused public Core parser extraction; pinned Prettier supplies the parser.
import assert from "node:assert/strict";
import { parsers } from "prettier/plugins/typescript";
export async function dependencies(text, filename) {
  const ast = await parsers.typescript.parse(text, { filepath: filename });
  const result = [];
  function add(source, typeOnly = false) {
    assert(
      source?.type === "Literal" && typeof source.value === "string",
      `Computed module load in ${filename}`,
    );
    result.push({ specifier: source.value, typeOnly });
  }
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "ImportDeclaration")
      add(
        node.source,
        node.importKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every((s) => s.importKind === "type")),
      );
    if (
      ["ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) &&
      node.source
    )
      add(
        node.source,
        node.exportKind === "type" ||
          (node.specifiers?.length > 0 &&
            node.specifiers.every((s) => s.exportKind === "type")),
      );
    if (node.type === "ImportExpression") add(node.source);
    if (
      node.type === "TSImportEqualsDeclaration" &&
      node.moduleReference.type === "TSExternalModuleReference"
    )
      add(node.moduleReference.expression, node.importKind === "type");
    if (node.type === "TSImportType")
      add(node.argument?.literal ?? node.argument, true);
    if (
      node.type === "CallExpression" &&
      (node.callee.name === "require" ||
        (node.callee.type === "MemberExpression" &&
          node.callee.object.name === "module" &&
          node.callee.property.name === "require"))
    )
      add(node.arguments[0]);
    if (node.type === "Identifier" && ["eval", "Function"].includes(node.name))
      throw Error(`Dynamic code evaluation in ${filename}`);
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "range", "comments", "tokens"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  }
  walk(ast);
  return result;
}
