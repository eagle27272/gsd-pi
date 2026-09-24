// gsd-pi — Choosing a milestone's working-branch name.
//
// Separate from milestone-branch-registry.ts because validation needs
// git-service.ts, and git-service.ts imports the registry.

import { QUICK_BRANCH_RE, SLICE_BRANCH_RE, WORKFLOW_BRANCH_RE } from "./branch-patterns.js";
import { gitCapture } from "./git-exec.js";
import { readIntegrationBranch, VALID_BRANCH_NAME } from "./git-service.js";
import {
  defaultMilestoneBranch,
  milestoneIdForBranch,
  milestoneIdFromDefaultBranch,
  readMilestoneBranchRecord,
  writeMilestoneBranchRecord,
} from "./milestone-branch-registry.js";
import { nativeBranchExists, nativeBranchList } from "./native-git-bridge.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";

export function setMilestoneBranch(
  basePath: string,
  milestoneId: string,
  requestedBranch: string,
): { ok: true; branch: string } | { ok: false; reason: string } {
  const projectRoot = resolveWorktreeProjectRoot(basePath);
  const branch = requestedBranch.trim();
  const defaultBranch = defaultMilestoneBranch(milestoneId);

  const liveBranch = [readMilestoneBranchRecord(projectRoot, milestoneId), defaultBranch]
    .find((candidate): candidate is string => !!candidate && nativeBranchExists(projectRoot, candidate));
  if (liveBranch && liveBranch !== branch) {
    return {
      ok: false,
      reason: `${milestoneId} already works on branch ${liveBranch}. The name is fixed once the branch exists.`,
    };
  }

  if (!liveBranch) {
    const problem = nameProblem(projectRoot, milestoneId, branch, defaultBranch);
    if (problem) return { ok: false, reason: problem };
  }

  writeMilestoneBranchRecord(projectRoot, milestoneId, branch);
  return { ok: true, branch };
}

function nameProblem(projectRoot: string, milestoneId: string, branch: string, defaultBranch: string): string | null {
  if (!isValidBranchName(branch)) return `"${branch}" is not a valid git branch name.`;
  if (milestoneIdFromDefaultBranch(branch) !== null && branch !== defaultBranch) {
    return `Names under milestone/ are reserved. Use ${defaultBranch} or a name outside milestone/.`;
  }
  if (SLICE_BRANCH_RE.test(branch) || QUICK_BRANCH_RE.test(branch) || WORKFLOW_BRANCH_RE.test(branch)) {
    return `"${branch}" matches a pattern that gsd reserves for slice, quick-task, or workflow branches.`;
  }
  const owner = milestoneIdForBranch(projectRoot, branch);
  if (owner !== null && owner !== milestoneId) return `Milestone ${owner} already uses "${branch}".`;
  if (branch === readIntegrationBranch(projectRoot, milestoneId)) {
    return `"${branch}" is the integration branch that ${milestoneId} merges into.`;
  }
  const clash = clashingBranch(projectRoot, branch);
  if (clash === branch) return `A branch named "${branch}" already exists.`;
  if (clash) return `"${branch}" clashes with the existing branch "${clash}".`;
  return null;
}

// Git accepts `refs/heads/x` and `-x` as literal branch names; neither is what
// a user who pastes them means.
function isValidBranchName(branch: string): boolean {
  if (!VALID_BRANCH_NAME.test(branch) || branch.startsWith("-") || branch.startsWith("refs/")) return false;
  try {
    gitCapture(undefined, ["check-ref-format", "--branch", branch]);
    return true;
  } catch {
    return false;
  }
}

// Git refuses to create a ref when another ref differs only in case on a
// case-insensitive file system, or when one name is a directory of the other
// (`feat` and `feat/x`). Catch both here instead of at milestone entry.
function clashingBranch(projectRoot: string, branch: string): string | null {
  const wanted = branch.toLowerCase();
  for (const existing of nativeBranchList(projectRoot)) {
    const have = existing.toLowerCase();
    if (have === wanted || have.startsWith(`${wanted}/`) || wanted.startsWith(`${have}/`)) return existing;
  }
  return null;
}
