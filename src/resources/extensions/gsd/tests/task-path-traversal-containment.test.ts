// GSD Extension — Regression test for #9: a model-supplied slice_id/task_id is
// interpolated into a flat-phase artifact file name and joined onto the phase
// directory. Without a guard the joined path escapes the project entirely, so
// every path builder that consumes those ids must refuse the input rather than
// hand an out-of-tree absolute path to a caller that writes it.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, isAbsolute, relative } from "node:path";
import { tmpdir } from "node:os";

import {
  buildFlatTaskFileName,
  buildSliceFileName,
  clearPathCache,
  relTaskFile,
  targetSliceFile,
  targetTaskFile,
} from "../paths.ts";
import { openDatabase, closeDatabase } from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";

const TRAVERSING_ID = "../../../../../../../../../tmp/pwned";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-path-traversal-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}

function isInside(base: string, candidate: string): boolean {
  // realpath the root so a symlinked tmpdir (/var → /private/var on macOS) is
  // compared in the same namespace as the builder's output.
  const rel = relative(realpathSync(base), candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

describe("flat-phase task path containment (#9)", () => {
  let base: string;

  afterEach(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    try { invalidateAllCaches(); } catch { /* ignore */ }
    try { clearPathCache(); } catch { /* ignore */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("buildFlatTaskFileName rejects a task id carrying a path separator", () => {
    base = makeBase();
    assert.throws(
      () => buildFlatTaskFileName("S01", TRAVERSING_ID, "SUMMARY"),
      /not a valid path segment/,
    );
  });

  it("buildFlatTaskFileName rejects a slice id carrying a path separator", () => {
    base = makeBase();
    assert.throws(
      () => buildFlatTaskFileName(TRAVERSING_ID, "T01", "SUMMARY"),
      /not a valid path segment/,
    );
  });

  it("buildFlatTaskFileName rejects a bare '..' id", () => {
    base = makeBase();
    assert.throws(() => buildFlatTaskFileName("S01", "..", "SUMMARY"), /not a valid path segment/);
  });

  it("buildSliceFileName rejects a slice id carrying a path separator", () => {
    base = makeBase();
    assert.throws(
      () => buildSliceFileName(TRAVERSING_ID, "PLAN"),
      /not a valid path segment/,
    );
  });

  it("targetTaskFile refuses a traversing task id instead of returning an out-of-tree path", () => {
    base = makeBase();
    assert.throws(
      () => targetTaskFile(base, "M001", "S01", TRAVERSING_ID, "SUMMARY"),
      /not a valid path segment/,
    );
  });

  it("targetTaskFile refuses a traversing slice id instead of returning an out-of-tree path", () => {
    base = makeBase();
    assert.throws(
      () => targetTaskFile(base, "M001", TRAVERSING_ID, "T01", "SUMMARY"),
      /not a valid path segment/,
    );
  });

  it("targetSliceFile refuses a traversing slice id instead of returning an out-of-tree path", () => {
    base = makeBase();
    assert.throws(
      () => targetSliceFile(base, "M001", TRAVERSING_ID, "PLAN"),
      /not a valid path segment/,
    );
  });

  it("relTaskFile refuses a traversing task id instead of emitting an escaping .gsd/ key", () => {
    base = makeBase();
    assert.throws(
      () => relTaskFile(base, "M001", "S01", TRAVERSING_ID, "SUMMARY"),
      /not a valid path segment/,
    );
  });

  it("keeps canonical ids working and inside the project", () => {
    base = makeBase();
    const abs = targetTaskFile(base, "M001", "S01", "T01", "SUMMARY");
    assert.ok(abs.endsWith("S01-T01-SUMMARY.md"), abs);
    assert.ok(isInside(base, abs), `${abs} should stay under ${base}`);
  });

  it("keeps the redundant S##- task-id prefix collapsing", () => {
    base = makeBase();
    assert.equal(buildFlatTaskFileName("S06", "S06-T03", "SUMMARY"), "S06-T03-SUMMARY.md");
  });

  it("keeps non-canonical remediation slice ids working", () => {
    base = makeBase();
    assert.equal(buildFlatTaskFileName("R01", "T02", "SUMMARY"), "R01-T02-SUMMARY.md");
    const abs = targetSliceFile(base, "M001", "R01", "PLAN");
    assert.ok(isInside(base, abs), `${abs} should stay under ${base}`);
  });

  it("keeps slice ids with descriptive suffixes working", () => {
    base = makeBase();
    assert.equal(buildFlatTaskFileName("S01-replan", "T01", "SUMMARY"), "S01-replan-T01-SUMMARY.md");
  });
});
