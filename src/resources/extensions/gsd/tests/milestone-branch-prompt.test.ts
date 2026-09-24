// gsd-pi — Asking for a milestone branch name: config display, TUI prompt, discuss question.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatConfigText } from "../config-overlay.ts";
import { ensureMilestoneBranchName, renderMilestoneBranchQuestion } from "../milestone-branch-choice.ts";
import { autoWorktreeBranch, hasMilestoneBranchRecord, writeMilestoneBranchRecord } from "../milestone-branch-registry.ts";
import { git, makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

function writeGitPrefs(repo: string, lines: string[]): void {
  writeFileSync(join(repo, ".gsd", "PREFERENCES.md"), ["---", "git:", ...lines.map((l) => `  ${l}`), "---", ""].join("\n"));
}

function fakeCtx(answers: Array<string | undefined>, hasUI = true) {
  const prompts: Array<{ title: string; placeholder?: string }> = [];
  const notices: string[] = [];
  const ctx = {
    hasUI,
    ui: {
      input: async (title: string, placeholder?: string) => {
        prompts.push({ title, placeholder });
        return answers.shift();
      },
      notify: (message: string) => {
        notices.push(message);
      },
    },
  };
  return { ctx, prompts, notices };
}

describe("milestone branch prompt", () => {
  let repo: string;
  let gsdHome: string;
  let previousGsdHome: string | undefined;

  beforeEach(() => {
    repo = makeRepo("gsd-ms-branch-prompt-");
    gsdHome = mkdtempSync(join(tmpdir(), "gsd-ms-branch-home-"));
    previousGsdHome = process.env.GSD_HOME;
    process.env.GSD_HOME = gsdHome;
  });

  afterEach(() => {
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    rmSync(gsdHome, { recursive: true, force: true });
    removeRepo(repo);
  });

  describe("milestone branch preference display", () => {
    test("the config overlay shows the milestone branch format", () => {
      writeGitPrefs(repo, ["milestone_branch_format: \"<change-type>/<short_snake_case_summary>\""]);
      const text = formatConfigText({ basePath: repo });
      assert.match(text, /Milestone branch format/);
      assert.match(text, /<change-type>\/<short_snake_case_summary>/);
    });
  });

  describe("ensureMilestoneBranchName", () => {
    test("a headless session records nothing and does not prompt", async () => {
      const { ctx, prompts } = fakeCtx(["feat/x"], false);
      await ensureMilestoneBranchName(ctx, repo, "M001", "Auth");
      assert.equal(prompts.length, 0);
      assert.equal(hasMilestoneBranchRecord(repo, "M001"), false);
    });

    test("an existing record means nobody is asked again", async () => {
      writeMilestoneBranchRecord(repo, "M001", "feat/chosen");
      const { ctx, prompts } = fakeCtx(["feat/other"]);
      await ensureMilestoneBranchName(ctx, repo, "M001", "Auth");
      assert.equal(prompts.length, 0);
      assert.equal(autoWorktreeBranch(repo, "M001"), "feat/chosen");
    });

    test("a live legacy milestone/<MID> branch is recorded without a prompt", async () => {
      git(repo, "branch", "milestone/M003");
      const { ctx, prompts } = fakeCtx(["feat/x"]);
      await ensureMilestoneBranchName(ctx, repo, "M003", "In flight");
      assert.equal(prompts.length, 0);
      assert.equal(autoWorktreeBranch(repo, "M003"), "milestone/M003");
      assert.equal(hasMilestoneBranchRecord(repo, "M003"), true);
    });

    test("records the typed name and shows the milestone and default in the prompt", async () => {
      const { ctx, prompts } = fakeCtx(["feat/add_auth"]);
      await ensureMilestoneBranchName(ctx, repo, "M001", "Auth");
      assert.equal(autoWorktreeBranch(repo, "M001"), "feat/add_auth");
      assert.equal(prompts.length, 1);
      assert.match(prompts[0]!.title, /Branch name for M001 \(Auth\)/);
      assert.match(prompts[0]!.title, /milestone\/M001/);
      assert.equal(prompts[0]!.placeholder, "milestone/M001");
    });

    test("an empty answer records the default", async () => {
      const { ctx } = fakeCtx([""]);
      await ensureMilestoneBranchName(ctx, repo, "M001", undefined);
      assert.equal(autoWorktreeBranch(repo, "M001"), "milestone/M001");
      assert.equal(hasMilestoneBranchRecord(repo, "M001"), true);
    });

    test("Esc records the default", async () => {
      const { ctx } = fakeCtx([undefined]);
      await ensureMilestoneBranchName(ctx, repo, "M001", undefined);
      assert.equal(hasMilestoneBranchRecord(repo, "M001"), true);
      assert.equal(autoWorktreeBranch(repo, "M001"), "milestone/M001");
    });

    test("a rejected name shows the reason and asks again", async () => {
      git(repo, "branch", "feat/taken");
      const { ctx, prompts, notices } = fakeCtx(["feat/taken", "feat/free"]);
      await ensureMilestoneBranchName(ctx, repo, "M001", "Auth");
      assert.equal(prompts.length, 2);
      assert.match(notices[0] ?? "", /already exists/);
      assert.equal(autoWorktreeBranch(repo, "M001"), "feat/free");
    });

    test("the prompt shows the team convention when one is set", async () => {
      writeGitPrefs(repo, ["isolation: branch", "milestone_branch_format: \"<change-type>/<summary>\""]);
      const { ctx, prompts } = fakeCtx(["feat/add_auth"]);
      await ensureMilestoneBranchName(ctx, repo, "M001", "Auth");
      assert.match(prompts[0]!.title, /Convention: <change-type>\/<summary>/);
    });
  });

  describe("renderMilestoneBranchQuestion", () => {
    test("renders nothing when git isolation is off", () => {
      assert.equal(renderMilestoneBranchQuestion(repo), "");
      writeGitPrefs(repo, ["isolation: none"]);
      assert.equal(renderMilestoneBranchQuestion(repo), "");
    });

    test("without a format, recommends milestone/<ID>", () => {
      writeGitPrefs(repo, ["isolation: branch"]);
      const block = renderMilestoneBranchQuestion(repo);
      assert.match(block, /`milestone_branch_<ID>`/);
      assert.match(block, /`gsd_milestone_set_branch`/);
      assert.match(block, /`milestone\/<ID>`, labeled "\(Recommended\)"/);
      assert.doesNotMatch(block, /team convention/);
    });

    test("with a format, recommends a name that follows it", () => {
      writeGitPrefs(repo, ["isolation: worktree", "milestone_branch_format: \"<change-type>/<summary>\""]);
      const block = renderMilestoneBranchQuestion(repo);
      assert.match(block, /team convention `<change-type>\/<summary>`, labeled "\(Recommended\)"/);
      assert.match(block, /must not contain `depth_verification`/);
    });
  });
});
