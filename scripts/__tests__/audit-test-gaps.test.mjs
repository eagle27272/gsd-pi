import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runAudit(args) {
  const result = spawnSync(process.execPath, ["scripts/audit-test-gaps.mjs", ...args], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return result;
}

test("audit:test-gaps --strict-unwired passes on the current tree", () => {
  const result = runAudit(["--strict-unwired"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("audit:test-gaps buckets the vendored pi corpora out of the default npm test", () => {
  const result = runAudit(["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);

  assert.ok(report.byRunner["vendored-upstream"].count > 0);
  assert.ok(report.byRunner["verify-merge"].count > 0);
  for (const file of report.byRunner["vendored-upstream"].files) {
    assert.match(file, /^packages\/(pi-agent-core|pi-coding-agent|pi-tui)\/test\//);
  }
  for (const file of report.byRunner["verify-merge"].files) {
    assert.match(file, /^packages\/pi-ai\/test\//);
  }

  const notInNpmTest = new Set(report.byRunner["vendored-upstream"].files);
  assert.equal(
    report.summary.inNpmTest + report.summary.notInNpmTest,
    report.summary.totalTestFiles,
  );
  assert.ok(
    report.summary.notInNpmTest >= notInNpmTest.size,
    "vendored corpora must count as outside the default npm test",
  );
});

test("audit:test-gaps --json reports acknowledged unrun tests with reasons", () => {
  const result = runAudit(["--json"]);
  const report = JSON.parse(result.stdout);

  assert.ok(report.acknowledgedUnrunTests.length > 0);
  for (const entry of report.acknowledgedUnrunTests) {
    assert.ok(entry.path, "entry needs a path");
    assert.ok(entry.reason.length > 40, `${entry.path} needs a substantive reason`);
  }
  assert.ok(
    report.acknowledgedUnrunTests.some((e) => e.path === "packages/db/tests/schema.test.ts"),
    "packages/db test should be recorded, not hidden",
  );
});

test("audit:test-gaps human output surfaces the acknowledged unrun buckets", () => {
  const result = runAudit([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Acknowledged unrun tests/);
  assert.match(result.stdout, /vendored-upstream: \d+ file/);
  assert.match(result.stdout, /ADR-010/);
});
