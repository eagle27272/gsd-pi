// Project/App: gsd-pi
// File Purpose: missing_slice_dir must actually fire in a sliced milestone (#17).
//
// The check tested `!resolveSlicePath(...)`, but that only returns null when
// resolveMilestonePath() does — and the loop already `continue`d on a null
// milestonePath with the same arguments. Otherwise resolveSlicePath() falls
// back to the phase dir, so the branch (and its --fix mkdir) was unreachable.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { checkGsdStateHealth } from "../doctor-state-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";

const PHASE_DIR = "01-m001-sliced";

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function phaseDir(base: string): string {
  return join(base, ".gsd", "phases", PHASE_DIR);
}

/**
 * Milestone with two active slices. `withSlicesRoot` controls the layout: a
 * slices/ root holding only S01 is the sliced layout with S02's directory
 * missing; no slices/ root at all is a legitimate flat-phase milestone.
 */
function makeBase(withSlicesRoot: boolean): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-missing-slice-dir-"));
  const phase = phaseDir(base);
  mkdirSync(phase, { recursive: true });

  writeFileSync(
    join(phase, "01-ROADMAP.md"),
    [
      "# M001: Sliced",
      "",
      "- [ ] **S01: First slice** `risk:medium` `depends:[]`",
      "- [ ] **S02: Second slice** `risk:medium` `depends:[S01]`",
      "",
    ].join("\n"),
  );
  writeFileSync(join(phase, "01-01-PLAN.md"), "# S01 Plan\n\n- [ ] **S01.T01**: First task\n");
  writeFileSync(join(phase, "01-02-PLAN.md"), "# S02 Plan\n\n- [ ] **S02.T01**: Second task\n");

  if (withSlicesRoot) mkdirSync(join(phase, "slices", "S01"), { recursive: true });
  return base;
}

function seed(): void {
  insertMilestone({ id: "M001", title: "Sliced", status: "active" });
  for (const [id, title, seq] of [["S01", "First slice", 1], ["S02", "Second slice", 2]] as const) {
    insertSlice({
      id, milestoneId: "M001", title, status: "active",
      risk: "medium", depends: [], demo: `${id} demo.`, sequence: seq,
    });
  }
}

async function runDoctor(base: string, fix: boolean): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  await checkGsdStateHealth(base, issues, [], { fix, shouldFix: () => fix });
  return issues;
}

test("a sliced milestone reports the slice whose slices/<SID>/ directory is missing", async (t) => {
  const base = makeBase(true);
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  seed();

  const reported = (await runDoctor(base, false)).filter((i) => i.code === "missing_slice_dir");
  assert.deepEqual(reported.map((i) => i.unitId), ["M001/S02"]);
  assert.equal(reported[0].severity, "error");
  assert.equal(reported[0].fixable, true);
  assert.match(reported[0].file ?? "", /slices\/S02$/);
});

test("--fix creates the missing slice directory", async (t) => {
  const base = makeBase(true);
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  seed();

  await runDoctor(base, true);
  assert.equal(existsSync(join(phaseDir(base), "slices", "S02")), true);
});

test("a flat-phase milestone has no slice directories to miss", async (t) => {
  const base = makeBase(false);
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  seed();

  const reported = (await runDoctor(base, false)).filter((i) => i.code === "missing_slice_dir");
  assert.deepEqual(reported.map((i) => i.unitId), []);
});
