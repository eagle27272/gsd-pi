// gsd-pi — Auto-mode asks for the next milestone's branch name before entering it.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { AutoSession } from "../auto/session.ts";
import { runPreDispatch } from "../auto/pre-dispatch.ts";
import { autoWorktreeBranch, hasMilestoneBranchRecord } from "../milestone-branch-registry.ts";
import { makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

async function transitionToM002(
  repo: string,
  isolation: "none" | "branch",
  calls: string[],
  beforeAnswer?: () => void,
) {
  const s = new AutoSession();
  s.basePath = repo;
  s.originalBasePath = repo;
  s.currentMilestoneId = "M001";

  const state = {
    phase: "planning",
    activeMilestone: { id: "M002", title: "Billing" },
    activeSlice: null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "Plan M002",
    registry: [
      { id: "M001", title: "Done", status: "complete" },
      { id: "M002", title: "Billing", status: "active" },
    ],
  };

  return runPreDispatch({
    ctx: {
      hasUI: true,
      ui: {
        notify(message: string) {
          calls.push(`notify:${message}`);
        },
        input: async (title: string) => {
          calls.push(`prompt:${title}`);
          beforeAnswer?.();
          return "feat/billing";
        },
      },
    },
    pi: {},
    s,
    prefs: undefined,
    iteration: 1,
    flowId: "test-flow",
    nextSeq: () => 1,
    deps: {
      checkResourcesStale: () => null,
      invalidateAllCaches: () => {},
      preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
      syncProjectRootToWorktree: () => {},
      deriveState: async () => state,
      preflightCleanRoot: () => ({ ok: true, stashPushed: false }),
      postflightPopStash: () => ({ ok: true, needsManualRecovery: false }),
      resolver: { mergeAndExit: () => {} },
      lifecycle: {
        enterMilestone: (mid: string) => {
          calls.push(`enter:${mid}`);
          return { ok: true, mode: "branch", path: repo };
        },
        exitMilestone: (_mid: string, opts: { merge: boolean }) => ({ ok: true, merged: opts.merge, codeFilesChanged: false }),
      },
      sendDesktopNotification: () => {},
      getIsolationMode: () => isolation,
      captureIntegrationBranch: () => {},
      pruneQueueOrder: () => {},
      rebuildState: async () => {},
      setActiveMilestoneId: () => {},
      reconcileMergeState: () => "clean",
      emitJournalEvent: () => {},
      stopAuto: async () => {},
      pauseAuto: async () => {},
      closeoutUnit: async () => {},
      buildSnapshotOpts: () => ({}),
    },
  } as any, {
    consecutiveFinalizeTimeouts: 0,
  });
}

describe("milestone transition branch prompt", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo("gsd-ms-branch-transition-");
  });

  afterEach(() => {
    removeRepo(repo);
  });

  test("asks for the next milestone's branch name before entering it", async () => {
    const calls: string[] = [];
    await transitionToM002(repo, "branch", calls);
    assert.equal(autoWorktreeBranch(repo, "M002"), "feat/billing");
    const promptIndex = calls.findIndex((call) => call.startsWith("prompt:Branch name for M002 (Billing)"));
    assert.notEqual(promptIndex, -1, `prompt shown, calls: ${calls.join(" > ")}`);
    assert.ok(promptIndex < calls.indexOf("enter:M002"), `prompt before entry, calls: ${calls.join(" > ")}`);
  });

  test("does not ask when git isolation is none", async () => {
    const calls: string[] = [];
    await transitionToM002(repo, "none", calls);
    assert.equal(calls.some((call) => call.startsWith("prompt:")), false);
    assert.equal(hasMilestoneBranchRecord(repo, "M002"), false);
  });

  // A pre-existing (even corrupt) record short-circuits ensureMilestoneBranchName
  // before it ever reads the file's contents — hasMilestoneBranchRecord only
  // checks existence, matching the "a record means someone asked" contract. So
  // the read that can throw only fires if the record appears *during* the
  // prompt, e.g. a concurrent writer — reproduced here via the input callback.
  test("stops the transition instead of entering the milestone when the branch record turns unreadable mid-prompt", async () => {
    const recordDir = join(repo, ".gsd", "milestone-branches");

    const calls: string[] = [];
    const result = await transitionToM002(repo, "branch", calls, () => {
      mkdirSync(recordDir, { recursive: true });
      writeFileSync(join(recordDir, "M002.json"), "{not json");
    });
    assert.deepEqual(result, { action: "break", reason: "milestone-enter-failed" });
    assert.equal(calls.some((call) => call === "enter:M002"), false, `calls: ${calls.join(" > ")}`);
    assert.ok(
      calls.some((call) => /could not settle the branch name for M002/.test(call)),
      `calls: ${calls.join(" > ")}`,
    );
  });
});
