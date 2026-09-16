import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGSDDoctor } from "../doctor.ts";
import { checkRuntimeHealth } from "../doctor-runtime-checks.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  closeDatabase,
  insertMilestone,
  openDatabase,
  setMilestoneQueueOrder,
} from "../gsd-db.ts";
import { getRuntimeKv, setRuntimeKv } from "../db/runtime-kv.ts";
import {
  PAUSED_SESSION_KV_KEY,
  type PausedSessionMetadata,
} from "../interrupted-session.ts";
import type { DoctorIssue } from "../doctor-types.ts";

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function createGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-doctor-runtime-checks-"));
  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.email", "test@test.com"]);
  runGit(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# test\n", "utf-8");
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-m", "init"]);
  return dir;
}

test("doctor fix respects git.manage_gitignore false (#4161)", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(
    join(dir, ".gsd", "PREFERENCES.md"),
    "---\nversion: 1\ngit:\n  manage_gitignore: false\n---\n",
    "utf-8",
  );
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");

  const detect = await runGSDDoctor(dir);
  assert.ok(
    detect.issues.some((issue) => issue.code === "gitignore_missing_patterns"),
    "doctor still reports missing runtime ignore patterns so users can decide how to handle them",
  );

  await runGSDDoctor(dir, { fix: true });

  assert.equal(readFileSync(join(dir, ".gitignore"), "utf-8"), "node_modules/\n");
  assert.equal(existsSync(join(dir, ".gsd", "PREFERENCES.md")), true);
});

function excludeFile(dir: string): string {
  return join(dir, ".git", "info", "exclude");
}

test("doctor reports missing runtime patterns in a repo with no .gitignore at all", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // No .gitignore and an empty exclude file — nothing ignores GSD's runtime
  // paths, which is exactly the drift the check exists to catch.
  writeFileSync(excludeFile(dir), "", "utf-8");

  const detect = await runGSDDoctor(dir);
  assert.ok(
    detect.issues.some((issue) => issue.code === "gitignore_missing_patterns"),
    "the absence of a .gitignore must not skip the drift check",
  );
});

test("doctor treats patterns already in .git/info/exclude as present", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");
  writeFileSync(excludeFile(dir), ".gsd\n.gsd-worktrees/\n.gsd-backups/\n", "utf-8");

  const detect = await runGSDDoctor(dir);
  assert.equal(
    detect.issues.some((issue) => issue.code === "gitignore_missing_patterns"),
    false,
    "the exclude file satisfies the drift check just as .gitignore does",
  );
});

test("doctor fix writes missing runtime patterns to .git/info/exclude", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");
  writeFileSync(excludeFile(dir), "", "utf-8");

  await runGSDDoctor(dir, { fix: true });

  const exclude = readFileSync(excludeFile(dir), "utf-8");
  assert.match(exclude, /^\.gsd$/m, "baseline lands in the exclude file");
  assert.equal(
    readFileSync(join(dir, ".gitignore"), "utf-8"),
    "node_modules/\n",
    "the tracked .gitignore is left untouched",
  );
});

test("doctor fix resets run-uat counters at the dispatch cap", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const runtimeDir = join(dir, ".gsd", "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const counterPath = join(runtimeDir, "uat-count-M002-S01.json");
  writeFileSync(
    counterPath,
    JSON.stringify({ count: 3, updatedAt: "2026-06-02T19:40:23.289Z" }) + "\n",
    "utf-8",
  );

  const detect = await runGSDDoctor(dir);
  const issue = detect.issues.find((candidate) => candidate.code === "uat_retry_exhausted");
  assert.ok(issue, "doctor reports the exhausted UAT retry counter at the dispatch cap");
  assert.equal(issue.unitId, "M002/S01");
  assert.match(issue.message, /3 attempt\(s\)/);

  const fixed = await runGSDDoctor(dir, { fix: true, scope: "M002/S02" });
  assert.ok(
    fixed.fixesApplied.some((fix) => fix.includes("reset exhausted run-uat retry counter for M002/S01")),
    "doctor --fix resets the blocked counter even when the current displayed scope has advanced",
  );
  assert.equal(existsSync(counterPath), false);
});

test("doctor ignores an exhausted run-uat counter once the flat-phase ASSESSMENT carries a verdict", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const runtimeDir = join(dir, ".gsd", "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "uat-count-M002-S01.json"),
    JSON.stringify({ count: 5, updatedAt: "2026-06-02T19:40:23.289Z" }) + "\n",
    "utf-8",
  );

  // Flat-phase assessment: .gsd/phases/NN-slug/NN-MM-ASSESSMENT.md
  const phaseDir = join(dir, ".gsd", "phases", "02-checkout-flow");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(
    join(phaseDir, "02-01-ASSESSMENT.md"),
    "---\nverdict: PASS\n---\n\n# UAT assessment\n",
    "utf-8",
  );

  const detect = await runGSDDoctor(dir);
  assert.equal(
    detect.issues.some((candidate) => candidate.code === "uat_retry_exhausted"),
    false,
    "a recorded ASSESSMENT verdict means the retries produced a result, so the counter is not blocked",
  );
});

test("doctor still reports an exhausted run-uat counter when the flat-phase ASSESSMENT has no verdict", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const runtimeDir = join(dir, ".gsd", "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "uat-count-M002-S01.json"),
    JSON.stringify({ count: 5, updatedAt: "2026-06-02T19:40:23.289Z" }) + "\n",
    "utf-8",
  );

  const phaseDir = join(dir, ".gsd", "phases", "02-checkout-flow");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(
    join(phaseDir, "02-01-ASSESSMENT.md"),
    "# UAT assessment\n\nThe run crashed before a verdict was recorded.\n",
    "utf-8",
  );

  const detect = await runGSDDoctor(dir);
  const issue = detect.issues.find((candidate) => candidate.code === "uat_retry_exhausted");
  assert.ok(issue, "an ASSESSMENT without a verdict must not suppress the exhausted-counter report");
  assert.equal(issue.unitId, "M002/S01");
});

test("doctor reports and repairs a paused session superseded by the active milestone", async (t) => {
  const dir = createGitProject();
  t.after(() => {
    closeDatabase();
    invalidateAllCaches();
    rmSync(dir, { recursive: true, force: true });
  });

  const pausedMilestoneId = "M016-5b17xo";
  const activeMilestoneId = "M018-6b0xxe";
  for (const milestoneId of [pausedMilestoneId, activeMilestoneId]) {
    const milestoneDir = join(dir, ".gsd", "milestones", milestoneId);
    mkdirSync(milestoneDir, { recursive: true });
    writeFileSync(join(milestoneDir, `${milestoneId}-CONTEXT.md`), `# ${milestoneId}\n`);
  }

  openDatabase(join(dir, ".gsd", "gsd.db"));
  insertMilestone({ id: pausedMilestoneId, title: "Superseded milestone", status: "active" });
  insertMilestone({ id: activeMilestoneId, title: "Current milestone", status: "active" });
  setMilestoneQueueOrder([activeMilestoneId, pausedMilestoneId]);
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, {
    milestoneId: pausedMilestoneId,
    originalBasePath: dir,
  } satisfies PausedSessionMetadata);
  invalidateAllCaches();

  const issues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  await checkRuntimeHealth(dir, issues, fixesApplied, () => false);

  const issue = issues.find((candidate) => candidate.code === "stale_paused_session");
  assert.ok(issue, "doctor reports the stale paused-session row");
  assert.equal(issue.severity, "error");
  assert.equal(issue.fixable, true);
  assert.match(issue.message, new RegExp(pausedMilestoneId));
  assert.match(issue.message, new RegExp(activeMilestoneId));
  assert.ok(
    getRuntimeKv("global", "", PAUSED_SESSION_KV_KEY),
    "read-only doctor preserves paused-session metadata",
  );

  const fixIssues: DoctorIssue[] = [];
  await checkRuntimeHealth(
    dir,
    fixIssues,
    fixesApplied,
    (code) => code === "stale_paused_session",
  );

  assert.equal(getRuntimeKv("global", "", PAUSED_SESSION_KV_KEY), null);
  assert.ok(
    fixesApplied.some((fix) => fix.includes(`cleared stale paused session for ${pausedMilestoneId}`)),
  );
  assert.equal(fixIssues.some((candidate) => candidate.code === "stale_paused_session"), false);

  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, {
    activeEngineId: "custom-workflow",
    milestoneId: pausedMilestoneId,
    originalBasePath: dir,
  } satisfies PausedSessionMetadata);
  const customWorkflowIssues: DoctorIssue[] = [];
  await checkRuntimeHealth(
    dir,
    customWorkflowIssues,
    fixesApplied,
    (code) => code === "stale_paused_session",
  );
  assert.equal(
    customWorkflowIssues.some((candidate) => candidate.code === "stale_paused_session"),
    false,
    "doctor leaves custom-workflow pause metadata to its dedicated resume path",
  );
  assert.ok(getRuntimeKv("global", "", PAUSED_SESSION_KV_KEY));
});

test("doctor surfaces unresolved projection evidence with recovery instructions", async (t) => {
  const dir = createGitProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const evidencePath = "notes/my notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
  mkdirSync(join(dir, ".gsd", evidencePath), { recursive: true });
  mkdirSync(join(dir, ".gsd", "migration"), { recursive: true });
  writeFileSync(join(dir, ".gsd", evidencePath, "later.md"), "later accepted work\n");
  writeFileSync(
    join(dir, ".gsd", "migration", "unbound-projection-evidence.json"),
    `${JSON.stringify([{
      evidencePath,
      evidenceIdentity: null,
      kind: "quarantine",
      logicalPath: "notes/my notes/result.md",
      scope: "tree",
      transition: "retained",
    }])}\n`,
  );

  const report = await runGSDDoctor(dir);
  const issue = report.issues.find(candidate => candidate.code === "unresolved_projection_evidence");
  assert.ok(issue);
  assert.match(issue.message, /notes\/my notes\/result\.md/);
  assert.match(issue.message, /\.gsd\/notes\/my notes\/\.gsd-projection-remove/);
  assert.match(issue.message, /\/gsd doctor resolve-evidence/u);
  assert.match(issue.message, /evidence:sha256:[0-9a-f]+ --action=discard --consent=discard:sha256:/u);
  assert.match(issue.message, /--action=preserve/u);
  assert.match(issue.message, /--action=restore/u);
  assert.equal(issue.fixable, false);
});
