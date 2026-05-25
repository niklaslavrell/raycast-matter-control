import { environment } from "@raycast/api";
import { spawn } from "node:child_process";
import { join } from "node:path";

// eslint-disable-next-line no-control-regex
export const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

export const ERROR_CLASS_RE =
  /^(?:Caused by:\s*)?(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|ImplementationError|MatterError|\w+Error):/;

// Skip Node deprecation/experimental warnings, raw stack-trace prefixes
// (file:///..., node:internal/...:NNN, "    at ..."), and blank lines when
// extracting the real error from the CLI's stderr.
export function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^\(node:\d+\)/.test(trimmed) ||
    /^\(Use `node --/.test(trimmed) ||
    /^node:internal\//.test(trimmed) ||
    /^file:\/\//.test(trimmed) ||
    /^\s*at\s/.test(trimmed) ||
    /^\s*\^/.test(trimmed) ||
    trimmed === ""
  );
}

export function extractRealError(stderr: string, exitCode: number | null): string {
  const lines = stderr.replace(ANSI_RE, "").trim().split("\n");
  const named = lines.find((line) => ERROR_CLASS_RE.test(line.trim()));
  if (named) return named.trim();
  const real = lines.find((line) => !isNoiseLine(line));
  return real?.trim() ?? `matter-cli exited with code ${exitCode}`;
}

export function cliPath(): string {
  return join(environment.assetsPath, "matter-cli.mjs");
}

export function storagePath(): string {
  return join(environment.supportPath, "matter-storage");
}

// NODE_NO_WARNINGS keeps Node's ExperimentalWarning/DeprecationWarning off the
// child's stderr — leaves stderr clean for our error parser.
export function cliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    MATTER_STORAGE_PATH: storagePath(),
  };
}

// Run a one-shot CLI subcommand and parse its stdout as JSON. Long-lived
// session-mode interactions use MatterSession directly instead.
export function runCli<T>(subcommand: string, args: string[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath(), subcommand, ...args], {
      env: cliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(extractRealError(stderr, exitCode)));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch (err) {
        reject(new Error(`could not parse CLI output: ${(err as Error).message}`));
      }
    });
  });
}

// Like runCli but discards stdout — for commands whose success is signalled
// only by a zero exit code (e.g. decommission).
export function runCliVoid(subcommand: string, args: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath(), subcommand, ...args], {
      env: cliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(extractRealError(stderr, exitCode)));
    });
  });
}
