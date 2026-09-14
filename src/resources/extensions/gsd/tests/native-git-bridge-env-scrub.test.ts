// native-git-bridge-env-scrub.test.ts — regression for #8
//
// GIT_NO_PROMPT_ENV strips GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE (#4980 NEW-1)
// so a GSD invoked from a git hook or another worktree's shell cannot have its
// git operations redirected at a different repo. Three execFileSync fallbacks
// in native-git-bridge.ts did not pass that env, so they inherited the caller's
// process.env — including `git reset --hard`, which discards uncommitted work.
//
// GIT_NO_PROMPT_ENV is snapshotted at module load, so setting the leaking vars
// on process.env here only reaches call sites that omit `env:`.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  nativeCheckoutBranch,
  nativeIsRepo,
  nativeResetHard,
} from "../native-git-bridge.js";

// The assertion oracle must be immune to the leak it is testing for, so it
// scrubs the vars itself rather than inheriting them from process.env.
function git(args: string[], cwd: string): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8", env }).trim();
}

function makeRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  git(["init"], repo);
  git(["config", "user.email", "test@test.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "file.txt"), "initial\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  return repo;
}

describe("native-git-bridge #8: fallbacks ignore leaked GIT_DIR/GIT_WORK_TREE", () => {
  // The repo the leaked env points at — must never be touched.
  let bystander: string;
  // The repo passed as basePath — the only repo operations may affect.
  let target: string;
  let originalGitDir: string | undefined;
  let originalGitWorkTree: string | undefined;

  beforeEach(() => {
    bystander = makeRepo("ngb8-bystander-");
    target = makeRepo("ngb8-target-");
    originalGitDir = process.env.GIT_DIR;
    originalGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(bystander, ".git");
    process.env.GIT_WORK_TREE = bystander;
  });

  afterEach(() => {
    if (originalGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDir;
    if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = originalGitWorkTree;
    rmSync(bystander, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  test("nativeIsRepo reports on basePath, not the leaked GIT_DIR", () => {
    const plainDir = mkdtempSync(join(tmpdir(), "ngb8-plain-"));
    try {
      assert.equal(nativeIsRepo(plainDir), false);
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  test("nativeResetHard discards changes in basePath, not the leaked work tree", () => {
    writeFileSync(join(bystander, "file.txt"), "bystander uncommitted work\n");
    writeFileSync(join(target, "file.txt"), "target dirty\n");

    nativeResetHard(target);

    assert.equal(
      readFileSync(join(bystander, "file.txt"), "utf-8"),
      "bystander uncommitted work\n",
      "reset --hard must not discard uncommitted changes in the leaked repo",
    );
    assert.equal(readFileSync(join(target, "file.txt"), "utf-8"), "initial\n");
  });

  test("nativeCheckoutBranch switches basePath, not the leaked work tree", () => {
    git(["branch", "feature"], bystander);
    git(["branch", "feature"], target);
    const bystanderBranchBefore = git(["branch", "--show-current"], bystander);

    nativeCheckoutBranch(target, "feature");

    assert.equal(git(["branch", "--show-current"], target), "feature");
    assert.equal(
      git(["branch", "--show-current"], bystander),
      bystanderBranchBefore,
      "checkout must not move HEAD in the leaked repo",
    );
  });
});
