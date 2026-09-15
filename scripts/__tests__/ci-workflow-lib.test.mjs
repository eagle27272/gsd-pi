// Regression guard: CI docs and the tier map stay reconciled with the real
// workflow files. Commit 854209ad deleted most of this repo's workflows and
// docs/dev/ci-cd-pipeline.md went on describing them for months; these tests
// exist so the next deletion fails a gate instead of rotting quietly.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  diffDocumentedJobs,
  listJobIds,
  readRequiredChecks,
  readWorkflows,
} from "../lib/ci-workflow-lib.mjs";

const CI_DOCS = ["docs/dev/ci-cd-pipeline.md", "docs/dev/test-confidence-stack.md"];

function fixture(workflows, mergify) {
  const root = mkdtempSync(join(tmpdir(), "ci-workflow-lib-"));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  for (const [name, body] of Object.entries(workflows)) {
    writeFileSync(join(root, ".github/workflows", name), body);
  }
  if (mergify) writeFileSync(join(root, ".mergify.yml"), mergify);
  return root;
}

test("reads job ids and triggers from the real workflow files", () => {
  const workflows = readWorkflows(".");
  assert.ok(workflows.length > 0, "expected at least one workflow file");

  for (const workflow of workflows) {
    assert.ok(workflow.jobs.length > 0, `${workflow.file} defines no jobs`);
    assert.ok(workflow.triggers.length > 0, `${workflow.file} declares no triggers`);
  }
});

test("every check .mergify.yml requires is a job some workflow defines", () => {
  const jobs = listJobIds(".");
  for (const check of readRequiredChecks(".")) {
    assert.ok(
      jobs.has(check),
      `.mergify.yml requires '${check}', but no workflow defines that job`,
    );
  }
});

test("the documented tier map matches the workflows on disk", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    ["scripts/audit-test-confidence.mjs", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  const documented = report.ciPrBlocking.map((row) => row.ciJob);
  const diff = diffDocumentedJobs(".", documented);

  assert.deepEqual(diff.missing, [], "tier map documents jobs that do not exist");
  assert.deepEqual(diff.undocumented, [], "workflows define jobs the tier map omits");
});

test("CI docs do not reference workflow files that were deleted", () => {
  const onDisk = new Set(readWorkflows(".").map((w) => w.file.split("/").pop()));

  for (const doc of CI_DOCS) {
    const text = readFileSync(doc, "utf8");
    // Only flag `.github/workflows/`-shaped names; a bare `ci.yml` in prose is
    // ambiguous, but `foo.yml` claimed as a workflow is checkable.
    const claimed = text.matchAll(/`([a-z0-9-]+\.ya?ml)`/g);
    for (const [, name] of claimed) {
      if (name === "dependabot.yml" || name === ".mergify.yml") continue;
      assert.ok(
        onDisk.has(name),
        `${doc} references workflow '${name}', which does not exist in .github/workflows/`,
      );
    }
  }
});

test("CI docs do not claim a job that no workflow defines", () => {
  const jobs = listJobIds(".");
  // Job names the docs previously asserted as CI jobs. Each was real once and
  // is now local-only or gone; if one comes back, drop it from this list.
  const retired = ["fast-gates", "windows-portability", "windows-smoke-e2e", "coverage-report"];

  for (const doc of CI_DOCS) {
    const text = readFileSync(doc, "utf8");
    for (const name of retired) {
      if (!jobs.has(name) && new RegExp(`\`${name}\`\\s+job`).test(text)) {
        assert.fail(`${doc} calls '${name}' a job, but no workflow defines it`);
      }
    }
  }
});

test("diffDocumentedJobs reports drift in both directions", () => {
  const root = fixture(
    {
      "ci.yml": "name: CI\non:\n  pull_request:\njobs:\n  build-and-test:\n    runs-on: ubuntu-latest\n",
    },
    "queue_rules:\n  - name: q\n    merge_conditions:\n      - check-success = @github-actions/ghost\n",
  );

  try {
    const diff = diffDocumentedJobs(root, ["build-and-test", "deleted-job"]);
    assert.deepEqual(diff.actual, ["build-and-test"]);
    assert.deepEqual(diff.missing, ["deleted-job"]);
    assert.deepEqual(diff.undocumented, []);
    assert.deepEqual(diff.requiredButUndefined, ["ghost"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an undocumented workflow job is drift", () => {
  const root = fixture({
    "ci.yml": "name: CI\non:\n  pull_request:\njobs:\n  a:\n    runs-on: x\n  b:\n    runs-on: x\n",
  });

  try {
    assert.deepEqual(diffDocumentedJobs(root, ["a"]).undocumented, ["b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strips the Mergify app prefix from required checks", () => {
  const root = fixture(
    { "ci.yml": "name: CI\non:\n  pull_request:\njobs:\n  build-and-test:\n    runs-on: x\n" },
    "queue_rules:\n  - name: q\n    merge_conditions:\n      - check-success = @github-actions/build-and-test\n      - base = main\n",
  );

  try {
    assert.deepEqual(readRequiredChecks(root), ["build-and-test"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repo with no workflows yields no jobs rather than throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-workflow-lib-empty-"));
  try {
    assert.deepEqual(readWorkflows(root), []);
    assert.deepEqual(readRequiredChecks(root), []);
    assert.deepEqual([...listJobIds(root)], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
