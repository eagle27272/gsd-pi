/**
 * Pre-unit git checkpoint and rollback for auto-mode safety harness.
 * Uses the existing refs/gsd/ namespace (already pruned by doctor).
 *
 * Creates a lightweight ref at HEAD before unit execution. On failure,
 * the ref can be used to rollback the branch to the pre-unit state.
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import { logWarning } from "../workflow-logger.js";
import { gitCapture } from "../git-exec.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const CHECKPOINT_PREFIX = "refs/gsd/checkpoints/";

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a checkpoint ref at the current HEAD for the given unit.
 * Returns the SHA of HEAD, or null if the operation fails.
 */
export function createCheckpoint(basePath: string, unitId: string): string | null {
  try {
    const sha = gitCapture(basePath, ["rev-parse", "--verify", "HEAD"]);

    if (!sha || sha.length < 7) return null;

    // Sanitize unitId for use in ref path (replace / with -)
    const safeUnitId = unitId.replace(/\//g, "-");

    gitCapture(basePath, ["update-ref", `${CHECKPOINT_PREFIX}${safeUnitId}`, sha]);

    return sha;
  } catch (e) {
    const stderr = (e as { stderr?: Buffer | string }).stderr;
    const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr ?? "");
    if (
      stderrText.includes("Needed a single revision") ||
      stderrText.includes("unknown revision") ||
      stderrText.includes("ambiguous argument 'HEAD'")
    ) {
      return null;
    }
    logWarning("safety", `checkpoint creation failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Rollback the current branch to a checkpoint SHA.
 * Returns true on success, false on failure.
 *
 * WARNING: This is a destructive operation — it discards all changes
 * since the checkpoint. Only call when the user has opted in via
 * safety_harness.auto_rollback or an explicit manual trigger.
 */
export function rollbackToCheckpoint(
  basePath: string,
  unitId: string,
  sha: string,
): boolean {
  try {
    // Get current branch name
    const branch = gitCapture(basePath, ["rev-parse", "--abbrev-ref", "HEAD"]);

    if (!branch || branch === "HEAD") {
      logWarning("safety", "rollback: detached HEAD state, cannot rollback");
      return false;
    }

    // Preserve any staged or untracked user work before the hard reset.
    // The user may have a partial fix staged that they wanted to inspect;
    // reset --hard wipes both staged and unstaged changes (reflog only
    // covers committed state). Push a labeled stash first so recovery
    // is possible. (Issue #4980 HIGH-4)
    try {
      gitCapture(basePath, ["stash", "push", "--include-untracked", "-m", `gsd: pre-rollback-stash ${unitId} ${new Date().toISOString()}`]);
    } catch {
      /* nothing to stash, or stash refused — proceed with reset */
    }

    // Reset branch pointer and working tree to checkpoint SHA in one step.
    // Using `git reset --hard <sha>` works on the currently checked-out branch
    // (unlike `git branch -f` which is rejected for checked-out branches).
    gitCapture(basePath, ["reset", "--hard", sha]);

    // Cleanup checkpoint ref
    cleanupCheckpoint(basePath, unitId);

    return true;
  } catch (e) {
    logWarning("safety", `rollback failed: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Remove a checkpoint ref after successful unit completion.
 */
export function cleanupCheckpoint(basePath: string, unitId: string): void {
  try {
    const safeUnitId = unitId.replace(/\//g, "-");
    gitCapture(basePath, ["update-ref", "-d", `${CHECKPOINT_PREFIX}${safeUnitId}`]);
  } catch {
    // Non-fatal — ref may already have been cleaned up
  }
}
