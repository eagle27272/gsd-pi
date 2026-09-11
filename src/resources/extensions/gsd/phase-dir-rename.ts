// Project/App: gsd-pi
// File Purpose: Rename the on-disk phase directory when a milestone title changes.

import { existsSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { LAYOUT_SEGMENTS } from "./layout-policy.js";
import {
  canonicalPhaseDirName,
  clearPathCache,
  isLegacyMilestonesLayoutIn,
  milestonesDirIn,
  resolvePhaseDirIn,
} from "./paths.js";

/**
 * Move `phases/NN-old-slug` → `phases/NN-canonical` after a title change.
 * No-op when the old dir is missing, the new dir already exists, names match,
 * or the project is still on the legacy milestones/ layout. (#1526)
 *
 * `projectionRoot` is the real `.gsd` directory — not the project root. It must
 * not be reconstructed from the project path, because `.gsd` is a symlink into
 * the external state dir under managed state (#2).
 */
export function renamePhaseDirOnTitleChange(
  projectionRoot: string,
  milestoneId: string,
  previousTitle: string | undefined,
  nextTitle: string,
): boolean {
  if (!nextTitle.trim()) return false;
  if (isLegacyMilestonesLayoutIn(projectionRoot)) return false;

  const nextName = canonicalPhaseDirName(milestoneId, nextTitle);
  const phasesDir = milestonesDirIn(projectionRoot);
  const nextPath = join(phasesDir, nextName);
  if (existsSync(nextPath)) return false;

  const existingPath = resolvePhaseDirIn(projectionRoot, milestoneId);
  const predictedOldPath = join(
    phasesDir,
    canonicalPhaseDirName(milestoneId, previousTitle || milestoneId),
  );
  const fromPath = existingPath && existsSync(existingPath) ? existingPath : predictedOldPath;

  if (!existsSync(fromPath)) return false;
  if (basename(fromPath) === nextName) return false;

  renameSync(fromPath, nextPath);
  clearPathCache();
  return true;
}

/**
 * The `phases/NN-slug` directory name that writers will actually resolve to for
 * this milestone, which is the only name artifact rows may be keyed under.
 *
 * Falls back to the title-derived canonical name only when nothing is on disk
 * yet — that is the name the next projection write will create. Deriving the
 * key from the title alone is what splits rows from files when the rename is
 * blocked or fails (#2).
 */
export function currentPhaseDirName(
  projectionRoot: string,
  milestoneId: string,
  title: string,
): string {
  const resolved = resolvePhaseDirIn(projectionRoot, milestoneId);
  if (resolved && dirname(resolved) === join(projectionRoot, LAYOUT_SEGMENTS.level1)) {
    return basename(resolved);
  }
  return canonicalPhaseDirName(milestoneId, title);
}
