import { resolve } from "node:path";
import {
  LaboratoryError,
  runLaboratory,
  type LabOptions,
} from "./laboratory.js";

const HELP = `IfSoul local laboratory — deterministic synthetic scenario controller

Usage:
  pnpm lab demo [--db <path>] [--json] [--full]
  pnpm lab inspect [--db <path>] [--json] [--full]
  pnpm lab chat --message <text> [--db <path>] [--json] [--full]

Examples:
  pnpm lab demo --db .local/lab/ifsoul.sqlite
  pnpm lab inspect --json
  pnpm lab chat --message "What did you complete?" --json

Default database: .local/lab/ifsoul.sqlite (relative to the current directory).
Clock: fixed simulation at 2026-11-05T08:00:00.000Z; not wall-clock time.
Demo resumes a completed saved run without repeating host work or erasing data.
Inspect lists bounded memory metadata; --full explicitly includes synthetic payloads.
The local host supplies trusted mappings. No model API, keys, network or game runs.
`;

function parse(args: string[]): {
  options?: LabOptions;
  json: boolean;
  help: boolean;
} {
  if (!args.length || args.includes("--help") || args.includes("-h"))
    return { json: args.includes("--json"), help: true };
  const [command, ...rest] = args;
  if (command !== "demo" && command !== "inspect" && command !== "chat")
    throw new LaboratoryError(
      "usage",
      "Unknown command. Use --help for available commands.",
    );
  let db = ".local/lab/ifsoul.sqlite";
  let message: string | undefined;
  let json = false;
  let full = false;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--json") json = true;
    else if (flag === "--full") full = true;
    else if (flag === "--db" || flag === "--message") {
      const value = rest[++i];
      if (!value || value.startsWith("--"))
        throw new LaboratoryError("usage", `Missing value for ${flag}.`);
      if (flag === "--db") db = value;
      else message = value;
    } else
      throw new LaboratoryError(
        "usage",
        "Unknown option. Use --help for available options.",
      );
  }
  if (command === "chat" && !message?.trim())
    throw new LaboratoryError("usage", "chat requires --message <text>.");
  if (message !== undefined && command !== "chat")
    throw new LaboratoryError("usage", "--message is supported only by chat.");
  return {
    options: {
      command,
      db: resolve(db),
      ...(message !== undefined ? { message } : {}),
      full,
    },
    json,
    help: false,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  try {
    const parsed = parse(args);
    if (parsed.help) {
      process.stdout.write(HELP);
      return;
    }
    const result = await runLaboratory(parsed.options!);
    if (parsed.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      const lines = [
        `IfSoul — ${result.controller}`,
        `Fixed simulation clock: ${result.clock.now}`,
        `Character: ${result.characterId}; database closed after this command.`,
        ...result.stages.map(
          (stage) => `${stage.stage}: ${JSON.stringify(stage)}`,
        ),
        `Memory listing (${result.memories.length} selected records):`,
        ...result.memories.map((memory) => `  ${JSON.stringify(memory)}`),
      ];
      if (result.response?.output.type === "utterance")
        lines.push(
          `Synthetic scenario reply (delivered to this transcript): ${result.response.output.content}`,
        );
      process.stdout.write(`${lines.join("\n")}\n`);
    }
  } catch (error) {
    const safe =
      error instanceof LaboratoryError
        ? { code: error.code, message: error.message }
        : {
            code: "laboratory-failed",
            message: "The local laboratory could not complete the command.",
          };
    const output = json
      ? JSON.stringify({ ok: false, error: safe })
      : `${safe.code}: ${safe.message}`;
    process.stderr.write(`${output}\n`);
    process.exitCode = safe.code === "usage" ? 2 : 1;
  }
}

await main();
