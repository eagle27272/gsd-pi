import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMatrix, collectTestFiles, strictMatrixFailures } from "../lib/test-audit-lib.mjs";

test("audit:test-matrix strict passes after P0 extension backfill", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["scripts/audit-test-matrix.mjs", "--strict"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || "matrix strict failed");
});

test("audit:test-matrix human output surfaces acknowledged unrun tests", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["scripts/audit-test-matrix.mjs"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Acknowledged unrun tests \(\d+\)/);
  assert.match(result.stdout, /vendored-upstream: \d+/);
});

test("audit:test-matrix counts reachable suite tests as indirect source coverage", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-test-matrix-"));
  mkdirSync(join(root, "src/tests"), { recursive: true });
  writeFileSync(join(root, "src/feature.ts"), "export const feature = true;\n");
  writeFileSync(
    join(root, "src/tests/feature-flow.test.ts"),
    "import test from 'node:test';\ntest('feature flow', () => {});\n",
  );

  const matrix = buildMatrix(root);
  assert.equal(matrix.summary.untested, 0);
  assert.equal(matrix.summary.criticalUntested, 0);
  assert.equal(matrix.summary.highUntested, 0);
  assert.deepEqual(matrix.rows.map((row) => row.status), ["indirect"]);
});

test("audit:test-matrix excludes archived scripts from test and source inventory", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-test-matrix-archive-"));
  mkdirSync(join(root, "scripts/__tests__"), { recursive: true });
  mkdirSync(join(root, "scripts/archive/__tests__"), { recursive: true });
  writeFileSync(join(root, "scripts/live.mjs"), "export const live = true;\n");
  writeFileSync(
    join(root, "scripts/__tests__/live.test.mjs"),
    "import test from 'node:test';\ntest('live', () => {});\n",
  );
  writeFileSync(join(root, "scripts/archive/retired.cjs"), "module.exports = {};\n");
  writeFileSync(
    join(root, "scripts/archive/__tests__/retired.test.cjs"),
    "const test = require('node:test');\ntest('retired', () => {});\n",
  );

  assert.deepEqual(collectTestFiles(root), ["scripts/__tests__/live.test.mjs"]);

  const matrix = buildMatrix(root);
  assert.deepEqual(matrix.rows.map((row) => row.path), ["scripts/live.mjs"]);
  assert.equal(matrix.unwiredTests.length, 0);
  assert.equal(matrix.unreachableTests.length, 0);
});

test("audit:test-matrix json reports no untested source files for current coverage branch", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["scripts/audit-test-matrix.mjs", "--json"], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || "matrix json failed");

  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.untested, 0);
  assert.equal(report.summary.criticalUntested, 0);
  assert.equal(report.summary.highUntested, 0);
  assert.equal(report.unwiredTests.length, 0);
  assert.equal(report.unreachableTests.length, 0);
});

test("audit:test-matrix separates acknowledged unrun tests from unwired and unreachable", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-test-matrix-ack-"));
  mkdirSync(join(root, "packages/pi-coding-agent/test"), { recursive: true });
  mkdirSync(join(root, "packages/pi-coding-agent/src"), { recursive: true });
  mkdirSync(join(root, "packages/db/tests"), { recursive: true });
  mkdirSync(join(root, "packages/db/src"), { recursive: true });
  writeFileSync(join(root, "packages/pi-coding-agent/src/agent.ts"), "export const agent = 1;\n");
  writeFileSync(
    join(root, "packages/pi-coding-agent/src/agent.test.ts"),
    "import test from 'node:test';\ntest('agent', () => {});\n",
  );
  writeFileSync(
    join(root, "packages/pi-coding-agent/test/vendored.test.ts"),
    "import test from 'node:test';\ntest('vendored', () => {});\n",
  );
  writeFileSync(join(root, "packages/db/src/client.ts"), "export const db = 1;\n");
  writeFileSync(
    join(root, "packages/db/tests/schema.test.ts"),
    "import test from 'node:test';\ntest('schema', () => {});\n",
  );

  const matrix = buildMatrix(root);
  assert.deepEqual(matrix.unwiredTests, []);
  assert.deepEqual(matrix.unreachableTests, []);
  assert.deepEqual(matrix.acknowledgedUnrunTests.map((t) => t.path).sort(), [
    "packages/db/tests/schema.test.ts",
    "packages/pi-coding-agent/test/vendored.test.ts",
  ]);
  for (const entry of matrix.acknowledgedUnrunTests) {
    assert.ok(entry.reason.length > 40, `${entry.path} needs a reason`);
  }
  // packages/db/src loses its only (dead) test but is an acknowledged source.
  assert.equal(matrix.summary.untested, 0);
  assert.equal(matrix.summary.acknowledgedUnrun, 2);
  assert.deepEqual(strictMatrixFailures(matrix), []);
});

test("audit:test-matrix still fails strict on a package test dir nobody acknowledged", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-test-matrix-newdead-"));
  mkdirSync(join(root, "packages/rpc-client/test"), { recursive: true });
  mkdirSync(join(root, "packages/rpc-client/src"), { recursive: true });
  writeFileSync(join(root, "packages/rpc-client/src/rpc.ts"), "export const rpc = 1;\n");
  writeFileSync(
    join(root, "packages/rpc-client/test/rpc.test.ts"),
    "import test from 'node:test';\ntest('rpc', () => {});\n",
  );

  const matrix = buildMatrix(root);
  assert.deepEqual(matrix.unwiredTests, ["packages/rpc-client/test/rpc.test.ts"]);
  assert.deepEqual(matrix.acknowledgedUnrunTests, []);
  assert.ok(
    strictMatrixFailures(matrix).some((f) => f.includes("unwired test file(s)")),
    "expected an unwired-test strict failure",
  );
});

test("audit:test-matrix strict fails when literal matrix counts are nonzero", () => {
  assert.deepEqual(
    strictMatrixFailures({
      summary: {
        untested: 2,
        criticalUntested: 1,
        highUntested: 1,
        unwired: 1,
      },
      unwiredTests: ["src/resources/extensions/example/tests/example.test.ts"],
      unreachableTests: ["tests/live/example.test.ts"],
      rows: [],
    }),
    [
      "2 untested source file(s)",
      "1 critical untested source file(s)",
      "1 high untested source file(s)",
      "1 source file(s) mapped only to unwired tests",
      "1 unwired test file(s)",
      "1 unreachable test file(s)",
    ],
  );
});
