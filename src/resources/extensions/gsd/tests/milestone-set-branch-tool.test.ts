// gsd-pi — gsd_milestone_set_branch records the user's choice and reports rejections.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { shouldBlockAutoUnitToolCall } from "../auto-unit-tool-scope.ts";
import { registerDbTools } from "../bootstrap/db-tools.ts";
import { shouldBlockQueueExecution } from "../bootstrap/write-gate.ts";
import { DISCUSS_TOOLS_ALLOWLIST } from "../constants.ts";
import { autoWorktreeBranch, hasMilestoneBranchRecord } from "../milestone-branch-registry.ts";
import { git, makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

function setBranchTool(): any {
  const tools: any[] = [];
  registerDbTools({ registerTool: (tool: any) => tools.push(tool) } as any);
  const tool = tools.find((t) => t.name === "gsd_milestone_set_branch");
  assert.ok(tool, "gsd_milestone_set_branch is registered");
  return tool;
}

describe("gsd_milestone_set_branch", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo("gsd-ms-set-branch-tool-");
  });

  afterEach(() => {
    removeRepo(repo);
  });

  test("records the chosen branch", async () => {
    const result = await setBranchTool().execute("call-1", { milestoneId: "M001", branch: "feat/add_auth" }, undefined, undefined, { cwd: repo });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /Recorded branch feat\/add_auth for M001/);
    assert.equal(autoWorktreeBranch(repo, "M001"), "feat/add_auth");
  });

  test("returns the rejection reason as an error and records nothing", async () => {
    git(repo, "branch", "feat/taken");
    const result = await setBranchTool().execute("call-2", { milestoneId: "M001", branch: "feat/taken" }, undefined, undefined, { cwd: repo });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Branch name rejected: .*already exists.* Ask the user for another name/);
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), false);
  });
});

describe("gsd_milestone_set_branch tool scope", () => {
  test("discuss-milestone may call it, other scoped units may not", () => {
    assert.equal(shouldBlockAutoUnitToolCall("discuss-milestone", "gsd_milestone_set_branch").block, false);
    assert.equal(shouldBlockAutoUnitToolCall("plan-milestone", "gsd_milestone_set_branch").block, true);
    assert.ok(DISCUSS_TOOLS_ALLOWLIST.includes("gsd_milestone_set_branch"));
  });

  test("queue mode allows it", () => {
    assert.equal(shouldBlockQueueExecution("gsd_milestone_set_branch", "", true).block, false);
  });
});
