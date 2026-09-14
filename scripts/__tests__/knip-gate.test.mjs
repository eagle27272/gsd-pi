// Project/App: gsd-pi
// File Purpose: Coverage for the knip dead-code baseline ratchet (flatten + diff).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  diffAgainstBaseline,
  exitCodeForDiff,
  flattenKnipReport,
  parseBaseline,
  parseKnipReport,
  renderBaselineFile,
} from "../lib/knip-baseline-lib.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("flattenKnipReport keys a finding by type, file and symbol without line numbers", () => {
  const keys = flattenKnipReport({
    files: [],
    issues: [{ file: "src/a.ts", exports: [{ name: "unusedFn", line: 12, col: 3 }] }],
  });

  assert.deepEqual(keys, ["exports|src/a.ts|unusedFn"]);
});

test("flattenKnipReport keys unused files from the report's top-level files list", () => {
  const keys = flattenKnipReport({ files: ["src/dead.ts"], issues: [] });

  assert.deepEqual(keys, ["files|src/dead.ts|"]);
});

test("flattenKnipReport qualifies class and enum members with their owner", () => {
  const keys = flattenKnipReport({
    files: [],
    issues: [
      {
        file: "src/a.ts",
        classMembers: { Store: [{ name: "neverRead", line: 9 }] },
        enumMembers: { Mode: [{ name: "Unused", line: 4 }] },
      },
    ],
  });

  assert.deepEqual(keys, ["classMembers|src/a.ts|Store.neverRead", "enumMembers|src/a.ts|Mode.Unused"]);
});

test("flattenKnipReport collapses a duplicate-export group into one sorted key", () => {
  const keys = flattenKnipReport({
    files: [],
    issues: [{ file: "src/a.ts", duplicates: [[{ name: "run" }, { name: "default" }]] }],
  });

  assert.deepEqual(keys, ["duplicates|src/a.ts|default,run"]);
});

test("diffAgainstBaseline reports a finding absent from the baseline as added", () => {
  const diff = diffAgainstBaseline(["exports|src/a.ts|old", "exports|src/b.ts|new"], [
    "exports|src/a.ts|old",
  ]);

  assert.deepEqual(diff.added, ["exports|src/b.ts|new"]);
  assert.deepEqual(diff.resolved, []);
});

test("diffAgainstBaseline reports a baselined finding that no longer occurs as resolved", () => {
  const diff = diffAgainstBaseline(["exports|src/a.ts|old"], [
    "exports|src/a.ts|old",
    "exports|src/gone.ts|cleaned",
  ]);

  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.resolved, ["exports|src/gone.ts|cleaned"]);
});

test("diffAgainstBaseline treats an unchanged report as clean", () => {
  const diff = diffAgainstBaseline(["exports|src/a.ts|old"], ["exports|src/a.ts|old"]);

  assert.deepEqual(diff, { added: [], resolved: [] });
});

test("parseBaseline reads the committed findings list", () => {
  assert.deepEqual(parseBaseline('{"findings":["exports|src/a.ts|old"]}'), ["exports|src/a.ts|old"]);
});

test("parseBaseline rejects a baseline whose findings are not a string array", () => {
  assert.throws(() => parseBaseline('{"findings":[{"name":"old"}]}'), /findings/);
});

test("parseBaseline rejects an unparseable baseline instead of treating it as empty", () => {
  assert.throws(() => parseBaseline("not json"), /baseline/i);
});

test("renderBaselineFile emits sorted findings and a trailing newline so rewrites stay deterministic", () => {
  const text = renderBaselineFile(["files|src/b.ts|", "exports|src/a.ts|old"]);

  assert.equal(text.endsWith("\n"), true);
  assert.deepEqual(parseBaseline(text), ["exports|src/a.ts|old", "files|src/b.ts|"]);
});

test("exitCodeForDiff fails only when a finding is new", () => {
  assert.equal(exitCodeForDiff({ added: ["exports|src/b.ts|new"], resolved: [] }), 1);
  assert.equal(exitCodeForDiff({ added: [], resolved: ["exports|src/a.ts|old"] }), 0);
  assert.equal(exitCodeForDiff({ added: [], resolved: [] }), 0);
});

test("parseKnipReport accepts exit code 1, which knip uses to mean 'found issues'", () => {
  const report = parseKnipReport({ status: 1, stdout: '{"files":["src/dead.ts"],"issues":[]}', stderr: "" });

  assert.deepEqual(report.files, ["src/dead.ts"]);
});

test("parseKnipReport throws on a knip crash instead of reporting an empty clean run", () => {
  assert.throws(
    () => parseKnipReport({ status: 2, stdout: "", stderr: "Cannot find config" }),
    /Cannot find config/,
  );
});

test("parseKnipReport throws when knip exits cleanly but prints no parseable report", () => {
  assert.throws(() => parseKnipReport({ status: 0, stdout: "", stderr: "" }), /report/i);
});

// #81: a gate nobody runs drifts exactly the way the missing noUnusedLocals did.
test("the dead-code gate is wired into CI and into the local merge-parity scripts", () => {
  const read = (path) => readFileSync(join(repoRoot, path), "utf8");

  assert.match(read(".github/workflows/ci.yml"), /pnpm run lint:dead-code/);
  assert.match(read("scripts/ci-fast-gates.sh"), /pnpm run lint:dead-code/);
  assert.match(read("scripts/verify-merge.sh"), /pnpm run lint:dead-code/);
});

test("the committed knip baseline parses and is sorted, so regeneration produces no spurious diff", () => {
  const text = readFileSync(join(repoRoot, ".config/knip-baseline.json"), "utf8");

  assert.equal(renderBaselineFile(parseBaseline(text)), text);
});
