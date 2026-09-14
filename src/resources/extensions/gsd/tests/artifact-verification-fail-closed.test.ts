// Project/App: gsd-pi
// File Purpose: verifyExpectedArtifact must fail closed when a check errors (#17).

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { verifyExpectedArtifact } from "../auto-recovery.ts";
import { resolveExpectedArtifactPath } from "../auto-artifact-paths.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function createFixtureBase(prefix: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(base);
  mkdirSync(join(base, ".gsd", "phases"), { recursive: true });
  return base;
}

/** The path verifyExpectedArtifact will actually read for a plan-slice unit. */
function slicePlanPath(base: string, milestoneId: string, sliceId: string): string {
  const path = resolveExpectedArtifactPath("plan-slice", `${milestoneId}/${sliceId}`, base);
  assert.ok(path, "fixture must resolve a plan-slice artifact path");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

test("plan-slice fails verification when its PLAN cannot be read", () => {
  // The catch around the plan-slice task check fell through to the terminal
  // `return true`, so an unreadable PLAN verified the unit. Here the PLAN path
  // is a directory, so readFileSync throws EISDIR after existsSync passes.
  const base = createFixtureBase("gsd-artifact-failclosed-plan-");
  mkdirSync(slicePlanPath(base, "M001", "S01"), { recursive: true });

  assert.equal(
    verifyExpectedArtifact("plan-slice", "M001/S01", base),
    false,
    "an unreadable PLAN must fail verification, not pass it",
  );
});

test("gate-evaluate fails verification when the gate table cannot be queried", () => {
  const base = createFixtureBase("gsd-artifact-failclosed-gate-");
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const adapter = _getAdapter();
  assert.ok(adapter);
  // Make getPendingGatesForTurn throw the way a corrupt/migrating store would.
  adapter.exec("DROP TABLE quality_gates");

  assert.equal(
    verifyExpectedArtifact("gate-evaluate", "M001/S01/T01+G1,G2", base),
    false,
    "an unreadable gate table is not evidence that the gates were evaluated",
  );
});

test("plan-slice still verifies a readable plan whose task artifacts exist", () => {
  const base = createFixtureBase("gsd-artifact-failclosed-ok-");
  writeFileSync(
    slicePlanPath(base, "M001", "S01"),
    ["# S01 Plan", "", "<tasks>", "- [ ] **T01** — do the thing", "</tasks>", ""].join("\n"),
    "utf-8",
  );

  assert.equal(verifyExpectedArtifact("plan-slice", "M001/S01", base), true);
});
