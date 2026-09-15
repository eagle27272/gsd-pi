// Regression guard: the CI map in audit-test-confidence.mjs is checked against
// the real workflow and merge-queue config, not just asserted in prose.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ciDriftForRoot,
  ciMapDrift,
  localTierDrift,
  parseRequiredChecks,
  parseWorkflowJobs,
  readMergifySource,
  readWorkflowSources,
} from "../lib/ci-workflow-lib.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

const CI_YML = `
name: CI
on:
  pull_request:
    branches: [main]
jobs:
  fast-gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: pnpm install --frozen-lockfile
      - run: bash scripts/ci-fast-gates.sh
  build-and-test:
    if: startsWith(github.head_ref, 'mergify/merge-queue/')
    runs-on: ubuntu-latest
    steps:
      - run: pnpm run build:core
      - run: pnpm run test:unit
`;

const MERGIFY_YML = `
queue_rules:
  - name: Auto Merge
    queue_conditions:
      - base = main
    merge_conditions:
      - check-success = @github-actions/fast-gates
      - check-success = @github-actions/build-and-test
`;

const QUEUE_ONLY_IF = "startsWith(github.head_ref, 'mergify/merge-queue/')";

const blocking = (overrides = []) => [
  { ciJob: "fast-gates", steps: ["bash scripts/ci-fast-gates.sh"], enforcement: "block" },
  {
    ciJob: "build-and-test",
    steps: ["build:core", "test:unit"],
    enforcement: "block",
    allowedIf: QUEUE_ONLY_IF,
  },
  ...overrides,
];

const findJob = (jobs, id) => jobs.find((job) => job.id === id);

test("parseWorkflowJobs returns each job's id and its run commands", () => {
  const jobs = parseWorkflowJobs({ "ci.yml": CI_YML });
  assert.deepEqual(jobs.map((job) => job.id).sort(), ["build-and-test", "fast-gates"]);
  assert.equal(findJob(jobs, "fast-gates").workflow, "ci.yml");
  assert.deepEqual(findJob(jobs, "build-and-test").runs, [
    "pnpm run build:core",
    "pnpm run test:unit",
  ]);
});

test("parseWorkflowJobs ignores steps that use an action instead of run", () => {
  const jobs = parseWorkflowJobs({ "ci.yml": CI_YML });
  assert.deepEqual(findJob(jobs, "fast-gates").runs, [
    "pnpm install --frozen-lockfile",
    "bash scripts/ci-fast-gates.sh",
  ]);
});

test("parseWorkflowJobs keeps same-named jobs from different workflows apart", () => {
  const jobs = parseWorkflowJobs({
    "a.yml": CI_YML,
    "b.yml": "jobs:\n  fast-gates:\n    steps:\n      - run: echo other\n",
  });
  assert.deepEqual(
    jobs.filter((job) => job.id === "fast-gates").map((job) => job.workflow).sort(),
    ["a.yml", "b.yml"],
  );
});

test("parseWorkflowJobs records a job-level if condition", () => {
  const jobs = parseWorkflowJobs({ "ci.yml": CI_YML });
  assert.equal(findJob(jobs, "build-and-test").if, QUEUE_ONLY_IF);
  assert.equal(findJob(jobs, "fast-gates").if, null);
});

test("parseRequiredChecks descends into nested and/or condition groups", () => {
  const nested = `
queue_rules:
  - name: Auto Merge
    merge_conditions:
      - and:
          - check-success = @github-actions/fast-gates
          - or:
              - check-success = build-and-test
`;
  assert.deepEqual(parseRequiredChecks(nested), new Set(["fast-gates", "build-and-test"]));
});

test("parseRequiredChecks extracts the job names Mergify gates merges on", () => {
  assert.deepEqual(parseRequiredChecks(MERGIFY_YML), new Set(["fast-gates", "build-and-test"]));
});

test("ciMapDrift reports nothing when the map matches the workflow", () => {
  assert.deepEqual(
    ciMapDrift({
      blocking: blocking(),
      conditional: [],
      workflows: { "ci.yml": CI_YML },
      mergify: MERGIFY_YML,
    }),
    [],
  );
});

test("ciMapDrift reports a documented job that no workflow defines", () => {
  const issues = ciMapDrift({
    blocking: blocking([
      { ciJob: "windows-portability", steps: [], enforcement: "block-when-triggered" },
    ]),
    conditional: [],
    workflows: { "ci.yml": CI_YML },
    mergify: MERGIFY_YML,
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /windows-portability/);
  assert.match(issues[0], /no workflow defines/i);
});

test("ciMapDrift reports a blocking job Mergify does not require", () => {
  const issues = ciMapDrift({
    blocking: blocking(),
    conditional: [],
    workflows: { "ci.yml": CI_YML },
    mergify: MERGIFY_YML.replace("      - check-success = @github-actions/fast-gates\n", ""),
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /fast-gates/);
  assert.match(issues[0], /merge_conditions/);
});

// The failure mode issue #191 was filed about: a gate is deleted from CI and
// the guard that documents it stays quietly green.
test("ciMapDrift reports a documented step the job no longer runs", () => {
  const issues = ciMapDrift({
    blocking: blocking(),
    conditional: [],
    workflows: { "ci.yml": CI_YML.replace("      - run: pnpm run test:unit\n", "") },
    mergify: MERGIFY_YML,
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /build-and-test/);
  assert.match(issues[0], /test:unit/);
});

// `pnpm run test:unit:compiled` is a strictly narrower gate than
// `pnpm run test:unit`; a substring match would call that no drift at all.
test("ciMapDrift reports a documented step narrowed to a different script", () => {
  const issues = ciMapDrift({
    blocking: blocking(),
    conditional: [],
    workflows: {
      "ci.yml": CI_YML.replace("pnpm run test:unit", "pnpm run test:unit:compiled"),
    },
    mergify: MERGIFY_YML,
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /test:unit/);
});

test("ciMapDrift does not accept a documented step that only appears in a comment", () => {
  const issues = ciMapDrift({
    blocking: blocking(),
    conditional: [],
    workflows: {
      "ci.yml": CI_YML.replace(
        "      - run: pnpm run test:unit\n",
        "      - run: |\n          # pnpm run test:unit is temporarily disabled\n          echo skipped\n",
      ),
    },
    mergify: MERGIFY_YML,
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /test:unit/);
});

test("ciMapDrift accepts the merge-queue guard a blocking job declares", () => {
  assert.deepEqual(
    ciMapDrift({
      blocking: blocking(),
      conditional: [],
      workflows: { "ci.yml": CI_YML },
      mergify: MERGIFY_YML,
    }),
    [],
  );
});

// A blocking job that never runs never reports a check, so the merge queue
// stalls rather than merging something unverified — but it is still drift.
test("ciMapDrift reports an undeclared if condition on a blocking job", () => {
  const issues = ciMapDrift({
    blocking: blocking(),
    conditional: [],
    workflows: {
      "ci.yml": CI_YML.replace(
        "  fast-gates:\n",
        "  fast-gates:\n    if: github.event_name == 'push'\n",
      ),
    },
    mergify: MERGIFY_YML,
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /fast-gates/);
  assert.match(issues[0], /if:/);
});

test("ciMapDrift reports a workflow job missing from the map", () => {
  const issues = ciMapDrift({
    blocking: blocking().slice(0, 1),
    conditional: [],
    workflows: { "ci.yml": CI_YML },
    mergify: MERGIFY_YML,
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /build-and-test/);
  assert.match(issues[0], /not documented/i);
});

test("ciMapDrift counts conditional jobs as documented without requiring a merge check", () => {
  const workflows = {
    "ci.yml": `${CI_YML}  nightly:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`,
  };
  assert.deepEqual(
    ciMapDrift({
      blocking: blocking(),
      conditional: [{ ciJob: "nightly", enforcement: "warn" }],
      workflows,
      mergify: MERGIFY_YML,
    }),
    [],
  );
});

// The local-tier table names CI jobs too, and it is what the human-readable
// report prints. It drifted the same way the blocking map did (#191).
test("localTierDrift accepts tiers whose CI jobs exist", () => {
  assert.deepEqual(
    localTierDrift({
      tiers: [
        { name: "verify:fast", matchesCi: ["fast-gates"] },
        { name: "test:coverage", matchesCi: [] },
      ],
      workflows: { "ci.yml": CI_YML },
    }),
    [],
  );
});

test("localTierDrift reports a tier pointing at a job that does not exist", () => {
  const issues = localTierDrift({
    tiers: [{ name: "test:coverage", matchesCi: ["coverage-report"] }],
    workflows: { "ci.yml": CI_YML },
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /test:coverage/);
  assert.match(issues[0], /coverage-report/);
});

test("readWorkflowSources and readMergifySource read this repo's real config", () => {
  const sources = readWorkflowSources(ROOT);
  assert.ok(Object.hasOwn(sources, "ci.yml"), "expected .github/workflows/ci.yml");
  assert.match(readMergifySource(ROOT), /queue_rules/);
});

test("readWorkflowSources returns nothing when the workflow dir is absent", () => {
  const empty = mkdtempSync(join(tmpdir(), "ci-workflow-lib-"));
  try {
    assert.deepEqual(readWorkflowSources(empty), {});
    assert.equal(readMergifySource(empty), "");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

// The end-to-end path audit-test-confidence.mjs actually calls.
test("ciDriftForRoot reports drift against the real repo when the map is wrong", () => {
  const issues = ciDriftForRoot(ROOT, {
    blocking: [{ ciJob: "no-such-job", steps: [], enforcement: "block" }],
    conditional: [],
    localTiers: [{ name: "made-up", matchesCi: ["also-missing"] }],
  });
  assert.ok(issues.some((i) => /no-such-job/.test(i)), issues.join("\n"));
  assert.ok(issues.some((i) => /also-missing/.test(i)), issues.join("\n"));
});
