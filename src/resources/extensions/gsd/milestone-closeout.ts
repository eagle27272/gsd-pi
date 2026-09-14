// Project/App: gsd-pi
// File Purpose: Coordinates milestone closeout phases across dispatch, post-unit, and recovery.
//
// - preflight: dispatch git clean before complete-milestone agent (auto-dispatch)
// - postUnit: git commit, artifact verify, DB settle, then GitHub finalize
// - recovery: DB repair from artifacts, then GitHub finalize

import { existsSync } from "node:fs";

import { loadFile } from "./files.js";
import { resolveMilestoneFile } from "./paths.js";
import {
  getMilestone,
  getClosedSliceIds,
  getLatestAssessmentByScope,
  getMilestoneSlices,
  getSliceTasks,
  isDbAvailable,
} from "./gsd-db.js";
import { isClosedStatus } from "./status-guards.js";
import { resolveExpectedArtifactPath } from "./auto-artifact-paths.js";
import {
  handleCompleteMilestone,
  repairAdoptedMilestoneSummaryProjection,
} from "./tools/complete-milestone.js";
import {
  isMilestoneLifecycleAdopted,
  readMilestoneCloseoutAuthorization,
  readMilestoneLifecycleStatus,
} from "./db/milestone-closeout-readiness.js";
import { runSafely } from "./auto-utils.js";
import { extractVerdict, isAcceptableUatVerdict } from "./verdict-parser.js";
import { uatSignoffBlockerGuidance } from "./guidance.js";
import { logWarning } from "./workflow-logger.js";
import { hasImplementationArtifacts } from "./milestone-implementation-evidence.js";
import { buildCompleteMilestonePrompt } from "./auto-prompts.js";
import { proveMilestoneCloseout } from "./milestone-closeout-proof.js";
import { checkCloseoutConsistencyGate } from "./closeout-consistency-gate.js";
import { resolveCanonicalMilestoneRoot } from "./worktree-manager.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { captureMilestoneVerificationSourceRevision } from "./verification-source-integrity.js";
import type { DispatchAction, DispatchContext } from "./auto-dispatch.js";
import {
  commitPendingMilestoneCloseoutChanges,
  findMissingSummaries,
  isVerificationNotApplicable,
  readUatGateVerdict,
} from "./auto-dispatch.js";

const COMPLETE_MILESTONE_DB_SETTLE_MS = 1500;
const COMPLETE_MILESTONE_DB_SETTLE_POLL_MS = 100;

/** How far past the first "operational" mention the verdict for that class may appear. */
const OPERATIONAL_SECTION_WINDOW = 2000;

const VALIDATION_SKIP_MARKERS = [
  /^skip_validation:\s*true$/im,
  /skip(?:ped)?[\s\-]+(?:by|per|due to)\s+(?:preference|budget|profile)/i,
  /trivial-scope pipeline variant/i,
];

/** "This class does not apply here" — a legitimate way to address the class. */
const NOT_APPLICABLE_RE = /\b(?:n\/a|not[\s-]+(?:applicable|required|needed))\b/i;

/**
 * An explicitly negative outcome. Checked before the positive tokens because
 * every negation embeds the positive word it negates.
 */
const NEGATED_OUTCOME_RE =
  /\b(?:un(?:met|satisfied|covered|verified|addressed)|fail(?:s|ed|ing|ure)?)\b|\b(?:not|never|no)[\s-]+(?:met|satisfied|covered|passed?|verified|confirmed|addressed|complete[d]?|checked|done)\b/i;

const POSITIVE_OUTCOME_RE =
  /✅|\b(?:met|satisfied|covered|pass(?:ed|es)?|verified|confirmed|addressed|complete[d]?|partially|deferred|true|yes)\b/i;

/**
 * True when a VALIDATION document actually addresses the planned operational
 * verification class.
 *
 * The previous matchers were presence-only over the whole document: `MET` is a
 * substring of `NOT MET` and `PASS` of `PASSED`, so
 * `"## Operational\nStatus: NOT MET. Every verification class FAILED."`
 * satisfied both of them (#17). Text asserting that operational verification
 * failed must not clear a milestone-completion gate.
 *
 * Scoped to the operational section so an unrelated "FAILED" elsewhere in the
 * document does not block a milestone whose operational class is genuinely met.
 */
export function _operationalVerificationAddressed(validationContent: string): boolean {
  if (VALIDATION_SKIP_MARKERS.some((re) => re.test(validationContent))) return true;

  const mention = /operational/i.exec(validationContent);
  if (!mention) return false;
  const section = validationContent.slice(mention.index, mention.index + OPERATIONAL_SECTION_WINDOW);

  if (NOT_APPLICABLE_RE.test(section)) return true;
  if (NEGATED_OUTCOME_RE.test(section)) return false;
  return POSITIVE_OUTCOME_RE.test(section);
}

/**
 * True when any slice or task under the milestone is still open.
 *
 * `isClosedStatus` treats `cancelled` and `skipped` as closed, so a milestone
 * row can read terminal while its slices and tasks are mid-flight. Git cleanup
 * force-deletes branches, so it must see the whole tree, not just the
 * milestone row (#11).
 */
function hasOpenMilestoneWork(milestoneId: string): boolean {
  return getMilestoneSlices(milestoneId).some((slice) =>
    !isClosedStatus(slice.status) ||
    getSliceTasks(milestoneId, slice.id).some((task) => !isClosedStatus(task.status)),
  );
}

/**
 * True when a milestone is terminal for git cleanup (orphaned worktrees, stale branches).
 * DB-authoritative (ADR-017): closed status, or validation-pass with all slices closed.
 * When the DB is unavailable we cannot make this decision and conservatively
 * return false so callers leave the worktree/branch alone instead of cleaning
 * up based on parsed projections.
 */
export async function isCompletedMilestoneTerminal(
  basePath: string,
  milestoneId: string,
): Promise<boolean> {
  if (!isDbAvailable()) return false;

  const milestone = getMilestone(milestoneId);
  if (!milestone) return false;

  const lifecycleStatus = readMilestoneLifecycleStatus(milestoneId);
  if (lifecycleStatus) {
    if (lifecycleStatus === "completed" || lifecycleStatus === "cancelled") {
      return !hasOpenMilestoneWork(milestoneId);
    }
    const artifactBasePath = resolveCanonicalMilestoneRoot(basePath, milestoneId);
    const source = captureMilestoneVerificationSourceRevision(
      artifactBasePath,
      loadEffectiveGSDPreferences(artifactBasePath)?.preferences,
    );
    if (!source.ok || !readMilestoneCloseoutAuthorization({
      milestoneId,
      sourceRevision: source.sourceRevision,
    }).authorized) return false;
  } else {
    if (isClosedStatus(milestone.status)) {
      return !hasOpenMilestoneWork(milestoneId);
    }
    const validation = getLatestAssessmentByScope(milestoneId, "milestone-validation");
    if (validation?.status !== "pass") return false;
  }

  // No explicit closeout record — slice and task closure is the only evidence,
  // so an empty slice set proves nothing.
  const slices = getMilestoneSlices(milestoneId);
  if (slices.length === 0) return false;
  return !hasOpenMilestoneWork(milestoneId);
}

/** Write a missing milestone SUMMARY projection when canonical DB closeout already settled. */
export async function repairMissingMilestoneSummaryProjection(
  basePath: string,
  milestoneId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const milestone = getMilestone(milestoneId);
  if (!milestone) {
    return { ok: false, error: `milestone not found: ${milestoneId}` };
  }

  const artifactBasePath = resolveCanonicalMilestoneRoot(basePath, milestoneId);
  const summaryPath = resolveExpectedArtifactPath("complete-milestone", milestoneId, artifactBasePath);
  if (summaryPath && existsSync(summaryPath)) {
    return { ok: true };
  }

  if (isMilestoneLifecycleAdopted(milestoneId)) {
    try {
      const repaired = await repairAdoptedMilestoneSummaryProjection(
        artifactBasePath,
        milestoneId,
      );
      return repaired
        ? { ok: true }
        : { ok: false, error: "milestone SUMMARY projection write failed" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const result = await handleCompleteMilestone(
    {
      milestoneId,
      title: milestone.title,
      oneLiner: "Canonical closeout completed; summary projection repaired automatically.",
      narrative:
        "The workflow database recorded this milestone as complete, but the milestone SUMMARY artifact was missing on disk. " +
        "Dispatch policy repaired the projection so closeout proof and cleanup can proceed.",
      verificationPassed: true,
      triggerReason: "closeout-projection-repair",
    },
    basePath,
  );

  if ("error" in result) {
    return { ok: false, error: result.error };
  }
  const writtenSummaryPath = result.summaryPath;
  if (result.stale || !writtenSummaryPath || !existsSync(writtenSummaryPath)) {
    return { ok: false, error: "milestone SUMMARY projection write failed" };
  }
  return { ok: true };
}

/**
 * True when the milestone is closed in the DB and the completion summary artifact exists.
 * Polls briefly so post-unit verification can observe the tool's DB write.
 */
export async function isMilestoneCloseoutSettled(mid: string, basePath: string): Promise<boolean> {
  const deadline = Date.now() + COMPLETE_MILESTONE_DB_SETTLE_MS;
  while (Date.now() < deadline) {
    if (isDbAvailable()) {
      const milestone = getMilestone(mid);
      if (milestone && isClosedStatus(milestone.status)) {
        const artifactBasePath = resolveCanonicalMilestoneRoot(basePath, mid);
        const closeoutProof = proveMilestoneCloseout(mid, {
          refreshFromDisk: true,
          summaryArtifactBasePath: artifactBasePath,
          implementationEvidence: {
            basePath,
            requirement: "not-absent",
          },
        });
        if (closeoutProof.ok) {
          return true;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, COMPLETE_MILESTONE_DB_SETTLE_POLL_MS));
  }
  return false;
}

/** Non-blocking GitHub milestone close after local closeout has settled. */
export async function runMilestoneCloseoutGitHub(basePath: string, mid: string): Promise<void> {
  await runSafely("postUnit", "github-sync", async () => {
    const { finalizeMilestoneGitHubSync } = await import("../github-sync/sync.js");
    await finalizeMilestoneGitHubSync(basePath, mid);
  });
}

/**
 * Dispatch policy for completing-milestone → complete-milestone.
 * Returns null when the phase does not match or guards do not apply.
 */
export async function evaluateCompleteMilestoneDispatch(
  ctx: DispatchContext,
): Promise<DispatchAction | null> {
  if (ctx.state.phase !== "completing-milestone") return null;
  return evaluateGuardedCompleteMilestoneDispatch(ctx);
}

/** Run the complete-milestone guards independently of legacy state derivation. */
export async function evaluateGuardedCompleteMilestoneDispatch(
  ctx: DispatchContext,
): Promise<DispatchAction> {
  const { mid, midTitle, basePath, prefs } = ctx;
  const adoptedMilestone = isDbAvailable() && isMilestoneLifecycleAdopted(mid);

  if (isDbAvailable()) {
    const milestone = getMilestone(mid);
    if (milestone && isClosedStatus(milestone.status)) {
      const artifactBasePath = resolveCanonicalMilestoneRoot(basePath, mid);
      const summaryPath = resolveExpectedArtifactPath("complete-milestone", mid, artifactBasePath);
      const summaryMissing = !summaryPath || !existsSync(summaryPath);
      if (summaryMissing) {
        const repair = await repairMissingMilestoneSummaryProjection(basePath, mid);
        if (!repair.ok) {
          logWarning(
            "dispatch",
            `Milestone ${mid} is closed in DB but SUMMARY repair failed: ${repair.error}. Dispatching complete-milestone to retry.`,
          );
        } else {
          return { action: "skip" };
        }
      } else {
        return { action: "skip" };
      }
    }
  }

  const closeoutGitStop = commitPendingMilestoneCloseoutChanges(basePath, mid);
  if (closeoutGitStop) return closeoutGitStop;

  if (prefs?.uat_dispatch) {
    // DB-authoritative (ADR-017): UAT sign-off gating never parses the
    // ROADMAP projection. Without a DB we cannot verify — stop conservatively.
    if (!isDbAvailable()) {
      return {
        action: "stop",
        reason: `Cannot complete milestone ${mid}: unable to verify UAT verdicts because the workflow DB is not accessible.`,
        level: "warning",
      };
    }
    for (const sliceId of getClosedSliceIds(mid)) {
      const result = await readUatGateVerdict(basePath, mid, sliceId);
      if (!result) {
        return {
          action: "stop",
          reason: uatSignoffBlockerGuidance(mid, sliceId),
          level: "warning",
        };
      }
      const { verdict, uatType } = result;
      if (!isAcceptableUatVerdict(verdict, uatType)) {
        return {
          action: "stop",
          reason: uatSignoffBlockerGuidance(mid, sliceId, verdict),
          level: "warning",
        };
      }
    }
  }

  if (isDbAvailable()) {
    // Repair only the missing-validation closeout case here; existing guards below
    // and post-unit proof remain responsible for blocking incomplete closeouts.
    const consistency = checkCloseoutConsistencyGate(mid, {
      allowOpenMilestone: true,
      allowPassThroughValidation: !adoptedMilestone,
      artifactBasePath: resolveCanonicalMilestoneRoot(basePath, mid),
    });
    if (adoptedMilestone && !consistency.ok) {
      return {
        action: "stop",
        reason: consistency.message,
        level: "warning",
      };
    }
  }

  const validationFile = adoptedMilestone ? null : resolveMilestoneFile(basePath, mid, "VALIDATION");
  if (validationFile) {
    const validationContent = await loadFile(validationFile);
    if (validationContent) {
      const verdict = extractVerdict(validationContent);
      if (verdict !== "pass") {
        return {
          action: "stop",
          reason: `Cannot complete milestone ${mid}: VALIDATION verdict is "${verdict}". Address the findings and re-run validation. Only an unadopted compatibility milestone can use \`/gsd verdict pass --rationale "..."\` to override.`,
          level: "warning",
        };
      }
    }
  }

  const missingSlices = adoptedMilestone ? [] : findMissingSummaries(basePath, mid);
  if (missingSlices.length > 0) {
    return {
      action: "stop",
      reason: `Cannot complete milestone ${mid}: slices ${missingSlices.join(", ")} are missing SUMMARY files. Run /gsd doctor to diagnose.`,
      level: "error",
    };
  }

  const artifactCheck = hasImplementationArtifacts(basePath, mid);
  if (artifactCheck === "absent") {
    logWarning("dispatch", `Milestone ${mid} has no implementation files outside .gsd/ — continuing complete-milestone dispatch (planning-only/documentation-only milestone).`);
  }
  if (artifactCheck === "unknown") {
    logWarning("dispatch", `Implementation artifact check inconclusive for ${mid} — proceeding (git context unavailable)`);
  }

  try {
    if (isDbAvailable() && !adoptedMilestone) {
      const milestone = getMilestone(mid);
      if (milestone?.verification_operational &&
          !isVerificationNotApplicable(milestone.verification_operational)) {
        const validationPath = resolveMilestoneFile(basePath, mid, "VALIDATION");
        if (validationPath) {
          const validationContent = await loadFile(validationPath);
          if (validationContent) {
            if (!_operationalVerificationAddressed(validationContent)) {
              return {
                action: "stop",
                reason: `Milestone ${mid} has planned operational verification ("${milestone.verification_operational.substring(0, 100)}") but the validation output does not address it. Re-run validation with verification class awareness, or update the validation to document operational compliance.`,
                level: "warning",
              };
            }
          }
        }
      }
    }
  } catch (err) {
    // Fail closed (#17): this is a milestone-completion gate. Swallowing the
    // error and falling through to dispatch let an unreadable VALIDATION or an
    // unavailable DB complete the milestone as if the class had been verified.
    const detail = err instanceof Error ? err.message : String(err);
    logWarning("dispatch", `verification class check failed: ${detail}`);
    return {
      action: "stop",
      reason: `Cannot complete milestone ${mid}: the operational verification-class check could not run (${detail}). Resolve the underlying error and retry — completing without it would skip a planned verification class.`,
      level: "warning",
    };
  }

  return {
    action: "dispatch",
    unitType: "complete-milestone",
    unitId: mid,
    prompt: await buildCompleteMilestonePrompt(mid, midTitle, basePath),
  };
}
