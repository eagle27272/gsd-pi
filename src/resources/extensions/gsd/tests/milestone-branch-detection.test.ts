// gsd-pi — Code that recognizes milestone branches also recognizes recorded names.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { writeFileSync } from "node:fs";

import { _selectResumableMilestone, resolveIsolationNoneBranchCheckout } from "../auto-start.ts";
import {
  milestoneMetaPath,
  readIntegrationBranch,
  resolveMilestoneIntegrationBranch,
  writeIntegrationBranch,
} from "../git-service.ts";
import { milestoneIdFromDefaultBranch, writeMilestoneBranchRecord } from "../milestone-branch-registry.ts";
import { listWorktrees } from "../worktree-manager.ts";
import { git, makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

describe("milestone branch detection with recorded names", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo("gsd-ms-branch-detect-");
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");
  });

  afterEach(() => {
    removeRepo(repo);
  });

  test("writeIntegrationBranch refuses a recorded milestone branch", () => {
    writeIntegrationBranch(repo, "M002", "feat/add_auth");
    assert.equal(readIntegrationBranch(repo, "M002"), null);
    writeIntegrationBranch(repo, "M002", "main");
    assert.equal(readIntegrationBranch(repo, "M002"), "main");
  });

  test("a recorded milestone branch is never used as a merge target", () => {
    git(repo, "branch", "feat/add_auth");
    writeFileSync(milestoneMetaPath(repo, "M002"), JSON.stringify({ integrationBranch: "feat/add_auth" }));
    const resolution = resolveMilestoneIntegrationBranch(repo, "M002");
    assert.notEqual(resolution.status, "recorded");
    assert.notEqual(resolution.effectiveBranch, "feat/add_auth");
  });

  test("listWorktrees reports a recorded branch with no worktree as an orphan of its milestone", () => {
    git(repo, "branch", "feat/add_auth");
    const orphan = listWorktrees(repo).find((wt) => wt.branch === "feat/add_auth");
    assert.ok(orphan, "orphan entry for the recorded branch");
    assert.equal(orphan.name, "M001");
    assert.equal(orphan.orphan, true);
  });
});

describe("pure branch decisions accept a milestone lookup", () => {
  test("_selectResumableMilestone resolves recorded names through the lookup", () => {
    const picked = _selectResumableMilestone(
      ["feat/add_auth", "milestone/M001"],
      new Set(),
      () => true,
      () => 1,
      (branch) => (branch === "feat/add_auth" ? "M002" : milestoneIdFromDefaultBranch(branch)),
    );
    assert.equal(picked, "M002");
  });

  test("resolveIsolationNoneBranchCheckout leaves a recorded milestone branch", () => {
    const isMilestone = (branch: string) => branch === "feat/add_auth";
    assert.equal(resolveIsolationNoneBranchCheckout("feat/add_auth", "main", "none", true, isMilestone), "main");
    assert.equal(resolveIsolationNoneBranchCheckout("feat/other", "main", "none", true, isMilestone), null);
  });
});
