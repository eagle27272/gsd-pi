// gsd-pi — Choosing a milestone's working-branch name.
//
// Separate from milestone-branch-registry.ts because validation needs
// git-service.ts, and git-service.ts imports the registry.

import { QUICK_BRANCH_RE, SLICE_BRANCH_RE, WORKFLOW_BRANCH_RE } from "./branch-patterns.js";
import { gitCapture } from "./git-exec.js";
import { readIntegrationBranch, VALID_BRANCH_NAME } from "./git-service.js";
import {
  defaultMilestoneBranch,
  hasMilestoneBranchRecord,
  milestoneIdForBranch,
  milestoneIdFromDefaultBranch,
  readMilestoneBranchRecord,
  writeMilestoneBranchRecord,
} from "./milestone-branch-registry.js";
import { nativeBranchExists, nativeBranchList } from "./native-git-bridge.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
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

interface MilestoneBranchPromptCtx {
  hasUI: boolean;
  ui: {
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

/**
 * Asks just before auto-mode creates the branch. Callers skip it when git
 * isolation is "none". A headless session records nothing, so the milestone
 * keeps the `milestone/<MID>` default.
 */
export async function ensureMilestoneBranchName(
  ctx: MilestoneBranchPromptCtx,
  basePath: string,
  milestoneId: string,
  milestoneTitle: string | undefined,
): Promise<void> {
  if (!ctx.hasUI) return;
  const projectRoot = resolveWorktreeProjectRoot(basePath);
  if (hasMilestoneBranchRecord(projectRoot, milestoneId)) return;

  const defaultBranch = defaultMilestoneBranch(milestoneId);
  if (nativeBranchExists(projectRoot, defaultBranch)) {
    setMilestoneBranch(projectRoot, milestoneId, defaultBranch);
    return;
  }

  const format = loadEffectiveGSDPreferences(projectRoot)?.preferences?.git?.milestone_branch_format;
  const title = [
    `Branch name for ${milestoneId}${milestoneTitle ? ` (${milestoneTitle})` : ""}.`,
    format ? `Convention: ${format}.` : null,
    `Leave empty for ${defaultBranch}.`,
  ].filter((part): part is string => part !== null).join(" ");

  for (;;) {
    const answer = (await ctx.ui.input(title, defaultBranch))?.trim() ?? "";
    const result = setMilestoneBranch(projectRoot, milestoneId, answer || defaultBranch);
    if (result.ok) return;
    ctx.ui.notify(result.reason, "warning");
    if (!answer) return;
  }
}

/** Empty when git isolation is off, because then gsd creates no milestone branch. */
export function renderMilestoneBranchQuestion(basePath: string): string {
  const git = loadEffectiveGSDPreferences(basePath)?.preferences?.git;
  if (git?.isolation !== "worktree" && git?.isolation !== "branch") return "";
  const format = git.milestone_branch_format;
  const options = format
    ? [
        `a name built from the milestone title that follows the team convention \`${format}\`, labeled "(Recommended)"`,
        "`milestone/<ID>`",
        "\"Other — let me type it\"",
      ]
    : ["`milestone/<ID>`, labeled \"(Recommended)\"", "\"Other — let me type it\""];
  return [
    "## Milestone Branch Name",
    "",
    "gsd does each milestone's work on its own git branch. Ask the user what to call it.",
    "",
    "- Ask in the same `ask_user_questions` call as the milestone's depth verification question, as a second question with header \"Branch\" and id `milestone_branch_<ID>`. That id must not contain `depth_verification`.",
    `- Options: ${options.join("; ")}.`,
    "- If `ask_user_questions` is unavailable, ask the same question in plain text.",
    "- After the depth check passes and the milestone ID exists, call `gsd_milestone_set_branch` with `milestoneId` and the chosen `branch`, before you save that milestone's CONTEXT. For the default, pass `milestone/<ID>` with the real ID.",
    "- If the tool rejects the name, show the user its reason and ask again.",
  ].join("\n");
}
