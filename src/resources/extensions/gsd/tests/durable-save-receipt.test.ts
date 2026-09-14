// Project/App: gsd-pi
// File Purpose: Verify-after-write receipt checks for save-tool units (#1714/#1761).

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { _missingDurableSaveReceiptForTest } from "../auto-post-unit.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function openFixture(): void {
  const dir = mkdtempSync(join(tmpdir(), "gsd-save-receipt-"));
  tempDirs.add(dir);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(dir, ".gsd", "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Receipts', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Receipt slice', 'active', '2026-07-13T00:00:00.000Z');
  `);
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

const UNIT_STARTED_AT = Date.parse("2026-07-13T12:00:00.000Z");

function insertUatGate(status: string, evaluatedAt: string | null): void {
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status, evaluated_at)
    VALUES ('M001', 'S01', 'UAT', 'slice', '', :status, :evaluated_at)
  `).run({ ":status": status, ":evaluated_at": evaluatedAt });
}

test("run-uat without a persisted UAT gate row is an explicit error naming gsd_uat_result_save", () => {
  openFixture();
  const error = _missingDurableSaveReceiptForTest("run-uat", "M001/S01", UNIT_STARTED_AT);
  assert.ok(error);
  assert.match(error, /not durably persisted/);
  assert.match(error, /gsd_uat_result_save/);
});

test("run-uat with a UAT gate row evaluated during this unit passes the receipt check", () => {
  openFixture();
  insertUatGate("complete", "2026-07-13T12:00:30.000Z");
  assert.equal(_missingDurableSaveReceiptForTest("run-uat", "M001/S01", UNIT_STARTED_AT), null);
});

test("run-uat rejects a UAT gate row left over from a previous run of a reopened slice (#17)", () => {
  // UAT rows are only ever deleted at task or milestone scope, so a reopened
  // slice still carries its previous verdict. Presence alone satisfied the
  // receipt, so a run-uat unit that saved nothing at all was passed as verified.
  openFixture();
  insertUatGate("complete", "2026-07-13T09:00:00.000Z");
  const error = _missingDurableSaveReceiptForTest("run-uat", "M001/S01", UNIT_STARTED_AT);
  assert.ok(error);
  assert.match(error, /not durably persisted/);
  assert.match(error, /gsd_uat_result_save/);
});

test("run-uat rejects a UAT gate row that was never evaluated", () => {
  openFixture();
  insertUatGate("pending", null);
  assert.ok(_missingDurableSaveReceiptForTest("run-uat", "M001/S01", UNIT_STARTED_AT));
});

test("run-uat rejects a recently touched UAT gate row that is not complete", () => {
  openFixture();
  insertUatGate("pending", "2026-07-13T12:00:30.000Z");
  assert.ok(_missingDurableSaveReceiptForTest("run-uat", "M001/S01", UNIT_STARTED_AT));
});

test("validate-milestone without a persisted verdict names gsd_validate_milestone", () => {
  openFixture();
  const error = _missingDurableSaveReceiptForTest("validate-milestone", "M001", UNIT_STARTED_AT);
  assert.ok(error);
  assert.match(error, /not durably persisted/);
  assert.match(error, /gsd_validate_milestone/);
});

test("validate-milestone with a persisted verdict passes the receipt check", () => {
  openFixture();
  db().prepare(`
    INSERT INTO assessments (path, milestone_id, slice_id, task_id, status, scope, full_content)
    VALUES ('.gsd/milestones/M001/M001-VALIDATION.md', 'M001', NULL, NULL, 'pass', 'milestone-validation', '# Validation')
  `).run();
  assert.equal(_missingDurableSaveReceiptForTest("validate-milestone", "M001", UNIT_STARTED_AT), null);
});

test("other unit types have no save receipt to verify", () => {
  openFixture();
  assert.equal(_missingDurableSaveReceiptForTest("execute-task", "M001/S01/T01", UNIT_STARTED_AT), null);
});
