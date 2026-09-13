// Project/App: gsd-pi
// File Purpose: Resolves expected auto-mode artifact paths across project and worktree projections.
// GSD Auto-mode — Artifact Path Resolution
//
// resolveExpectedArtifactPath and diagnoseExpectedArtifact moved here from
// auto-recovery.ts (Phase 5 dead-code cleanup). The artifact verification
// function was removed entirely — callers now query WorkflowEngine directly.

import {
  gsdRoot,
  resolveDir,
  resolveFile,
  resolveMilestonePath,
  resolveMilestoneFile,
  resolvePhaseDirIn,
  resolveSliceFile,
  relMilestoneFile,
  relSliceFile,
  buildFlatTaskFileName,
  buildTaskFileName,
  resolveSlicePath,
  resolveTasksDir,
  normalizeRealPath,
} from "./paths.js";
import { milestoneIdToPhaseNum, slicePlanFileName } from "./layout-policy.js";
import { parseUnitId } from "./unit-id.js";
import { basename, dirname, join, relative } from "node:path";
import { existsSync } from "node:fs";

/**
 * The phase directory for `mid` under the CANONICAL project `.gsd`.
 *
 * `resolveMilestonePath` anchors on gsdProjectionRoot (the worktree `.gsd`
 * when the base is inside one). A worktree that has not yet received its
 * projection must still resolve the artifacts dispatch rendered at the project
 * root (#852, #870), so this second lookup anchors on gsdRoot instead.
 */
function resolveProjectPhaseDir(base: string, mid: string): string | null {
  return resolvePhaseDirIn(gsdRoot(base), mid);
}

function resolveProjectMilestoneFile(base: string, mid: string, suffix: string): string | null {
  const dir = resolveProjectPhaseDir(base, mid);
  if (!dir) return null;
  const file = join(dir, `${String(milestoneIdToPhaseNum(mid)).padStart(2, "0")}-${suffix}.md`);
  return existsSync(file) ? file : null;
}

function resolveProjectSliceFile(base: string, mid: string, sid: string, suffix: string): string | null {
  const dir = resolveProjectPhaseDir(base, mid);
  if (!dir) return null;
  const file = join(dir, slicePlanFileName(milestoneIdToPhaseNum(mid), sid, suffix));
  return existsSync(file) ? file : null;
}

function resolveMilestoneArtifactPath(
  base: string,
  mid: string,
  suffix: string,
): string | null {
  const existing = resolveProjectedMilestoneFile(base, mid, suffix)
    ?? resolveProjectMilestoneFile(base, mid, suffix);
  if (existing) return existing;
  const dir = resolveMilestonePath(base, mid) ?? resolveProjectPhaseDir(base, mid);
  if (dir) {
    // Flat-phase artifacts use the phase-number prefix (15-CONTEXT.md).
    // Building the wrong filename for the resolved dir produces
    // existsSync-false paths that trap the unit in a finalize-retry loop (#852).
    const phaseNum = milestoneIdToPhaseNum(mid);
    return join(dir, `${String(phaseNum).padStart(2, "0")}-${suffix}.md`);
  }
  return null;
}

function resolveSliceArtifactPath(
  base: string,
  mid: string,
  sid: string,
  suffix: string,
): string | null {
  const existing = resolveProjectedSliceFile(base, mid, sid, suffix)
    ?? resolveProjectSliceFile(base, mid, sid, suffix);
  if (existing) return existing;
  // Flat-phase: plan files live at phases/NN-slug/NN-MM-SUFFIX.md — resolveSliceFile handles both layouts.
  const flatPhase = resolveSliceFile(base, mid, sid, suffix);
  if (flatPhase) return flatPhase;
  // File doesn't exist yet — use relSliceFile for the layout-aware canonical path.
  // buildSliceFileName(sid) only has sliceId → MM-SUFFIX.md, wrong for both layouts.
  return join(base, relSliceFile(base, mid, sid, suffix));
}

function resolveProjectedMilestonePath(base: string, mid: string): string | null {
  return resolveMilestonePath(base, mid);
}

function resolveProjectedMilestoneFile(base: string, mid: string, suffix: string): string | null {
  return resolveMilestoneFile(base, mid, suffix);
}

function resolveProjectedSlicePath(base: string, mid: string, sid: string): string | null {
  const milestoneDir = resolveProjectedMilestonePath(base, mid);
  if (!milestoneDir) return null;
  const slicesDir = join(milestoneDir, "slices");
  const dir = resolveDir(slicesDir, sid);
  return dir ? join(slicesDir, dir) : null;
}

function resolveProjectedSliceFile(base: string, mid: string, sid: string, suffix: string): string | null {
  const dir = resolveProjectedSlicePath(base, mid, sid);
  if (!dir) return null;
  const file = resolveFile(dir, sid, suffix);
  return file ? join(dir, file) : null;
}

/**
 * Resolve the expected artifact for a unit to an absolute path.
 */
export function resolveExpectedArtifactPath(
  unitType: string,
  unitId: string,
  base: string,
): string | null {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  switch (unitType) {
    case "workflow-preferences":
      return join(gsdRoot(base), "PREFERENCES.md");
    case "discuss-project":
      return join(gsdRoot(base), "PROJECT.md");
    case "discuss-requirements":
      return join(gsdRoot(base), "REQUIREMENTS.md");
    case "research-decision":
      return join(gsdRoot(base), "runtime", "research-decision.json");
    case "research-project":
      return join(gsdRoot(base), "research", "PROJECT-RESEARCH-BLOCKER.md");
    case "discuss-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "CONTEXT");
    }
    case "discuss-slice": {
      return resolveSliceArtifactPath(base, mid, sid!, "CONTEXT");
    }
    case "research-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "RESEARCH");
    }
    case "plan-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "ROADMAP");
    }
    case "research-slice": {
      // #4414: Sentinel unitId "{mid}/parallel-research" fans out across
      // multiple slices. Resolve to a milestone-level placeholder path so
      // blocker escalation has somewhere to write. Verification for this
      // sentinel is handled directly in verifyExpectedArtifact.
      if (sid === "parallel-research") {
        return resolveMilestoneArtifactPath(base, mid, "PARALLEL-BLOCKER");
      }
      return resolveSliceArtifactPath(base, mid, sid!, "RESEARCH");
    }
    case "plan-slice": {
      return resolveSliceArtifactPath(base, mid, sid!, "PLAN");
    }
    case "refine-slice": {
      // ADR-011: refine-slice expands a sketch and writes the same PLAN.md as plan-slice.
      return resolveSliceArtifactPath(base, mid, sid!, "PLAN");
    }
    case "reassess-roadmap": {
      // gsd_reassess_roadmap writes the milestone-scoped <NN>-ROADMAP-ASSESSMENT.md
      // (resolveRoadmapAssessmentProjectionPath), not a slice-scoped ASSESSMENT.
      return resolveMilestoneArtifactPath(base, mid, "ROADMAP-ASSESSMENT");
    }
    case "run-uat": {
      return resolveSliceArtifactPath(base, mid, sid!, "ASSESSMENT");
    }
    case "execute-task": {
      const slicePath = resolveProjectedSlicePath(base, mid, sid!)
        ?? resolveSlicePath(base, mid, sid!);
      if (!slicePath || !tid) return null;
      // A slices/<SID>/ slice dir keeps task summaries in a tasks/ subdir.
      // Flat-phase: slicePath IS the phase dir and task summaries live beside
      // the plan files at the phase root. A tasks/ subdir may still exist in
      // flat-phase for auxiliary task-scoped artifacts (e.g. T01-VERIFY.json
      // gate outputs) — its mere existence must NOT redirect summary resolution
      // into tasks/ (#1208).
      const isSlicesSubdir = basename(dirname(slicePath)) === "slices";
      const summaryDir = isSlicesSubdir
        ? (resolveTasksDir(base, mid, sid!) ?? slicePath)
        : slicePath;
      const fileName = isSlicesSubdir
        ? buildTaskFileName(tid, "SUMMARY")
        : buildFlatTaskFileName(sid!, tid, "SUMMARY");
      return join(summaryDir, fileName);
    }
    case "complete-slice": {
      return resolveSliceArtifactPath(base, mid, sid!, "SUMMARY");
    }
    case "validate-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "VALIDATION");
    }
    case "complete-milestone": {
      return resolveMilestoneArtifactPath(base, mid, "SUMMARY");
    }
    case "replan-slice": {
      return resolveSliceArtifactPath(base, mid, sid!, "REPLAN");
    }
    case "triage-captures":
      // Verified against CAPTURES.md state in verifyExpectedArtifact.
      return null;
    case "quick-task":
      // Verified against the capture's Executed field in CAPTURES.md.
      return null;
    case "rewrite-docs":
      return null;
    case "gate-evaluate":
      // Gate evaluate writes to DB quality_gates table — verified via state derivation
      return null;
    case "reactive-execute":
      // Reactive execute normally produces multiple task summaries. On terminal
      // batch recovery, the engine writes a slice-level blocker sentinel.
      return mid && sid ? resolveSliceArtifactPath(base, mid, sid, "REACTIVE-BLOCKER") : null;
    default:
      return null;
  }
}

export function diagnoseExpectedArtifact(
  unitType: string,
  unitId: string,
  base: string,
): string | null {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  switch (unitType) {
    case "workflow-preferences":
      return ".gsd/PREFERENCES.md with workflow_prefs_captured: true";
    case "discuss-project":
      return ".gsd/PROJECT.md (valid project context)";
    case "discuss-requirements":
      return ".gsd/REQUIREMENTS.md (valid requirements registry)";
    case "research-decision":
      return ".gsd/runtime/research-decision.json with decision research|skip";
    case "research-project":
      return ".gsd/research/{STACK,FEATURES,ARCHITECTURE,PITFALLS}.md with at least one real research file; blocker-only outputs stop";
    case "discuss-milestone":
      return `${relMilestoneFile(base, mid, "CONTEXT")} (milestone context from discussion)`;
    case "discuss-slice":
      return `${relSliceFile(base, mid, sid!, "CONTEXT")} (slice context from discussion)`;
    case "research-milestone":
      return `${relMilestoneFile(base, mid, "RESEARCH")} (milestone research)`;
    case "plan-milestone":
      return `${relMilestoneFile(base, mid, "ROADMAP")} (milestone roadmap)`;
    case "research-slice":
      if (sid === "parallel-research") {
        return `${relMilestoneFile(base, mid, "PARALLEL-BLOCKER")} (parallel slice research sentinel)`;
      }
      return `${relSliceFile(base, mid, sid!, "RESEARCH")} (slice research)`;
    case "plan-slice":
      return `${relSliceFile(base, mid, sid!, "PLAN")} with embedded task plans`;
    case "refine-slice":
      return `${relSliceFile(base, mid, sid!, "PLAN")} with embedded refined task plans`;
    case "execute-task": {
      return `Task ${tid} marked [x] in ${relSliceFile(base, mid, sid!, "PLAN")} + summary written`;
    }
    case "complete-slice":
      return `Slice ${sid} marked [x] in ${relMilestoneFile(base, mid, "ROADMAP")} + summary + UAT written`;
    case "replan-slice":
      return `${relSliceFile(base, mid, sid!, "REPLAN")} + updated ${relSliceFile(base, mid, sid!, "PLAN")}`;
    case "triage-captures":
      return ".gsd/CAPTURES.md with no pending captures";
    case "quick-task":
      return `.gsd/CAPTURES.md capture ${sid ?? "<capture-id>"} marked executed`;
    case "rewrite-docs":
      return "Active overrides resolved in .gsd/OVERRIDES.md + plan documents updated";
    case "reassess-roadmap":
      return `${relMilestoneFile(base, mid, "ROADMAP-ASSESSMENT")} (roadmap reassessment)`;
    case "run-uat":
      return `${relSliceFile(base, mid, sid!, "ASSESSMENT")} (UAT assessment result)`;
    case "validate-milestone":
      return `a canonical validation result persisted via gsd_validate_milestone (projected to ${relMilestoneFile(base, mid, "VALIDATION")})`;
    case "complete-milestone":
      return `${relMilestoneFile(base, mid, "SUMMARY")} (milestone summary)`;
    default:
      return null;
  }
}

export interface SliceResearchLocation {
  /** Absolute path when research exists; null when missing. */
  absolutePath: string | null;
  /** Prompt-friendly relative path when research exists. */
  relativePath: string | null;
}

/**
 * Resolve slice RESEARCH with worktree projection first, then canonical
 * project-root path. Shared by dispatch rules, execute-task prompts, and
 * artifact verification.
 */
export function resolveSliceResearchLocation(
  basePath: string,
  mid: string,
  sid: string,
): SliceResearchLocation {
  const projectedFile = resolveSliceFile(basePath, mid, sid, "RESEARCH");
  if (projectedFile) {
    return {
      absolutePath: projectedFile,
      relativePath: relSliceFile(basePath, mid, sid, "RESEARCH"),
    };
  }

  const canonicalPath = resolveExpectedArtifactPath("research-slice", `${mid}/${sid}`, basePath);
  if (canonicalPath && existsSync(canonicalPath)) {
    return {
      absolutePath: canonicalPath,
      relativePath: relative(normalizeRealPath(basePath), canonicalPath),
    };
  }

  return { absolutePath: null, relativePath: null };
}

/** Returns the absolute RESEARCH path when it exists, otherwise null. */
export function resolveExistingSliceResearchPath(
  basePath: string,
  mid: string,
  sid: string,
): string | null {
  return resolveSliceResearchLocation(basePath, mid, sid).absolutePath;
}
