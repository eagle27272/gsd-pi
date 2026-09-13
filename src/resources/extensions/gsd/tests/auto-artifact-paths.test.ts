import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveExpectedArtifactPath, resolveSliceResearchLocation, resolveExistingSliceResearchPath } from "../auto-artifact-paths.ts";
import { clearPathCache, _clearGsdRootCache, milestonesDir } from "../paths.ts";

// ── #852 follow-up: a stray milestones/<MID>/ must not divert resolution ──
//
// Older git-service.ts wrote <MID>-META.json into milestones/<MID>/ even in
// flat-phase projects. Resolution must stay on phases/NN-slug/ regardless of
// what is sitting in a leftover milestones/ tree — otherwise verification looks
// for milestones/<MID>/<MID>-CONTEXT.md (which never exists in a flat-phase
// project), trapping the unit in a finalize-retry loop.

test("a stray milestones/<MID>/ does not divert artifact resolution (#852)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-meta-pollution-")));
  try {
    const gsd = join(root, ".gsd");
    // Flat-phase layout: phases/15-m015/ with real content.
    const phaseDir = join(gsd, "phases", "15-m015");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "15-CONTEXT.md"), "# context\n");

    // Pollution: git-service.ts creates milestones/M015/ for META.json only.
    const metaDir = join(gsd, "milestones", "M015");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "M015-META.json"), '{"branch":"milestone/M015"}');

    _clearGsdRootCache();
    clearPathCache();

    assert.ok(milestonesDir(root).endsWith(join(".gsd", "phases")), "milestonesDir resolves to phases/ not milestones/");

    // And the discuss-milestone CONTEXT artifact must resolve to the flat-phase path.
    assert.equal(
      resolveExpectedArtifactPath("discuss-milestone", "M015", root),
      join(phaseDir, "15-CONTEXT.md"),
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #852 follow-up: the EXACT failure path that survived #858 ────────────────
//
// resolveMilestoneArtifactPath used to consult a project-root milestones/ lookup
// before the flat-phase resolution. With a flat-phase project + a META-only
// milestones/M015/ dir (created by an older git-service.ts), that early return
// produced milestones/M015/M015-CONTEXT.md (never exists) instead of
// phases/15-m015/15-CONTEXT.md — reproducing the production loop:
//   verify-fail discuss-milestone M015: existsSync false for
//     .../milestones/M015/M015-CONTEXT.md

test("a META-only milestones/ dir never wins over the flat-phase dir (#852 follow-up to #858)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-meta-bypass-")));
  try {
    const gsd = join(root, ".gsd");

    // Flat-phase layout: phases/15-m015/ with real CONTEXT content.
    const phaseDir = join(gsd, "phases", "15-m015");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "15-CONTEXT.md"), "# M015 context\n");

    // Pollution: git-service.ts:450 created milestones/M015/ for META only.
    // This is the dir that previously flipped the early-return to legacy.
    const metaDir = join(gsd, "milestones", "M015");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "M015-META.json"), '{"branch":"milestone/M015"}');

    _clearGsdRootCache();
    clearPathCache();

    const resolved = resolveExpectedArtifactPath("discuss-milestone", "M015", root);

    // MUST resolve to the flat-phase path, NOT the legacy META-only path.
    assert.equal(
      resolved,
      join(phaseDir, "15-CONTEXT.md"),
      "META-only milestones/M015/ must not produce the legacy path; flat-phase wins",
    );
    // Explicitly assert the bug does NOT reproduce — the legacy path is wrong.
    assert.notEqual(
      resolved,
      join(metaDir, "M015-CONTEXT.md"),
      "must NOT resolve to the legacy milestones/M015/M015-CONTEXT.md path",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a META-only milestones/ dir resolves to null when phases/ has no matching dir yet", () => {
  // The worktree/early-run edge case: phases/ doesn't exist yet (or doesn't have
  // 15-m015/), but milestones/M015/ exists with only META. The resolver must
  // return null (file genuinely not found yet) rather than the wrong legacy
  // path — so the caller reports a clear "missing" instead of looping on a
  // path that will never exist.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-meta-no-phase-")));
  try {
    const metaDir = join(root, ".gsd", "milestones", "M015");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "M015-META.json"), '{"branch":"milestone/M015"}');
    // Note: no phases/ dir at all.

    _clearGsdRootCache();
    clearPathCache();

    const resolved = resolveExpectedArtifactPath("discuss-milestone", "M015", root);
    // Must not produce the legacy path; null or a non-legacy path is correct.
    assert.ok(
      resolved === null || !resolved.includes(join("milestones", "M015")),
      `META-only dir with no phases/ must not resolve to legacy; got: ${resolved}`,
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #852: flat-phase dir must get flat-phase filename, not legacy ─────────────
//
// The most insidious variant: the resolver found the correct flat-phase
// directory (phases/15-m015/), but the old code built the milestone-id-prefixed
// filename (M015-CONTEXT.md) unconditionally — producing
// existsSync-false for phases/15-m015/M015-CONTEXT.md. The file is named
// 15-CONTEXT.md. This test guards the layout-aware filename for ALL branches.

test("flat-phase worktree dir resolves to 15-CONTEXT.md not M015-CONTEXT.md (#852)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-filename-layout-")));
  try {
    const gsd = join(root, ".gsd");
    // Flat-phase layout: phases/15-m015/ with the correctly-named file.
    const phaseDir = join(gsd, "phases", "15-m015");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "15-CONTEXT.md"), "# M015 context\n");

    _clearGsdRootCache();
    clearPathCache();

    const resolved = resolveExpectedArtifactPath("discuss-milestone", "M015", root);

    // MUST use the flat-phase filename, not the legacy one.
    assert.equal(
      resolved,
      join(phaseDir, "15-CONTEXT.md"),
      "flat-phase dir must use 15-CONTEXT.md (phase-number prefix)",
    );
    assert.notEqual(
      resolved,
      join(phaseDir, "M015-CONTEXT.md"),
      "must NOT use M015-CONTEXT.md (legacy milestone-id prefix) for a flat-phase dir",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("flat-phase project-root dir resolves to 15-ROADMAP.md not M015-ROADMAP.md (#852)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-filename-roadmap-")));
  try {
    const gsd = join(root, ".gsd");
    const phaseDir = join(gsd, "phases", "16-m016");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "16-ROADMAP.md"), "# M016 roadmap\n");

    _clearGsdRootCache();
    clearPathCache();

    const resolved = resolveExpectedArtifactPath("plan-milestone", "M016", root);
    assert.equal(
      resolved,
      join(phaseDir, "16-ROADMAP.md"),
      "flat-phase dir must use 16-ROADMAP.md (phase-number prefix)",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── cursor[bot] 3523932401: bare milestone id must not match a team-suffix ────
//
// A bare milestone id (M001, no team-mode suffix) resolves its phase dir by
// scanning phases/NN-*. Before the guard (commit 8f45bf3),
// phaseDirMatchesMilestoneId returned true for ANY same-number dir, so a
// leftover team-mode projection (phases/01-<6char>-.../, from a prior
// team-suffixed run) matched the bare id too. When that stale dir carried a
// newer mtime, pickPreferredPhaseDir selected it over the real title dir and
// resolved the ROADMAP into a directory that has no ROADMAP — the file-not-found
// retry loop. The guard (slugLooksLikeTeamSuffixProjection) rejects
// team-suffix-looking slugs for bare ids in the primary pass; the suffixed
// projection stays available only as a fallback when the primary pass finds
// nothing (#1195, guarded by the second test below).

test("bare milestone id prefers the real title dir over a newer team-suffix projection (cursor 3523932401)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-bare-teamsuffix-")));
  try {
    const phasesDir = join(root, ".gsd", "phases");
    // Intended flat-phase dir for the bare id: 01-<title-slug>/ with the ROADMAP.
    const intendedDir = join(phasesDir, "01-clean-continuation");
    mkdirSync(intendedDir, { recursive: true });
    writeFileSync(join(intendedDir, "01-ROADMAP.md"), "# roadmap\n");

    // Leftover team-mode projection: 01-<6char>-.../ with NO ROADMAP, made
    // NEWER so an mtime tiebreak would wrongly prefer it without the guard.
    const staleDir = join(phasesDir, "01-re4q3k-old-team-projection");
    mkdirSync(staleDir, { recursive: true });
    const newer = new Date(Date.now() + 60_000);
    const older = new Date(Date.now() - 60_000);
    utimesSync(staleDir, newer, newer);
    utimesSync(intendedDir, older, older);

    _clearGsdRootCache();
    clearPathCache();

    const resolved = resolveExpectedArtifactPath("plan-milestone", "M001", root);
    assert.equal(
      resolved,
      join(intendedDir, "01-ROADMAP.md"),
      "bare id must resolve to the real title dir, not the newer team-suffix projection",
    );
    assert.notEqual(
      resolved,
      join(staleDir, "01-ROADMAP.md"),
      "must NOT resolve into the team-suffix projection dir that has no ROADMAP",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare milestone id still falls back to a lone team-suffix projection (#1195)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-bare-teamsuffix-only-")));
  try {
    const phasesDir = join(root, ".gsd", "phases");
    // The only on-disk dir for the bare id is a team-mode projection. With no
    // non-suffixed candidate, the fallback pass must still resolve to it.
    const onlyDir = join(phasesDir, "01-re4q3k-clean-continuation");
    mkdirSync(onlyDir, { recursive: true });
    writeFileSync(join(onlyDir, "01-ROADMAP.md"), "# roadmap\n");

    _clearGsdRootCache();
    clearPathCache();

    const resolved = resolveExpectedArtifactPath("plan-milestone", "M001", root);
    assert.equal(
      resolved,
      join(onlyDir, "01-ROADMAP.md"),
      "with no non-suffixed dir, the team-suffix projection is the correct fallback",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #1208: flat-phase execute-task summaries resolve at the phase root ────────
//
// In flat-phase layout task summaries are written beside the plan files
// (phases/<phase>/S##-T##-SUMMARY.md), NOT under a tasks/ subdir. A tasks/ dir
// may still exist to hold auxiliary task-scoped gate artifacts (e.g. T01-VERIFY.json).
// Before the fix, the mere existence of that tasks/ dir redirected summary
// verification into tasks/S##-T##-SUMMARY.md — which never exists — trapping
// auto-mode in a false verification retry after a successful task.

test("flat-phase execute-task summary resolves at phase root when no tasks/ dir exists (#1208)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-flat-task-summary-")));
  try {
    const gsd = join(root, ".gsd");
    const phaseDir = join(gsd, "phases", "49-end-to-end-mandates");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "49-03-PLAN.md"), "# plan\n- [x] T02\n");

    _clearGsdRootCache();
    clearPathCache();

    assert.equal(
      resolveExpectedArtifactPath("execute-task", "M049/S03/T02", root),
      join(phaseDir, "S03-T02-SUMMARY.md"),
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("flat-phase execute-task summary resolves at phase root even when tasks/ dir holds gate artifacts (#1208)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-flat-task-tasksdir-")));
  try {
    const gsd = join(root, ".gsd");
    const phaseDir = join(gsd, "phases", "49-end-to-end-mandates");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "49-03-PLAN.md"), "# plan\n- [x] T02\n");
    // Auxiliary task-scoped gate artifact — creates the tasks/ dir but must not
    // redirect the T02 summary into tasks/.
    const tasksDir = join(phaseDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "T01-VERIFY.json"), '{"ok":true}');

    _clearGsdRootCache();
    clearPathCache();

    const resolved = resolveExpectedArtifactPath("execute-task", "M049/S03/T02", root);
    assert.equal(
      resolved,
      join(phaseDir, "S03-T02-SUMMARY.md"),
      "flat-phase task summary must resolve at the phase root, not tasks/",
    );
    assert.notEqual(
      resolved,
      join(tasksDir, "S03-T02-SUMMARY.md"),
      "a tasks/ dir with gate artifacts must NOT redirect summary resolution into tasks/",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});


// ── resolveSliceResearchLocation / resolveExistingSliceResearchPath ───────────
//
// The shared dual-path resolver for slice RESEARCH files (worktree projection
// first, then canonical path fallback). These guard: missing file → null pair;
// existing file → correct absolute and relative paths.

test("resolveSliceResearchLocation returns null pair when no RESEARCH file exists", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-research-missing-")));
  try {
    const phaseDir = join(root, ".gsd", "phases", "01-m001");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "01-01-PLAN.md"), "# plan\n");

    _clearGsdRootCache();
    clearPathCache();

    const result = resolveSliceResearchLocation(root, "M001", "S01");
    assert.strictEqual(result.absolutePath, null, "absolutePath must be null when no RESEARCH exists");
    assert.strictEqual(result.relativePath, null, "relativePath must be null when no RESEARCH exists");
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveExistingSliceResearchPath returns null when no RESEARCH file exists", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-research-null-")));
  try {
    const phaseDir = join(root, ".gsd", "phases", "01-m001");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "01-01-PLAN.md"), "# plan\n");

    _clearGsdRootCache();
    clearPathCache();

    assert.strictEqual(
      resolveExistingSliceResearchPath(root, "M001", "S01"),
      null,
      "must return null when RESEARCH file is absent",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSliceResearchLocation finds existing RESEARCH in the phase dir", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-research-flat-")));
  try {
    const phaseDir = join(root, ".gsd", "phases", "01-m001");
    mkdirSync(phaseDir, { recursive: true });
    const researchFile = join(phaseDir, "01-01-RESEARCH.md");
    writeFileSync(researchFile, "# slice research\n");

    _clearGsdRootCache();
    clearPathCache();

    const result = resolveSliceResearchLocation(root, "M001", "S01");
    assert.equal(result.absolutePath, researchFile, "absolutePath must point to the RESEARCH file");
    assert.ok(result.relativePath !== null, "relativePath must be non-null when RESEARCH exists");
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveExistingSliceResearchPath returns the absolute path when RESEARCH exists", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-research-existing-")));
  try {
    const phaseDir = join(root, ".gsd", "phases", "01-m001");
    mkdirSync(phaseDir, { recursive: true });
    const researchFile = join(phaseDir, "01-01-RESEARCH.md");
    writeFileSync(researchFile, "# research\n");

    _clearGsdRootCache();
    clearPathCache();

    assert.equal(
      resolveExistingSliceResearchPath(root, "M001", "S01"),
      researchFile,
      "must return the absolute path to the RESEARCH file",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #1933: reassess-roadmap verifies the milestone-scoped ROADMAP-ASSESSMENT ──
//
// gsd_reassess_roadmap writes <NN>-ROADMAP-ASSESSMENT.md (milestone-scoped).
// The verifier used to expect the slice-scoped <NN>-<SS>-ASSESSMENT.md, so the
// unit could never finalize and looped on "expected artifact not found".

test("reassess-roadmap expects the milestone-scoped ROADMAP-ASSESSMENT file (#1933)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-reassess-artifact-")));
  try {
    const phaseDir = join(root, ".gsd", "phases", "01-m001");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "01-ROADMAP.md"), "# M001 roadmap\n");
    writeFileSync(join(phaseDir, "01-ROADMAP-ASSESSMENT.md"), "# M001 Roadmap Assessment\n");

    _clearGsdRootCache();
    clearPathCache();

    assert.equal(
      resolveExpectedArtifactPath("reassess-roadmap", "M001/S01", root),
      join(phaseDir, "01-ROADMAP-ASSESSMENT.md"),
      "reassess-roadmap must verify the file gsd_reassess_roadmap writes, not a slice-scoped ASSESSMENT",
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});
