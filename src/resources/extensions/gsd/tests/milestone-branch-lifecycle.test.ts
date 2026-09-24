// gsd-pi — Milestone entry creates the branch under its recorded name.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enterBranchModeForMilestone } from "../auto-worktree-branch-lifecycle.ts";
import { createAutoWorktree } from "../auto-worktree-creation.ts";
import { writeMilestoneBranchRecord } from "../milestone-branch-registry.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { _resetServiceCache } from "../worktree.ts";
import { git, makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

describe("milestone entry with a recorded branch name", () => {
  let repo: string;
  let savedCwd: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    savedCwd = process.cwd();
    originalHome = process.env.HOME;
    fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-fake-home-")));
    process.env.HOME = fakeHome;
    _clearGsdRootCache();
    _resetServiceCache();
    repo = makeRepo("gsd-ms-branch-lifecycle-");
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");
  });

  afterEach(() => {
    process.chdir(savedCwd);
    process.env.HOME = originalHome;
    _clearGsdRootCache();
    _resetServiceCache();
    removeRepo(repo);
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test("branch mode checks out the recorded branch", () => {
    enterBranchModeForMilestone(repo, "M001");
    assert.equal(git(repo, "branch", "--show-current"), "feat/add_auth");
    assert.equal(git(repo, "branch", "--list", "milestone/M001"), "");
  });

  test("worktree mode creates the worktree on the recorded branch", () => {
    const wtPath = createAutoWorktree(repo, "M001");
    assert.equal(git(wtPath, "branch", "--show-current"), "feat/add_auth");
    assert.equal(git(repo, "branch", "--list", "milestone/M001"), "");
  });
});
