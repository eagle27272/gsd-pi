// gsd-pi — CodeGraph CLI invocation.
//
// Argv construction is pure and separately tested. Execution never throws: every
// failure mode comes back as a CodegraphRun the caller maps to a tool result.

import { execFile } from "node:child_process";

export const CODEGRAPH_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 8 * 1024 * 1024;

export interface ExploreParams {
  query: string;
  maxFiles?: number;
}

export interface NodeParams {
  name?: string;
  file?: string;
  offset?: number;
  limit?: number;
  symbolsOnly?: boolean;
}

export interface CodegraphRun {
  stdout: string;
  stderr: string;
  /** Exit code, or null when the process could not be spawned. */
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
}

export type CodegraphRunner = (
  bin: string,
  args: string[],
  signal: AbortSignal | undefined,
) => Promise<CodegraphRun>;

export function buildExploreArgs(projectRoot: string, params: ExploreParams): string[] {
  const args = ["--no-color", "explore", "-p", projectRoot];
  if (params.maxFiles !== undefined) args.push("--max-files", String(params.maxFiles));
  // `--` keeps a query that starts with a dash from being parsed as an option.
  args.push("--", params.query);
  return args;
}

export function buildNodeArgs(projectRoot: string, params: NodeParams): string[] {
  const args = ["--no-color", "node", "-p", projectRoot];
  if (params.file !== undefined) args.push("-f", params.file);
  if (params.offset !== undefined) args.push("--offset", String(params.offset));
  if (params.limit !== undefined) args.push("--limit", String(params.limit));
  if (params.symbolsOnly) args.push("--symbols-only");
  if (params.name !== undefined) args.push("--", params.name);
  return args;
}

export function createExecFileRunner(timeoutMs: number = CODEGRAPH_TIMEOUT_MS): CodegraphRunner {
  return (bin, args, signal) =>
    new Promise<CodegraphRun>((resolveRun) => {
      execFile(
        bin,
        args,
        { signal, timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (!error) {
            resolveRun({ stdout, stderr, code: 0, timedOut: false, aborted: false });
            return;
          }
          const err = error as Error & { code?: number | string; killed?: boolean };
          const aborted = signal?.aborted === true || err.name === "AbortError";
          const timedOut = !aborted && err.killed === true;
          resolveRun({
            stdout: stdout ?? "",
            stderr: stderr || err.message || "",
            code: typeof err.code === "number" ? err.code : null,
            timedOut,
            aborted,
          });
        },
      );
    });
}
