// git-env-scrub.test.ts — regression for #8 follow-up
//
// A raw `execFileSync("git", …)` inherits the caller's GIT_DIR /
// GIT_WORK_TREE / GIT_INDEX_FILE. A GSD invoked from a git hook, another
// worktree's terminal, or any shell that pre-set those vars then reads and
// WRITES a repository that is not the one it was pointed at.
//
// Each test here builds two real repositories — a `bystander` the leaked env
// vars point at, and a `target` the operation is actually given — runs the
// operation, and asserts the bystander was neither read from nor written to.
//
// A scrubbed call site builds its env with gitNoPromptEnv(), which removes the
// seven redirecting vars from the live process.env; an unscrubbed one inherits
// them. That difference is the whole discriminator, so the `git()` oracle below
// must scrub too — otherwise it would report on the bystander, not its `cwd`.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitNoPromptEnv } from "../git-constants.js";
import { createCheckpoint, cleanupCheckpoint, rollbackToCheckpoint } from "../safety/git-checkpoint.js";
import { readCommittedHeadSha } from "../safety/file-change-validator.js";
import { captureRootDirtySnapshot } from "../root-write-leak-guard.js";
import { removeMergeStateFiles } from "../worktree-git-recovery.js";
import { abortAndReset } from "../git-self-heal.js";
import { nativeResetHard } from "../native-git-bridge.js";
import { getRecentlyChangedFiles } from "../diff-context.js";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.js";
import { clearPathCache, gsdRoot } from "../paths.js";

/**
 * Assertion oracle. Scrubs the redirecting vars itself so it always reports on
 * `cwd` — without this the oracle would follow the leak it is meant to detect.
 */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: gitNoPromptEnv(),
  }).trim();
}

function initRepo(prefix: string): string {
  // realpath so macOS /var -> /private/var does not defeat path comparisons.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "seed.txt"), `${prefix}\n`);
  git(["add", "."], dir);
  git(["commit", "-m", `seed ${prefix}`], dir);
  return dir;
}

describe("git env scrub: leaked GIT_DIR/GIT_WORK_TREE must not redirect GSD git operations", () => {
  let bystander: string;
  let target: string;
  let savedGitDir: string | undefined;
  let savedWorkTree: string | undefined;

  beforeEach(() => {
    bystander = initRepo("gsd-bystander-");
    target = initRepo("gsd-target-");
    savedGitDir = process.env.GIT_DIR;
    savedWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(bystander, ".git");
    process.env.GIT_WORK_TREE = bystander;
  });

  afterEach(() => {
    if (savedGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = savedGitDir;
    if (savedWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = savedWorkTree;
    rmSync(bystander, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  test("createCheckpoint writes the checkpoint ref in the target, not the bystander", () => {
    const sha = createCheckpoint(target, "unit-1");

    assert.equal(sha, git(["rev-parse", "HEAD"], target));
    assert.equal(git(["rev-parse", "--verify", "refs/gsd/checkpoints/unit-1"], target), sha);
    assert.equal(git(["for-each-ref", "--format=%(refname)", "refs/gsd/"], bystander), "");
  });

  test("cleanupCheckpoint deletes the target's ref and leaves the bystander's intact", () => {
    const targetSha = git(["rev-parse", "HEAD"], target);
    const bystanderSha = git(["rev-parse", "HEAD"], bystander);
    git(["update-ref", "refs/gsd/checkpoints/unit-1", targetSha], target);
    git(["update-ref", "refs/gsd/checkpoints/unit-1", bystanderSha], bystander);

    cleanupCheckpoint(target, "unit-1");

    assert.equal(git(["for-each-ref", "--format=%(refname)", "refs/gsd/"], target), "");
    assert.equal(
      git(["rev-parse", "--verify", "refs/gsd/checkpoints/unit-1"], bystander),
      bystanderSha,
    );
  });

  test("rollbackToCheckpoint resets the target and leaves the bystander's HEAD and stash alone", () => {
    const checkpoint = git(["rev-parse", "HEAD"], target);
    writeFileSync(join(target, "seed.txt"), "target second\n");
    git(["commit", "-am", "target second"], target);

    // Uncommitted work in the bystander: an unscrubbed rollback stashes it.
    writeFileSync(join(bystander, "seed.txt"), "bystander dirty\n");
    const bystanderHead = git(["rev-parse", "HEAD"], bystander);

    rollbackToCheckpoint(target, "unit-1", checkpoint);

    assert.equal(git(["rev-parse", "HEAD"], target), checkpoint);
    assert.equal(git(["rev-parse", "HEAD"], bystander), bystanderHead);
    assert.equal(git(["stash", "list"], bystander), "");
  });

  test("readCommittedHeadSha reports the target's HEAD", () => {
    assert.equal(readCommittedHeadSha(target), git(["rev-parse", "HEAD"], target));
  });

  test("captureRootDirtySnapshot reports the target's untracked files", () => {
    writeFileSync(join(target, "target-only.txt"), "t\n");
    writeFileSync(join(bystander, "bystander-only.txt"), "b\n");

    const snapshot = captureRootDirtySnapshot(target);

    assert.ok(snapshot.has("target-only.txt"), "expected the target's untracked file");
    assert.ok(!snapshot.has("bystander-only.txt"), "must not report the bystander's untracked file");
  });

  test("removeMergeStateFiles deletes the target's merge state, not the bystander's", () => {
    const targetMergeHead = join(target, ".git", "MERGE_HEAD");
    const bystanderMergeHead = join(bystander, ".git", "MERGE_HEAD");
    writeFileSync(targetMergeHead, `${git(["rev-parse", "HEAD"], target)}\n`);
    writeFileSync(bystanderMergeHead, `${git(["rev-parse", "HEAD"], bystander)}\n`);

    removeMergeStateFiles(target, "test");

    assert.equal(existsSync(targetMergeHead), false, "target's MERGE_HEAD should be removed");
    assert.equal(existsSync(bystanderMergeHead), true, "bystander's MERGE_HEAD must survive");
  });

  test("abortAndReset does not stash or reset the bystander's working tree", () => {
    writeFileSync(join(bystander, "seed.txt"), "bystander dirty\n");

    abortAndReset(target);

    assert.equal(git(["stash", "list"], bystander), "");
    assert.equal(git(["status", "--porcelain"], bystander).length > 0, true);
  });

  test("nativeResetHard discards the target's changes and leaves the bystander dirty", () => {
    writeFileSync(join(target, "seed.txt"), "target dirty\n");
    writeFileSync(join(bystander, "seed.txt"), "bystander dirty\n");

    nativeResetHard(target);

    assert.equal(git(["status", "--porcelain"], target), "");
    assert.notEqual(git(["status", "--porcelain"], bystander), "");
  });

  // Covers the async execFile path in diff-context alongside its sync fallback.
  test("getRecentlyChangedFiles lists the target's changes, not the bystander's", async () => {
    writeFileSync(join(target, "target-change.txt"), "t\n");
    writeFileSync(join(bystander, "bystander-change.txt"), "b\n");

    const files = await getRecentlyChangedFiles(target);

    assert.ok(files.includes("target-change.txt"), `expected target-change.txt in ${files.join(",")}`);
    assert.ok(!files.includes("bystander-change.txt"), "must not list the bystander's change");
  });

  // gitSpawnBuffer path: the snapshot must not move when only the bystander changes.
  test("captureVerificationSourceSnapshot ignores churn in the bystander", () => {
    const first = captureVerificationSourceSnapshot([{ id: "t", cwd: target }]);
    assert.equal(first.ok, true, "snapshot of the target should succeed");

    writeFileSync(join(bystander, "bystander-churn.txt"), "b\n");
    const second = captureVerificationSourceSnapshot([{ id: "t", cwd: target }]);

    assert.deepEqual(second, first);
  });

  // gitSpawn path: `rev-parse --show-toplevel` anchors GSD state discovery.
  test("gsdRoot does not anchor the target to the bystander's .gsd", () => {
    mkdirSync(join(bystander, ".gsd"), { recursive: true });
    clearPathCache();

    const resolved = gsdRoot(target);

    assert.ok(
      !resolved.startsWith(bystander),
      `gsdRoot resolved into the bystander repo: ${resolved}`,
    );
  });
});
