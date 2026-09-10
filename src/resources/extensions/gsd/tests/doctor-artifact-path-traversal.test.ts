// GSD Extension — Regression test for #3: doctor surfaces artifacts rows whose
// path escapes the projection root. Those rows predate the write-boundary
// invariant and cannot self-heal: readers resolving via the clean key miss the
// content, and a bulk delete of `path LIKE '../%'` destroys rows that are the
// only record of their artifact.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkEngineHealth } from "../doctor-engine-checks.ts";
import { openDatabase, closeDatabase, _getAdapter } from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";
import type { DoctorIssue } from "../doctor-types.ts";

const TRAVERSAL_PATH = "../../elsewhere/repo/.gsd/phases/01-example/01-01-PLAN.md";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-traversal-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}

/**
 * Rows like this can no longer be created through insertArtifact, so seed the
 * table directly to model a project affected before the invariant landed.
 */
function seedRawArtifactRow(path: string): void {
  _getAdapter()!
    .prepare(
      `INSERT INTO artifacts (path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at, content_hash)
       VALUES (:path, 'PLAN', 'M001', 'S01', NULL, '# plan', '2026-09-10T00:00:00.000Z', 'abc')`,
    )
    .run({ ":path": path });
}

describe("gsd_doctor artifacts.path traversal check (#3)", () => {
  let base: string;

  afterEach(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    try { invalidateAllCaches(); } catch { /* ignore */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("reports an escaping artifacts.path row", async () => {
    base = makeBase();
    seedRawArtifactRow(TRAVERSAL_PATH);

    const issues: DoctorIssue[] = [];
    await checkEngineHealth(base, issues, []);

    const issue = issues.find(i => i.code === "artifact_path_escapes_projection_root");
    assert.ok(issue, "should report artifact_path_escapes_projection_root");
    assert.equal(issue?.severity, "error");
    assert.equal(issue?.fixable, false, "repair needs per-row reconciliation against disk");
    assert.ok(issue?.message.includes(TRAVERSAL_PATH), "message should name the offending path");
  });

  it("does not report projection-relative artifact paths", async () => {
    base = makeBase();
    seedRawArtifactRow("phases/01-example/01-01-PLAN.md");

    const issues: DoctorIssue[] = [];
    await checkEngineHealth(base, issues, []);

    assert.equal(
      issues.some(i => i.code === "artifact_path_escapes_projection_root"),
      false,
    );
  });
});
