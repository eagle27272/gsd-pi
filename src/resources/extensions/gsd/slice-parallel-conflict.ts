/**
 * GSD Slice Parallel Conflict Detection — File overlap analysis between slices.
 *
 * Reads each slice's PLAN and extracts file paths mentioned in task
 * descriptions. If two slices share more than 5 file paths, they are considered
 * conflicting and should not run in parallel.
 *
 * Conservative by default: missing PLAN = block parallel execution.
 */

import { readFileSync } from "node:fs";

import { resolveSliceFile } from "./paths.js";

// ─── File Path Extraction ─────────────────────────────────────────────────────

/**
 * Extract file paths from a PLAN.md content string.
 * Matches common patterns like `src/...`, `lib/...`, paths with extensions.
 */
function extractFilePaths(content: string): Set<string> {
  const paths = new Set<string>();

  // Match file-like patterns: word/word paths with extensions, or src/lib/etc prefixed paths
  const patterns = [
    // Paths like src/foo/bar.ts, lib/utils.js, etc.
    /(?:src|lib|test|tests|app|pkg|cmd|internal|components|pages|api|utils|config|scripts|dist|build)\/[\w./-]+\.\w+/g,
    // Generic path with at least one slash and extension
    /(?<!\w)[\w-]+\/[\w./-]+\.\w{1,5}(?!\w)/g,
  ];

  for (const pattern of patterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      paths.add(match[0]);
    }
  }

  return paths;
}

// ─── Conflict Detection ──────────────────────────────────────────────────────

/**
 * Check if two slices have file conflicts that would block parallel execution.
 *
 * Plan lookup goes through resolveSliceFile so the flat-phase layout
 * (`phases/NN-slug/NN-MM-PLAN.md`) is found. The fail-closed default is kept:
 * a slice with no PLAN on disk has unknown file overlap, and an unplanned
 * slice should not be dispatched in parallel anyway. Degrading to sequential
 * execution is the safe direction — the wrong one is racing two agents over
 * the same files.
 *
 * @param basePath  Project root path.
 * @param mid       Milestone ID.
 * @param sliceA    First slice ID.
 * @param sliceB    Second slice ID.
 * @returns         true if parallel is unsafe (>5 shared files or missing plan).
 */
export function hasFileConflict(
  basePath: string,
  mid: string,
  sliceA: string,
  sliceB: string,
): boolean {
  const planPathA = resolveSliceFile(basePath, mid, sliceA, "PLAN");
  const planPathB = resolveSliceFile(basePath, mid, sliceB, "PLAN");

  // Conservative: missing PLAN = block
  if (!planPathA || !planPathB) {
    return true;
  }

  let contentA: string;
  let contentB: string;
  try {
    contentA = readFileSync(planPathA, "utf-8");
    contentB = readFileSync(planPathB, "utf-8");
  } catch {
    // Unreadable plan carries the same unknown overlap as a missing one.
    return true;
  }

  const filesA = extractFilePaths(contentA);
  const filesB = extractFilePaths(contentB);

  // If either has no files extracted, no conflict detectable → allow
  if (filesA.size === 0 || filesB.size === 0) {
    return false;
  }

  // Count shared files
  let sharedCount = 0;
  for (const file of filesA) {
    if (filesB.has(file)) {
      sharedCount++;
    }
  }

  return sharedCount > 5;
}
