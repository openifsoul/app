/** Detect a leaked structured-output suffix, without repairing or censoring text.
 * Complete JSON literals remain valid conversation material. This is deliberately
 * narrower than a general JSON detector: only an uncontained closing string plus
 * task/reflection envelope fields at the end of prose is rejected. */
export function validDialogueContent(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 3000)
    return false;
  const tails = /"\s*,\s*"(?:tasks|memoryUpdates)"\s*:/gu;
  for (const match of value.matchAll(tails)) {
    const start = match.index;
    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(
        `{"content":""${value.slice(start + 1)}`,
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        continue;
      envelope = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      !Object.keys(envelope).every((key) =>
        ["content", "tasks", "memoryUpdates"].includes(key),
      )
    )
      continue;
    if (![envelope.tasks, envelope.memoryUpdates].some(Array.isArray)) continue;
    if (!insideJSONLiteral(value, start)) return false;
  }
  return true;
}
function insideJSONLiteral(text: string, position: number): boolean {
  for (let start = 0; start < position; start++) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const stack: string[] = [];
    let quoted = false,
      escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === "{" || char === "[") stack.push(char);
      if (char === "}" || char === "]") {
        if (stack.pop() !== (char === "}" ? "{" : "[")) break;
        if (!stack.length) {
          if (end >= position) {
            try {
              JSON.parse(text.slice(start, end + 1));
              return true;
            } catch {
              /* An unmatched prose brace does not protect a protocol tail. */
            }
          }
          break;
        }
      }
    }
  }
  return false;
}
