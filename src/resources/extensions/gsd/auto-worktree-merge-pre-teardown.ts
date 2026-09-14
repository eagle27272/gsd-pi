// gsd-pi — Milestone merge pre-teardown safety guard.
//
// Owns the final data-loss check before deleting a merged milestone worktree:
// if the milestone worktree still has uncommitted work, abort teardown so the
// milestone branch remains a recovery ref.

import { existsSync } from "node:fs";

import { debugLog } from "./debug-logger.js";
import { GSDError, GSD_GIT_ERROR } from "./errors.js";
import {
  nativeGetCurrentBranch,
  nativeWorkingTreeStatus,
} from "./native-git-bridge.js";

export interface PreTeardownSafetyRequest {
  milestoneBranch: string;
  previousCwd: string;
  worktreeCwd: string;
}

interface PreTeardownSafetyDeps {
  chdir: typeof process.chdir;
  debugLog: typeof debugLog;
  existsSync: typeof existsSync;
  nativeGetCurrentBranch: typeof nativeGetCurrentBranch;
  nativeWorkingTreeStatus: typeof nativeWorkingTreeStatus;
}

const defaultDeps: PreTeardownSafetyDeps = {
  chdir: process.chdir.bind(process),
  debugLog,
  existsSync,
  nativeGetCurrentBranch,
  nativeWorkingTreeStatus,
};

let deps: PreTeardownSafetyDeps = defaultDeps;

export function _setPreTeardownSafetyDepsForTests(
  overrides: Partial<PreTeardownSafetyDeps>,
): void {
  deps = { ...defaultDeps, ...overrides };
}

export function _resetPreTeardownSafetyDepsForTests(): void {
  deps = defaultDeps;
}

/**
 * Build the abort error before restoring the cwd, so a failing `chdir` cannot
 * swallow an abort that was already decided.
 */
function abortTeardown(previousCwd: string, message: string): never {
  const abort = new GSDError(GSD_GIT_ERROR, message);
  try {
    deps.chdir(previousCwd);
  } catch (err) {
    deps.debugLog("mergeMilestoneToMain", {
      phase: "pre-teardown-chdir-failed",
      error: String(err),
    });
  }
  throw abort;
}

/**
 * Abort teardown when the milestone worktree still has uncommitted changes.
 *
 * The guard is intentionally scoped to worktree paths that are still on the
 * milestone branch. In branch-mode or parallel merge paths, `worktreeCwd` can
 * point at the integration branch; blocking on that dirty state would conflate
 * unrelated milestones and preserve the wrong recovery ref.
 *
 * Every step fails closed: an unreadable branch or an unreadable status leaves
 * the worktree in an unknown state, and teardown deletes work irreversibly, so
 * the unknown case aborts rather than proceeds.
 */
export function assertMilestoneWorktreeCleanBeforeTeardown(
  request: PreTeardownSafetyRequest,
): void {
  const { milestoneBranch, previousCwd, worktreeCwd } = request;
  if (!deps.existsSync(worktreeCwd)) return;

  let preTeardownBranch: string | null = null;
  let branchDetected = false;
  try {
    preTeardownBranch = deps.nativeGetCurrentBranch(worktreeCwd);
    branchDetected = true;
  } catch (err) {
    deps.debugLog("mergeMilestoneToMain", {
      phase: "pre-teardown-branch-detect-failed",
      error: String(err),
    });
  }

  if (branchDetected && preTeardownBranch !== milestoneBranch) return;

  let dirtyCheck: string;
  try {
    dirtyCheck = deps.nativeWorkingTreeStatus(worktreeCwd, { allowFailure: false });
  } catch (err) {
    deps.debugLog("mergeMilestoneToMain", {
      phase: "pre-teardown-dirty-check-error",
      error: String(err),
    });
    abortTeardown(
      previousCwd,
      `Milestone worktree state could not be verified before teardown. ` +
        `Aborting teardown to preserve ${milestoneBranch}. Error: ${String(err)}`,
    );
  }

  if (!dirtyCheck) return;

  abortTeardown(
    previousCwd,
    `Milestone worktree still has uncommitted changes after squash merge. ` +
      `Aborting teardown to preserve ${milestoneBranch}. Status:\n${dirtyCheck}`,
  );
}
