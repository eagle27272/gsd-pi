// Project/App: gsd-pi
// File Purpose: Doctor destructive git paths honour the shouldFix consent gate and refuse to destroy live work (#11).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGSDDoctor } from "../doctor.ts";
import { closeDatabase } from "../gsd-db.js";

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
