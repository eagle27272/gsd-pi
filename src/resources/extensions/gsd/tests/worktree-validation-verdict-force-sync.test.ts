// Project/App: gsd-pi
// File Purpose: Pins the VALIDATION arm of forceOverwriteVerdictArtifacts.
//
// forceOverwriteVerdictArtifacts force-copies project-root artifacts matching
// /-(ASSESSMENT|VALIDATION)\.md$/ that carry a `verdict:` over the worktree
// copies the additive phase merge (force:false, #1886) refuses to touch.
// The ASSESSMENT arm is pinned by uat-stuck-loop-orphaned-worktree.test.ts;
// narrowing the regex to ASSESSMENT-only left the whole worktree/uat/validate
// suite green, so the VALIDATION arm defended nothing. These tests close that.
//
// A milestone VALIDATION.md is flat-phase NN-VALIDATION.md. A stale FAIL in the
// worktree is what auto-mode's closeout gate reads, so a project-root PASS that
// never crosses the boundary re-runs validate-milestone indefinitely.
//
// Only the first test kills the ASSESSMENT-only mutation: the additive merge
// already copies a file the worktree lacks, and the verdictless case is a
// no-op either way. Overwriting a stale worktree verdict is the arm that is
// exclusively this function's job.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { syncProjectRootToWorktree } from "../auto-worktree-sync.ts";
import { canonicalPhaseDirName, LAYOUT_SEGMENTS } from "../layout-policy.ts";

const MILESTONE_ID = "M011";
const PHASE_DIR = canonicalPhaseDirName(MILESTONE_ID);
const VALIDATION_FILE = "11-VALIDATION.md";

function makePair(t: { after: (fn: () => void) => void }): { mainBase: string; wtBase: string } {
  const mainBase = mkdtempSync(join(tmpdir(), "gsd-validation-sync-main-"));
  const wtBase = mkdtempSync(join(tmpdir(), "gsd-validation-sync-wt-"));
  t.after(() => {
    rmSync(mainBase, { recursive: true, force: true });
    rmSync(wtBase, { recursive: true, force: true });
  });
  for (const base of [mainBase, wtBase]) {
    mkdirSync(join(base, ".gsd", LAYOUT_SEGMENTS.level1, PHASE_DIR), { recursive: true });
  }
  return { mainBase, wtBase };
}

function validationPath(base: string): string {
  return join(base, ".gsd", LAYOUT_SEGMENTS.level1, PHASE_DIR, VALIDATION_FILE);
}

test("force-syncs VALIDATION with a verdict over a stale worktree copy", (t) => {
  const { mainBase, wtBase } = makePair(t);

  writeFileSync(
    validationPath(mainBase),
    "---\nverdict: pass\n---\n# M011 Validation\nAll gates green.\n",
  );
  writeFileSync(
    validationPath(wtBase),
    "---\nverdict: fail\n---\n# M011 Validation\nGate 3 failed.\n",
  );

  syncProjectRootToWorktree(mainBase, wtBase, MILESTONE_ID);

  const content = readFileSync(validationPath(wtBase), "utf-8");
  assert.match(
    content,
    /verdict: pass/,
    "the project-root PASS verdict must reach the worktree; the additive merge alone will not overwrite it",
  );
});

test("copies VALIDATION with a verdict when the worktree has none", (t) => {
  const { mainBase, wtBase } = makePair(t);

  writeFileSync(validationPath(mainBase), "---\nverdict: pass\n---\n# M011 Validation\n");

  syncProjectRootToWorktree(mainBase, wtBase, MILESTONE_ID);

  assert.match(readFileSync(validationPath(wtBase), "utf-8"), /verdict: pass/);
});

test("does NOT overwrite a worktree VALIDATION when the project root has no verdict", (t) => {
  const { mainBase, wtBase } = makePair(t);

  writeFileSync(validationPath(mainBase), "# M011 Validation\nIn progress...\n");
  writeFileSync(
    validationPath(wtBase),
    "---\nverdict: fail\n---\n# M011 Validation\nGate 3 failed.\n",
  );

  syncProjectRootToWorktree(mainBase, wtBase, MILESTONE_ID);

  assert.match(
    readFileSync(validationPath(wtBase), "utf-8"),
    /verdict: fail/,
    "a verdictless project-root copy must never clobber a worktree verdict",
  );
});
