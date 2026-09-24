// gsd-pi — setMilestoneBranch: which names a milestone may use.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { writeIntegrationBranch } from "../git-service.ts";
import { setMilestoneBranch } from "../milestone-branch-choice.ts";
import {
  autoWorktreeBranch,
  hasMilestoneBranchRecord,
  writeMilestoneBranchRecord,
} from "../milestone-branch-registry.ts";
import { git, makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

function reasonOf(result: ReturnType<typeof setMilestoneBranch>): string {
  assert.equal(result.ok, false, "expected a rejection");
  return (result as { reason: string }).reason;
}

describe("setMilestoneBranch", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo("gsd-ms-branch-choice-");
  });

  afterEach(() => {
    removeRepo(repo);
  });

  test("records a valid new name, trimmed", () => {
    assert.deepEqual(setMilestoneBranch(repo, "M001", "  feat/add_auth  "), { ok: true, branch: "feat/add_auth" });
    assert.equal(autoWorktreeBranch(repo, "M001"), "feat/add_auth");
  });

  test("records the default name", () => {
    assert.deepEqual(setMilestoneBranch(repo, "M001", "milestone/M001"), { ok: true, branch: "milestone/M001" });
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), true);
  });

  test("lets the user change the name until the branch exists", () => {
    assert.equal(setMilestoneBranch(repo, "M001", "feat/one").ok, true);
    assert.equal(setMilestoneBranch(repo, "M001", "feat/two").ok, true);
    git(repo, "branch", "feat/two");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "feat/three")), /fixed once the branch exists/);
    assert.deepEqual(setMilestoneBranch(repo, "M001", "feat/two"), { ok: true, branch: "feat/two" });
  });

  test("a live legacy milestone/<MID> branch fixes the name", () => {
    git(repo, "branch", "milestone/M001");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "feat/x")), /milestone\/M001/);
    assert.deepEqual(setMilestoneBranch(repo, "M001", "milestone/M001"), { ok: true, branch: "milestone/M001" });
  });

  for (const bad of ["feat/bad name", "feat..x", "-feat", "refs/heads/feat/x", "", "   "]) {
    test(`rejects the invalid name ${JSON.stringify(bad)}`, () => {
      assert.match(reasonOf(setMilestoneBranch(repo, "M001", bad)), /not a valid git branch name/);
      assert.equal(hasMilestoneBranchRecord(repo, "M001"), false);
    });
  }

  test("rejects another milestone's default name", () => {
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "milestone/M002")), /reserved/);
  });

  test("rejects names reserved for gsd slice, quick-task, and workflow branches", () => {
    for (const name of ["gsd/M001/S01", "gsd/quick/1-fix", "gsd/hotfix/login"]) {
      assert.match(reasonOf(setMilestoneBranch(repo, "M001", name)), /reserves/);
    }
  });

  test("rejects a name another milestone recorded", () => {
    writeMilestoneBranchRecord(repo, "M002", "feat/shared");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "feat/shared")), /Milestone M002 already uses/);
  });

  test("rejects the milestone's integration branch", () => {
    writeIntegrationBranch(repo, "M001", "develop");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "develop")), /integration branch/);
  });

  test("rejects an existing branch", () => {
    git(repo, "branch", "feat/taken");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "feat/taken")), /already exists/);
  });

  test("rejects a name that differs from an existing branch only in case", () => {
    git(repo, "branch", "feat/Upper");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "feat/upper")), /clashes with the existing branch "feat\/Upper"/);
  });

  test("rejects a name that is a parent or child path of an existing branch", () => {
    git(repo, "branch", "feat");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "feat/x")), /clashes with the existing branch "feat"/);
    git(repo, "branch", "team/x");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "team")), /clashes with the existing branch "team\/x"/);
  });
});
