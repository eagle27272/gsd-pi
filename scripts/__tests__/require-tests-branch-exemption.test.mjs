// Regression guard: require-tests.sh runs in the fast-gates job, which is a
// Mergify merge_condition. On a queue branch GITHUB_HEAD_REF is
// mergify/merge-queue/..., not the author's branch, so a branch-type exemption
// that fired on the PR must still fire here — otherwise the queue PR fails a
// check the source PR passed and Mergify ejects the car forever (#191).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "require-tests.sh");

/** A repo whose HEAD adds a source file and no test file. */
function repoWithUntestedSourceChange() {
  const dir = mkdtempSync(join(tmpdir(), "require-tests-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });

  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  // A global core.excludesFile can hide fixture files from `git add`.
  git("config", "core.excludesFile", "/dev/null");
  writeFileSync(join(dir, "README.md"), "seed\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  const base = git("rev-parse", "HEAD").trim();

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/feature.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "untested source change");

  return { dir, base };
}

function runRequireTests(branch) {
  const { dir, base } = repoWithUntestedSourceChange();
  try {
    const result = execFileSync("bash", [SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, PR_BASE_SHA: base, GITHUB_HEAD_REF: branch },
    });
    return { status: 0, output: result };
  } catch (error) {
    return { status: error.status, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an untested source change fails on an ordinary branch", () => {
  assert.equal(runRequireTests("feat/add-thing").status, 1);
});

test("a chore branch is exempt from the test requirement", () => {
  assert.equal(runRequireTests("chore/bump-dep").status, 0);
});

test("a chore branch stays exempt once Mergify rewrites it as a queue branch", () => {
  const { status, output } = runRequireTests("mergify/merge-queue/main/chore/bump-dep-abc123");
  assert.equal(status, 0, output);
});

test("a queue branch carrying a non-exempt PR still fails", () => {
  assert.equal(runRequireTests("mergify/merge-queue/main/feat/add-thing-abc123").status, 1);
});
