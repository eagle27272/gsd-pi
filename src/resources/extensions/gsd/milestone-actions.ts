/**
 * GSD Milestone Actions — Park, Unpark, Cancel, and Discard operations.
 *
 * Park: Creates a PARKED.md marker file. deriveState() skips parked milestones
 * when finding the active milestone, but keeps them in the registry.
 *
 * Unpark: Removes the PARKED.md marker. The milestone resumes normal state
 * derivation (active/pending depending on position and dependencies).
 *
 * Cancel: Abandons the milestone and its unfinished work but keeps all history.
 *
 * Discard: Permanently removes the milestone directory. Also prunes
 * QUEUE-ORDER.json if the discarded milestone was in it.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveMilestonePath,
  resolveMilestoneFile,
  relMilestoneFile,
} from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { loadQueueOrder, saveQueueOrder } from "./queue-order.js";
import {
  assertNoAdoptedLifecycleHistory,
  deleteMilestone,
  getMilestone,
  isDbAvailable,
  updateMilestoneStatus,
} from "./gsd-db.js";
import { removeWorktree } from "./worktree-manager.js";
import { autoWorktreeBranch, forgetMilestoneBranchIfDeleted } from "./milestone-branch-registry.js";
import { logWarning } from "./workflow-logger.js";
import { isAutoActive } from "./auto.js";
import { isClosedStatus } from "./status-guards.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import { GSDError, GSD_STALE_STATE } from "./errors.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import {
  cancelMilestoneLifecycle,
  parkMilestoneLifecycle,
  readMilestoneLifecycleStatus,
  unparkMilestoneLifecycle,
} from "./milestone-lifecycle-domain-operation.js";
import { atomicWriteSync, removeProjectionFileSync } from "./atomic-write.js";
import { removeManagedProjectionTreeExactSync } from "./managed-projection-history.js";

/**
 * Writer-side assert for mutations that race with auto-mode's squash merge (#4704).
 * Auto-mode is confirmed not to call parkMilestone/discardMilestone/unparkMilestone
 * internally — these throws only surface invariant violations from new or forgotten
 * call sites, which is the correct failure mode to catch loudly.
 */
function assertNotAutoActive(action: string): void {
  if (isAutoActive()) {
    throw new Error(
      `${action} cannot run while auto-mode is active. Stop auto-mode first with /gsd stop.`,
    );
  }
}

function milestoneActionInvocation(
  operation: "park" | "unpark" | "cancel",
  milestoneId: string,
  actorType: "user" | "agent",
): ExecutionInvocation {
  const id = randomUUID();
  return {
    idempotencyKey: `internal:milestone.${operation}:${milestoneId}:${id}`,
    sourceTransport: "internal",
    actorType,
    traceId: id,
  };
}

// ─── Park ──────────────────────────────────────────────────────────────────

/**
 * Split `/gsd park` arguments into a milestone ID and a free-text reason. The
 * first token is the ID only when it looks like one, so `/gsd park "why"`
 * still parks the active milestone.
 */
export function parseParkArguments(arg: string): { targetId: string; reason: string } {
  const trimmed = arg.trim();
  const [first = "", ...rest] = trimmed.split(/\s+/);
  const hasId = MILESTONE_ID_RE.test(first);
  const reasonText = hasId ? rest.join(" ") : trimmed;
  return {
    targetId: hasId ? first : "",
    reason: reasonText.trim().replace(/^["']|["']$/g, ""),
  };
}

/**
 * Park a milestone — creates a PARKED.md marker file with reason and timestamp.
 * Parked milestones are skipped during active-milestone discovery but stay on disk.
 * Returns true if successfully parked, false if milestone not found, already parked, or complete.
 * Throws when the database refuses the park, after removing the marker, so a
 * failed park is never reported as success.
 */
export function parkMilestone(
  basePath: string,
  milestoneId: string,
  reason: string,
  actorType: "user" | "agent" = "user",
): boolean {
  assertNotAutoActive("park milestone");
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (!mDir || !existsSync(mDir)) return false;

  // Guard: do not park a completed milestone — it would corrupt depends_on satisfaction
  const dbAvailable = isDbAvailable();
  const milestone = dbAvailable ? getMilestone(milestoneId) : null;
  if (milestone && isClosedStatus(milestone.status)) return false;
  if (!dbAvailable) {
    const summaryFile = resolveMilestoneFile(basePath, milestoneId, "SUMMARY");
    if (summaryFile) return false;
  }

  // Use relMilestoneFile for layout-aware path (legacy: M001-PARKED.md, flat-phase: 01-PARKED.md)
  const parkedPath = join(basePath, relMilestoneFile(basePath, milestoneId, "PARKED"));
  if (existsSync(parkedPath)) return false; // already parked

  const content = [
    "---",
    `parked_at: ${new Date().toISOString()}`,
    `reason: "${reason.replace(/"/g, '\\"')}"`,
    "---",
    "",
    `# ${milestoneId} — Parked`,
    "",
    `> ${reason}`,
    "",
  ].join("\n");

  atomicWriteSync(parkedPath, content, "utf-8");
  // Sync DB status so deriveStateFromDb also skips this milestone (#2694)
  if (dbAvailable) {
    try {
      const canonicalStatus = readMilestoneLifecycleStatus(milestoneId);
      if (canonicalStatus === null) {
        updateMilestoneStatus(milestoneId, "parked");
      } else if (canonicalStatus !== "paused") {
        parkMilestoneLifecycle({
          invocation: milestoneActionInvocation("park", milestoneId, actorType),
          milestoneId,
          reason,
        });
      }
    } catch (err) {
      removeProjectionFileSync(parkedPath);
      invalidateAllCaches();
      throw new GSDError(
        GSD_STALE_STATE,
        `parkMilestone: could not park ${milestoneId}: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }
  invalidateAllCaches();
  return true;
}

// ─── Unpark ────────────────────────────────────────────────────────────────

/**
 * Unpark a milestone — removes the PARKED.md marker file.
 * Returns true if successfully unparked, false if milestone not found or not parked.
 * Throws, leaving the marker in place, when the database refuses the unpark.
 */
export function unparkMilestone(
  basePath: string,
  milestoneId: string,
  actorType: "user" | "agent" = "user",
): boolean {
  assertNotAutoActive("unpark milestone");
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (!mDir || !existsSync(mDir)) return false;

  // Use relMilestoneFile for layout-aware path (legacy: M001-PARKED.md, flat-phase: 01-PARKED.md)
  const parkedPath = join(basePath, relMilestoneFile(basePath, milestoneId, "PARKED"));
  const hadParkedFile = existsSync(parkedPath);
  const dbThinksParked = isDbAvailable() && getMilestone(milestoneId)?.status === "parked";

  // Recover the reverse desync too: DB can still say "parked" even when the
  // PARKED marker was lost on disk, and /gsd unpark should repair that state.
  if (!hadParkedFile && !dbThinksParked) return false;

  // Sync DB status so deriveStateFromDb picks up the unparked milestone (#2694).
  // The DB goes first: if it refuses, the marker stays and the milestone is
  // still parked rather than half-resumed.
  if (isDbAvailable()) {
    try {
      const canonicalStatus = readMilestoneLifecycleStatus(milestoneId);
      if (canonicalStatus === null) {
        updateMilestoneStatus(milestoneId, "active");
      } else if (canonicalStatus === "paused") {
        unparkMilestoneLifecycle({
          invocation: milestoneActionInvocation("unpark", milestoneId, actorType),
          milestoneId,
        });
      }
    } catch (err) {
      throw new GSDError(
        GSD_STALE_STATE,
        `unparkMilestone: could not unpark ${milestoneId}: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }
  if (hadParkedFile) {
    removeProjectionFileSync(parkedPath);
  }
  invalidateAllCaches();
  return true;
}

// ─── Cancel ────────────────────────────────────────────────────────────────

/**
 * Cancel a milestone — abandons it and its unfinished slices and tasks while
 * keeping every record, so adopted canonical lifecycle history survives.
 * Returns false if the milestone is not found or already closed. Throws when
 * the database refuses, for example while an Attempt is still running.
 */
export function cancelMilestone(
  basePath: string,
  milestoneId: string,
  reason: string,
  actorType: "user" | "agent" = "user",
): boolean {
  assertNotAutoActive("cancel milestone");
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new GSDError(GSD_STALE_STATE, `cancelMilestone: a reason is required to cancel ${milestoneId}`);
  }
  if (!isDbAvailable()) {
    throw new GSDError(GSD_STALE_STATE, `cancelMilestone: database unavailable, cannot cancel ${milestoneId}`);
  }
  const milestone = getMilestone(milestoneId);
  if (!milestone || isClosedStatus(milestone.status)) return false;

  try {
    cancelMilestoneLifecycle({
      invocation: milestoneActionInvocation("cancel", milestoneId, actorType),
      milestoneId,
      reason: trimmedReason,
    });
  } catch (err) {
    throw new GSDError(
      GSD_STALE_STATE,
      `cancelMilestone: could not cancel ${milestoneId}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const parkedFile = resolveMilestoneFile(basePath, milestoneId, "PARKED");
  if (parkedFile) removeProjectionFileSync(parkedFile);
  invalidateAllCaches();
  return true;
}

// ─── Discard ───────────────────────────────────────────────────────────────

/**
 * Discard a milestone — permanently removes the milestone directory and
 * prunes it from QUEUE-ORDER.json if present.
 * Returns true if successfully discarded, false if milestone not found.
 */
export function discardMilestone(basePath: string, milestoneId: string): boolean {
  assertNotAutoActive("discard milestone");
  const mDir = resolveMilestonePath(basePath, milestoneId);
  const hasMilestoneDir = !!mDir && existsSync(mDir);
  const hasDbMilestone = isDbAvailable() && getMilestone(milestoneId) !== null;
  if (!hasMilestoneDir && !hasDbMilestone) return false;
  if (hasDbMilestone) {
    try {
      assertNoAdoptedLifecycleHistory("discardMilestone", [milestoneId]);
    } catch (err) {
      throw new GSDError(
        GSD_STALE_STATE,
        `${(err as Error).message}. ${milestoneId} keeps its history; run /gsd park ${milestoneId} to take it out of the queue, or /gsd cancel ${milestoneId} to abandon it.`,
        { cause: err },
      );
    }
  }

  try {
    removeWorktree(basePath, milestoneId, {
      branch: autoWorktreeBranch(basePath, milestoneId),
      deleteBranch: true,
    });
  } catch (err) {
    logWarning("engine", `discardMilestone worktree cleanup failed for ${milestoneId}: ${(err as Error).message}`);
  }
  // A milestone named but never entered has no branch for removeWorktree to
  // delete, so it never reaches forgetMilestoneBranchIfDeleted through that
  // path — check directly or the record outlives the milestone and blocks
  // reuse of its ID.
  forgetMilestoneBranchIfDeleted(basePath, milestoneId);

  if (hasMilestoneDir && mDir) {
    removeManagedProjectionTreeExactSync(basePath, mDir);
  }

  // Prune from queue order if present
  const order = loadQueueOrder(basePath);
  if (order && order.includes(milestoneId)) {
    saveQueueOrder(basePath, order.filter(id => id !== milestoneId));
  }

  if (isDbAvailable()) {
    try {
      deleteMilestone(milestoneId);
    } catch (err) {
      logWarning("engine", `discardMilestone DB cleanup failed for ${milestoneId}: ${(err as Error).message}`);
    }
  } else {
    logWarning("engine", `discardMilestone DB cleanup skipped for ${milestoneId}: database unavailable`);
  }

  invalidateAllCaches();
  return true;
}

// ─── Query ─────────────────────────────────────────────────────────────────

/**
 * Check whether a milestone is parked (PARKED.md exists).
 */
export function isParked(basePath: string, milestoneId: string): boolean {
  return !!resolveMilestoneFile(basePath, milestoneId, "PARKED");
}

/**
 * Read the park reason from PARKED.md frontmatter.
 * Returns null if the milestone is not parked or the reason can't be extracted.
 */
export function getParkedReason(basePath: string, milestoneId: string): string | null {
  const parkedFile = resolveMilestoneFile(basePath, milestoneId, "PARKED");
  if (!parkedFile) return null;

  try {
    const content = readFileSync(parkedFile, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const reasonMatch = match[1].match(/reason:\s*"([^"]*?)"/);
    return reasonMatch ? reasonMatch[1] : null;
  } catch {
    return null;
  }
}
