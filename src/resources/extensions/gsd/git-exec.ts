/**
 * Shared safe runners for git CLI shell-outs.
 *
 * A raw execFileSync/spawnSync inherits the caller's GIT_DIR, GIT_WORK_TREE
 * and GIT_INDEX_FILE, so a GSD invoked from a git hook or another worktree's
 * terminal silently reads and writes a different repository than the one it
 * was handed. These runners always scrub those vars via gitNoPromptEnv();
 * routing every call site through them makes that impossible to forget.
 * (Issue #4980 NEW-1, #8)
 *
 * This module imports nothing but the git-constants leaf, so even low-level
 * modules such as paths.ts can use it — runGit in git-service.ts cannot serve
 * that role without an import cycle.
 *
 * Errors are rethrown verbatim rather than wrapped: callers inspect `.status`
 * and `.stderr` on the child-process error to distinguish git's exit codes.
 */

import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { gitNoPromptEnv } from "./git-constants.js";

export interface GitCaptureOptions {
  /** Return "" instead of throwing when git exits non-zero. */
  allowFailure?: boolean;
  /** Piped to git's stdin. */
  input?: string;
  /**
   * Trim stdout (default true). Set false for porcelain/`-z` output, where the
   * leading status column is a significant space and trimming corrupts the
   * first record.
   */
  trim?: boolean;
  timeout?: number;
  maxBuffer?: number;
}

export interface GitSpawnOptions {
  timeout?: number;
  maxBuffer?: number;
}

/**
 * Run git and return its trimmed stdout.
 * Throws execFileSync's error unchanged unless `allowFailure` is set.
 */
export function gitCapture(cwd: string | undefined, args: readonly string[], options: GitCaptureOptions = {}): string {
  try {
    const stdout = execFileSync("git", args as string[], {
      cwd,
      stdio: [options.input != null ? "pipe" : "ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: gitNoPromptEnv(),
      ...(options.input != null ? { input: options.input } : {}),
      ...(options.timeout != null ? { timeout: options.timeout } : {}),
      ...(options.maxBuffer != null ? { maxBuffer: options.maxBuffer } : {}),
    });
    return options.trim === false ? stdout : stdout.trim();
  } catch (err) {
    if (options.allowFailure) return "";
    throw err;
  }
}

/** gitCapture for output that is not valid UTF-8. Returns raw stdout. */
export function gitCaptureBuffer(cwd: string | undefined, args: readonly string[]): Buffer {
  return execFileSync("git", args as string[], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: gitNoPromptEnv(),
  });
}

/**
 * Run git without throwing, for callers that branch on `status`/`stderr`.
 * stdio is left at spawnSync's default so both streams are captured.
 */
export function gitSpawn(cwd: string | undefined, args: readonly string[], options: GitSpawnOptions = {}): SpawnSyncReturns<string> {
  return spawnSync("git", args as string[], {
    cwd,
    encoding: "utf-8",
    env: gitNoPromptEnv(),
    ...(options.timeout != null ? { timeout: options.timeout } : {}),
    ...(options.maxBuffer != null ? { maxBuffer: options.maxBuffer } : {}),
  });
}

/** gitSpawn for output that is not valid UTF-8 (NUL-separated paths, blob contents). */
export function gitSpawnBuffer(cwd: string | undefined, args: readonly string[], options: GitSpawnOptions = {}): SpawnSyncReturns<Buffer> {
  return spawnSync("git", args as string[], {
    cwd,
    encoding: "buffer",
    env: gitNoPromptEnv(),
    ...(options.timeout != null ? { timeout: options.timeout } : {}),
    ...(options.maxBuffer != null ? { maxBuffer: options.maxBuffer } : {}),
  });
}
