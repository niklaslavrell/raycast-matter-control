import { environment } from "@raycast/api";
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
  // Prefer the deepest "Caused by:" line — matter.js wraps the real error in
  // a generic "MatterController unavailable" outer, and the innermost cause
  // is what the user actually wants to see.
  const causedBy = lines.filter((line) => /^Caused by:/.test(line.trim()));
  if (causedBy.length > 0) return causedBy[causedBy.length - 1].trim();
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
