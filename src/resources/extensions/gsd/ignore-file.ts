/**
 * Where GSD writes ignore rules, and what a repo already declares.
 *
 * GSD targets `.git/info/exclude` rather than the tracked `.gitignore` so
 * bootstrapping and self-healing never dirty a file the whole team shares.
 *
 * Its own module because both `gitignore.ts` and `native-git-bridge.ts` need
 * it, and `gitignore.ts` already imports the bridge — a shared leaf breaks the
 * cycle that importing one from the other would create.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitCapture } from "./git-exec.js";

/**
 * Resolve this repo's `.git/info/exclude`, or null when basePath is not a git
 * repo (or git is unavailable).
 *
 * `--git-path` resolves `info/exclude` to the *common* directory, so a linked
 * worktree correctly targets the main repo's exclude file — one shared set of
 * ignore rules across every worktree, which is what GSD's `.gsd-worktrees/`
 * layout needs. The result is relative in a plain checkout and absolute in a
 * worktree; `resolve` normalizes both.
 */
export function excludeFilePath(basePath: string): string | null {
  try {
    const raw = gitCapture(basePath, ["rev-parse", "--git-path", "info/exclude"]).trim();
    return raw ? resolve(basePath, raw) : null;
  } catch {
    return null;
  }
}

function readPatterns(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
}

/**
 * Every ignore pattern this repo declares locally, from `.git/info/exclude`
 * (where GSD writes) and `.gitignore` (where older GSD versions wrote, and
 * where projects declare their own rules).
 *
 * Nested and global ignore files are deliberately out of scope — this answers
 * "which patterns are literally declared here", not "would git ignore this
 * path". Use `isGsdGitignored` for the latter.
 */
export function declaredIgnorePatterns(
  basePath: string,
  /** Pass an already-resolved path to skip a redundant `git rev-parse`. */
  knownExcludePath?: string,
): Set<string> {
  const excludePath = knownExcludePath ?? excludeFilePath(basePath);
  return new Set([
    ...(excludePath ? readPatterns(excludePath) : []),
    ...readPatterns(join(basePath, ".gitignore")),
  ]);
}
