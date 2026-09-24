// gsd-pi — A branch record lives exactly as long as the branch gsd created.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAutoWorktree } from "../auto-worktree-creation.ts";
import { mergeMilestoneToMain } from "../auto-worktree-merge.ts";
import { teardownAutoWorktree } from "../auto-worktree-teardown.ts";
import { hasMilestoneBranchRecord, writeMilestoneBranchRecord } from "../milestone-branch-registry.ts";
import { discardMilestone } from "../milestone-actions.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { _resetServiceCache } from "../worktree.ts";
import { removeWorktree } from "../worktree-manager.ts";
import { seedMergeReadyMilestone } from "./merge-ready-fixture.ts";
import { git, makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

describe("milestone branch record cleanup", () => {
  let savedCwd: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  const repos: string[] = [];

  beforeEach(() => {
    savedCwd = process.cwd();
    originalHome = process.env.HOME;
    fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-fake-home-")));
    process.env.HOME = fakeHome;
    _clearGsdRootCache();
    _resetServiceCache();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    process.env.HOME = originalHome;
    _clearGsdRootCache();
    _resetServiceCache();
    for (const repo of repos.splice(0)) removeRepo(repo);
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test("stopping with preserveBranch keeps the record, and a full teardown clears it", () => {
    const repo = makeRepo("gsd-ms-branch-teardown-");
    repos.push(repo);
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");

    createAutoWorktree(repo, "M001");
    teardownAutoWorktree(repo, "M001", { preserveBranch: true });
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), true);
    assert.equal(git(repo, "branch", "--list", "feat/add_auth"), "feat/add_auth");

    const resumed = createAutoWorktree(repo, "M001");
    assert.equal(git(resumed, "branch", "--show-current"), "feat/add_auth");
    teardownAutoWorktree(repo, "M001");
    assert.equal(git(repo, "branch", "--list", "feat/add_auth"), "");
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), false);
  });

  test("removeWorktree deletes an unattached recorded branch and clears its record", () => {
    const repo = makeRepo("gsd-ms-branch-remove-");
    repos.push(repo);
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");
    git(repo, "branch", "feat/add_auth");

    removeWorktree(repo, "M001", { branch: "feat/add_auth", deleteBranch: true });

    assert.equal(git(repo, "branch", "--list", "feat/add_auth"), "");
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), false);
  });

  test("removeWorktree deleting an unrecorded branch leaves other records alone", () => {
    const repo = makeRepo("gsd-ms-branch-remove-unrelated-");
    repos.push(repo);
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");
    git(repo, "branch", "feat/add_auth");
    git(repo, "branch", "feat/unrelated");

    removeWorktree(repo, "X1", { branch: "feat/unrelated", deleteBranch: true });

    assert.equal(git(repo, "branch", "--list", "feat/unrelated"), "");
    assert.equal(git(repo, "branch", "--list", "feat/add_auth"), "feat/add_auth");
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), true);
  });

  test("discarding a milestone deletes its branch and clears the record", () => {
    const repo = makeRepo("gsd-ms-branch-discard-");
    repos.push(repo);
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");
    git(repo, "branch", "feat/add_auth");
    // Discard needs a milestone gsd recognizes on disk (flat-phase layout).
    mkdirSync(join(repo, ".gsd", "phases", "01-m001"), { recursive: true });

    assert.equal(discardMilestone(repo, "M001"), true);
    assert.equal(git(repo, "branch", "--list", "feat/add_auth"), "");
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), false);
  });

  test("merging a milestone deletes its branch and clears the record", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-ms-branch-merge-")));
    repos.push(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "test");
    // Production ignores all of .gsd/; this repo tracks milestone docs like the
    // stale-worktree-cwd fixture, so only the record directory is ignored.
    appendFileSync(join(repo, ".git", "info", "exclude"), ".gsd/milestone-branches/\n");
    writeFileSync(join(repo, "README.md"), "# test\n");
    const msDir = join(repo, ".gsd", "milestones", "M050");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M050 Context\n");
    const roadmap = [
      "# M050: Test Milestone",
      "**Vision**: testing",
      "## Success Criteria",
      "- It works",
      "## Slices",
      "- [x] S01 — First slice",
    ].join("\n");
    writeFileSync(join(msDir, "ROADMAP.md"), roadmap);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    seedMergeReadyMilestone(repo, "M050");
    writeMilestoneBranchRecord(repo, "M050", "feat/test_milestone");

    const wtPath = createAutoWorktree(repo, "M050");
    assert.equal(git(wtPath, "branch", "--show-current"), "feat/test_milestone");
    writeFileSync(join(wtPath, "feature.txt"), "new feature\n");
    git(wtPath, "add", "feature.txt");
    git(wtPath, "commit", "-q", "-m", "feat: add feature");

    mergeMilestoneToMain(repo, "M050", roadmap);

    assert.ok(existsSync(join(repo, "feature.txt")), "merged content reached main");
    assert.equal(git(repo, "branch", "--list", "feat/test_milestone"), "");
    assert.equal(hasMilestoneBranchRecord(repo, "M050"), false);
  });
});
