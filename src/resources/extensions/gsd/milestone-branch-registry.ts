// gsd-pi — Milestone branch registry.
//
// Owns the name of each milestone's working branch. A milestone uses
// `milestone/<MID>` unless .gsd/milestone-branches/<MID>.json at the project
// root records a name the user chose. Teardown never deletes a record:
// stopping auto-mode keeps the branch, so resuming must find the same name.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteSync } from "./atomic-write.js";
import { MILESTONE_BRANCH_PREFIX } from "./branch-patterns.js";
import { GSDError, GSD_PARSE_ERROR } from "./errors.js";
import { nativeBranchExists, nativeBranchList, nativeBranchListMerged } from "./native-git-bridge.js";
import { gsdRoot } from "./paths.js";
import { logWarning } from "./workflow-logger.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";

const RECORD_DIR_NAME = "milestone-branches";
const RECORD_SUFFIX = ".json";

function recordDir(basePath: string): string {
  return join(gsdRoot(resolveWorktreeProjectRoot(basePath)), RECORD_DIR_NAME);
}

function recordPath(basePath: string, milestoneId: string): string {
  return join(recordDir(basePath), `${milestoneId}${RECORD_SUFFIX}`);
}

function parseRecord(file: string): string {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new GSDError(
      GSD_PARSE_ERROR,
      `Milestone branch record ${file} is unreadable (${err instanceof Error ? err.message : String(err)}). Fix or delete the file.`,
    );
  }
  const branch = (data as { branch?: unknown } | null)?.branch;
  if (typeof branch !== "string" || branch.trim() === "") {
    throw new GSDError(GSD_PARSE_ERROR, `Milestone branch record ${file} has no "branch" string. Fix or delete the file.`);
  }
  return branch;
}

function listRecordFiles(basePath: string): { dir: string; entries: string[] } | null {
  try {
    const dir = recordDir(basePath);
    return { dir, entries: readdirSync(dir) };
  } catch {
    return null;
  }
}

function readAllRecords(basePath: string): Map<string, string> {
  const records = new Map<string, string>();
  const listing = listRecordFiles(basePath);
  if (!listing) return records;
  for (const entry of listing.entries) {
    if (!entry.endsWith(RECORD_SUFFIX)) continue;
    try {
      records.set(entry.slice(0, -RECORD_SUFFIX.length), parseRecord(join(listing.dir, entry)));
    } catch (err) {
      logWarning("worktree", `${err instanceof Error ? err.message : String(err)} Skipping it.`);
    }
  }
  return records;
}

export function defaultMilestoneBranch(milestoneId: string): string {
  return `${MILESTONE_BRANCH_PREFIX}${milestoneId}`;
}

export function milestoneIdFromDefaultBranch(branch: string): string | null {
  if (!branch.startsWith(MILESTONE_BRANCH_PREFIX)) return null;
  return branch.slice(MILESTONE_BRANCH_PREFIX.length) || null;
}

export function readMilestoneBranchRecord(basePath: string, milestoneId: string): string | null {
  const file = recordPath(basePath, milestoneId);
  return existsSync(file) ? parseRecord(file) : null;
}

/** Writes without validation. Callers go through setMilestoneBranch. */
export function writeMilestoneBranchRecord(basePath: string, milestoneId: string, branch: string): void {
  const file = recordPath(basePath, milestoneId);
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteSync(file, `${JSON.stringify({ branch }, null, 2)}\n`);
}

export function hasMilestoneBranchRecord(basePath: string, milestoneId: string): boolean {
  return existsSync(recordPath(basePath, milestoneId));
}

/**
 * Throws on an unreadable record instead of falling back to the default:
 * the fallback would start a second branch and split the milestone's work.
 */
export function autoWorktreeBranch(basePath: string, milestoneId: string): string {
  return readMilestoneBranchRecord(basePath, milestoneId) ?? defaultMilestoneBranch(milestoneId);
}

export function milestoneIdForBranch(basePath: string, branch: string): string | null {
  const fromDefault = milestoneIdFromDefaultBranch(branch);
  if (fromDefault) return fromDefault;
  for (const [milestoneId, recorded] of readAllRecords(basePath)) {
    if (recorded === branch) return milestoneId;
  }
  return null;
}

export function isMilestoneBranch(basePath: string, branch: string): boolean {
  return milestoneIdForBranch(basePath, branch) !== null;
}

export function listMilestoneBranches(
  basePath: string,
  git: { branchList?: typeof nativeBranchList; branchExists?: typeof nativeBranchExists } = {},
): string[] {
  const branchList = git.branchList ?? nativeBranchList;
  const branchExists = git.branchExists ?? nativeBranchExists;
  const branches = new Set(branchList(basePath, `${MILESTONE_BRANCH_PREFIX}*`));
  for (const recorded of readAllRecords(basePath).values()) {
    if (!branches.has(recorded) && branchExists(basePath, recorded)) branches.add(recorded);
  }
  return [...branches];
}

export function listMergedMilestoneBranches(basePath: string, target: string): string[] {
  const recorded = new Set(readAllRecords(basePath).values());
  return nativeBranchListMerged(basePath, target)
    .map((branch) => branch.replace(/^[*+]\s+/, ""))
    .filter((branch) => branch.startsWith(MILESTONE_BRANCH_PREFIX) || recorded.has(branch));
}

/**
 * Keeps the record when the branch still exists (the delete failed) or the
 * record is unreadable, so the branch stays attributable to its milestone.
 */
export function forgetMilestoneBranchIfDeleted(basePath: string, milestoneId: string): void {
  try {
    const branch = readMilestoneBranchRecord(basePath, milestoneId);
    if (branch === null) return;
    if (nativeBranchExists(resolveWorktreeProjectRoot(basePath), branch)) return;
    unlinkSync(recordPath(basePath, milestoneId));
  } catch (err) {
    logWarning(
      "worktree",
      `Could not clear the branch record for ${milestoneId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
