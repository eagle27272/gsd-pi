// gsd-pi — Milestone branch registry: records, default names, reverse lookup.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GSDError } from "../errors.ts";
import {
  autoWorktreeBranch,
  forgetMilestoneBranchIfDeleted,
  hasMilestoneBranchRecord,
  isMilestoneBranch,
  listMergedMilestoneBranches,
  listMilestoneBranches,
  milestoneIdForBranch,
  readMilestoneBranchRecord,
  writeMilestoneBranchRecord,
} from "../milestone-branch-registry.ts";
import { worktreePath } from "../worktree-manager.ts";
import { git, makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

describe("milestone branch registry", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo("gsd-ms-branch-registry-");
  });

  afterEach(() => {
    removeRepo(repo);
  });

  test("a milestone with no record uses milestone/<MID>", () => {
    assert.equal(autoWorktreeBranch(repo, "M001"), "milestone/M001");
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), false);
  });

  test("a recorded name replaces the default", () => {
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");
    assert.equal(autoWorktreeBranch(repo, "M001"), "feat/add_auth");
    assert.equal(readMilestoneBranchRecord(repo, "M001"), "feat/add_auth");
    assert.ok(existsSync(join(repo, ".gsd", "milestone-branches", "M001.json")));
  });

  test("a worktree path and the project root read the same record", () => {
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");
    const wt = worktreePath(repo, "M001");
    mkdirSync(wt, { recursive: true });
    assert.equal(hasMilestoneBranchRecord(wt, "M001"), true);
    assert.equal(autoWorktreeBranch(wt, "M001"), "feat/add_auth");
  });

  test("milestoneIdForBranch resolves default names and recorded names", () => {
    writeMilestoneBranchRecord(repo, "M002", "feat/billing");
    assert.equal(milestoneIdForBranch(repo, "milestone/M001"), "M001");
    assert.equal(milestoneIdForBranch(repo, "feat/billing"), "M002");
    assert.equal(milestoneIdForBranch(repo, "main"), null);
    assert.equal(isMilestoneBranch(repo, "feat/billing"), true);
    assert.equal(isMilestoneBranch(repo, "feat/other"), false);
  });

  test("listMilestoneBranches includes a recorded name only once its branch exists", () => {
    git(repo, "branch", "milestone/M001");
    writeMilestoneBranchRecord(repo, "M002", "feat/billing");
    writeMilestoneBranchRecord(repo, "M003", "feat/not_created_yet");
    git(repo, "branch", "feat/billing");
    assert.deepEqual(listMilestoneBranches(repo).sort(), ["feat/billing", "milestone/M001"]);
  });

  test("listMergedMilestoneBranches returns merged default and recorded branches only", () => {
    git(repo, "branch", "milestone/M001");
    git(repo, "branch", "feat/billing");
    git(repo, "branch", "feat/unrelated");
    writeMilestoneBranchRecord(repo, "M002", "feat/billing");
    assert.deepEqual(listMergedMilestoneBranches(repo, "main").sort(), ["feat/billing", "milestone/M001"]);
  });

  test("an unreadable record stops autoWorktreeBranch, and scans skip it", () => {
    mkdirSync(join(repo, ".gsd", "milestone-branches"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "milestone-branches", "M001.json"), "{not json");
    assert.throws(() => autoWorktreeBranch(repo, "M001"), /M001\.json/);
    assert.equal(milestoneIdForBranch(repo, "feat/anything"), null);
  });

  test("writeMilestoneBranchRecord rejects a traversal-shaped milestone ID and writes nothing", () => {
    for (const bad of ["../escaped", "../../escaped", "a/b", "a\\b", "..", ".", ""]) {
      assert.throws(() => writeMilestoneBranchRecord(repo, bad, "x"), GSDError);
    }
    assert.equal(existsSync(join(repo, ".gsd", "escaped.json")), false);
    assert.equal(existsSync(join(repo, "escaped.json")), false);
    assert.equal(existsSync(join(repo, "..", "escaped.json")), false);
  });

  test("forgetMilestoneBranchIfDeleted keeps the record until the branch is gone", () => {
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");
    git(repo, "branch", "feat/add_auth");
    forgetMilestoneBranchIfDeleted(repo, "M001");
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), true);

    git(repo, "branch", "-D", "feat/add_auth");
    forgetMilestoneBranchIfDeleted(repo, "M001");
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), false);
  });
});
