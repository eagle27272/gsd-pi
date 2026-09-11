/**
 * Shared external-state bootstrap.
 *
 * Every entry point that materializes a project's `.gsd` must route through
 * `ensureExternalState` so state lands in `~/.gsd/projects/<hash>/` with a
 * symlink left behind. Previously only the auto-mode path did this, so
 * projects started from the guided flow or the init wizard kept a real local
 * `.gsd` directory forever.
 */

import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { closeAllWorkflowDatabases } from "./db-workspace.js";
import { migrateToExternalState, recoverFailedMigration } from "./migrate-external.js";
import { _clearGsdRootCache } from "./paths.js";
import { ensureGsdSymlink } from "./repo-identity.js";

export interface ExternalStateResult {
  /** Physical state directory the project's `.gsd` now resolves to. */
  externalPath: string;
  migrationError?: string;
  /**
   * How to surface `migrationError`. Hitting the authoritative-state guard is
   * expected when a symlink was replaced by a real directory, so it is not a
   * warning.
   */
  migrationErrorSeverity?: "info" | "warning";
}

const AUTHORITATIVE_STATE_GUARD = "External state already exists for this project";

/** Physical directory `<basePath>/.gsd` currently points at, or null if absent. */
function resolvedGsdTarget(basePath: string): string | null {
  try {
    return realpathSync(join(basePath, ".gsd"));
  } catch {
    return null;
  }
}

/** True only for a real local `.gsd` directory — lstat reports false for symlinks. */
function hasLocalGsdDirectory(basePath: string): boolean {
  try {
    return lstatSync(join(basePath, ".gsd")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Move `<project>/.gsd` to external storage and leave a symlink in its place.
 *
 * Callers must invoke this before `ensureGitignore` (so `.gsd` is not added to
 * `.gitignore` while it is still git-tracked, #1364) and before opening the
 * workflow database (migration moves the file the handle is bound to).
 */
export function ensureExternalState(basePath: string): ExternalStateResult {
  const before = resolvedGsdTarget(basePath);

  recoverFailedMigration(basePath);

  // Retire every handle before migration moves the containing directory so the
  // WAL is checkpointed and no cached adapter stays bound to the old inode.
  // Gated on there actually being a directory to move: this runs on every
  // session start, and closing live handles on the no-op path would drop the
  // database out from under an active session.
  if (hasLocalGsdDirectory(basePath)) closeAllWorkflowDatabases();

  const migration = migrateToExternalState(basePath);
  const externalPath = ensureGsdSymlink(basePath);

  // Only when `.gsd` actually moved. This runs on every session start, and
  // clearing an unchanged cache would make gsdRoot() re-probe every time.
  if (resolvedGsdTarget(basePath) !== before) _clearGsdRootCache();

  if (!migration.error) return { externalPath };

  return {
    externalPath,
    migrationError: migration.error,
    migrationErrorSeverity: migration.error.includes(AUTHORITATIVE_STATE_GUARD) ? "info" : "warning",
  };
}
