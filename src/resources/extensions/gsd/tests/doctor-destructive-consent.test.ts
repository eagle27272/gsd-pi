// Project/App: gsd-pi
// File Purpose: Doctor destructive git paths honour the shouldFix consent gate and refuse to destroy live work (#11).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGSDDoctor } from "../doctor.ts";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.js";
import { createWorktree, worktreePath } from "../worktree-manager.ts";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function makeRepo(prefix: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  runGit(["init", "-b", "main"], base);
  runGit(["config", "user.name", "Test User"], base);
  runGit(["config", "user.email", "test@example.com"], base);
  writeFileSync(join(base, "README.md"), "base\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "chore: init"], base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function branchExists(base: string, branch: string): boolean {
  try {
    runGit(["rev-parse", "--verify", `refs/heads/${branch}`], base);
    return true;
  } catch {
    return false;
  }
}

test.after(() => {
  closeDatabase();
});

test("doctor --fix deletes legacy slice branches but spares template and rescue branches", async (t) => {
  const base = makeRepo("gsd-doctor-legacy-branches-");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  runGit(["branch", "gsd/M001/S01"], base);
  runGit(["branch", "gsd/hotfix/login-timeout"], base);
  runGit(["branch", "gsd/submodule-rescue/M001-1757000000000"], base);
  runGit(["branch", "gsd/quick/T01-tidy"], base);

  await runGSDDoctor(base, { fix: true, isolationMode: "none" });

  assert.equal(branchExists(base, "gsd/M001/S01"), false, "merged legacy slice branch should be deleted");
  assert.equal(branchExists(base, "gsd/hotfix/login-timeout"), true, "live template branch must survive");
  assert.equal(
    branchExists(base, "gsd/submodule-rescue/M001-1757000000000"),
    true,
    "submodule rescue branch must survive — it is the only copy of rescued work",
  );
  assert.equal(branchExists(base, "gsd/quick/T01-tidy"), true, "quick branch must survive");
});

test("doctor --fix keeps an unmerged legacy slice branch", async (t) => {
  const base = makeRepo("gsd-doctor-unmerged-legacy-");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  runGit(["checkout", "-b", "gsd/M001/S01"], base);
  writeFileSync(join(base, "work.txt"), "unmerged work\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "feat: unmerged slice work"], base);
  runGit(["checkout", "main"], base);

  await runGSDDoctor(base, { fix: true, isolationMode: "none" });

  assert.equal(
    branchExists(base, "gsd/M001/S01"),
    true,
    "an unmerged legacy slice branch holds the only reference to its commits",
  );
});

test("doctor --fix quarantines rather than deletes a dirty worktree for a cancelled milestone", async (t) => {
  const base = makeRepo("gsd-doctor-orphan-dirty-");
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Cancelled", status: "cancelled" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "in_progress" });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\ngit:\n  isolation: worktree\n---\n");

  createWorktree(base, "M001", { branch: "milestone/M001" });
  const wtPath = worktreePath(base, "M001");
  // A commit of its own keeps the branch unmerged, so the sibling
  // worktree_branch_merged check leaves it alone and this test isolates the
  // orphaned_auto_worktree path.
  writeFileSync(join(wtPath, "committed.txt"), "milestone work\n", "utf-8");
  runGit(["add", "."], wtPath);
  runGit(["commit", "-m", "feat: milestone work"], wtPath);
  writeFileSync(join(wtPath, "unsaved.txt"), "work in progress\n", "utf-8");

  const cwdBefore = process.cwd();
  await runGSDDoctor(base, { fix: true, isolationMode: "worktree" });

  assert.equal(process.cwd(), cwdBefore, "doctor must not relocate the process");

  const quarantineRoot = join(base, ".gsd", "quarantine", "worktrees");
  assert.ok(existsSync(quarantineRoot), "dirty worktree should have been quarantined, not deleted");
  const preserved = readdirSync(quarantineRoot)
    .some((entry) => existsSync(join(quarantineRoot, entry, "unsaved.txt")));
  assert.ok(preserved, "uncommitted work must survive in the quarantine snapshot");
  assert.ok(branchExists(base, "milestone/M001"), "the branch must be preserved");
});
