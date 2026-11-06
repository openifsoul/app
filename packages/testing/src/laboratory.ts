import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Every child exits normally; timeouts are bounded and only address the owned child. */
export async function invokeLab(args: string[]) {
  try {
    const result = await execute(
      process.execPath,
      ["--import", "tsx", "apps/runtime-host/src/cli.ts", ...args],
      { cwd: root, timeout: 15_000, maxBuffer: 1_000_000 },
    );
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = error as {
      code?: unknown;
      stdout?: string;
      stderr?: string;
    };
    if (typeof result.code !== "number") throw error;
    return {
      exitCode: result.code,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
}

export async function withLabDirectory<T>(
  run: (directory: string, db: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ifsoul-lab-"));
  try {
    return await run(directory, join(directory, "memory.sqlite"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
