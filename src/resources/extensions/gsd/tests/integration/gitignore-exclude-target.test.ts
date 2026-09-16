/**
 * gitignore-exclude-target.test.ts
 *
 * ensureGitignore() writes GSD's baseline ignore patterns to the repo-local
 * `.git/info/exclude` rather than the tracked `.gitignore`, so bootstrapping a
 * project never dirties a file the whole team shares.
 *
 * "Already ignored" is evaluated across BOTH files, which makes a repo that
 * still carries the legacy committed `.gitignore` block a natural no-op.
 *
 * Uses real temporary git repos — no mocks.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { ensureGitignore } from "../../gitignore.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf-8" }).trim();
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-exclude-test-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  // A developer's global ignore file may list .gsd; these tests assert on
  // repo-local behaviour, so the global one must not interfere.
  git(dir, "config", "core.excludesFile", "/dev/null");
  writeFileSync(join(dir, "README.md"), "# init\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  git(dir, "branch", "-M", "main");
  return dir;
}

function excludePath(dir: string): string {
  return resolve(dir, git(dir, "rev-parse", "--git-path", "info/exclude"));
}

function patternsIn(file: string): Set<string> {
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─── Write target ────────────────────────────────────────────────────

test("ensureGitignore writes baseline patterns to .git/info/exclude", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  assert.equal(ensureGitignore(dir), true);

  const written = patternsIn(excludePath(dir));
  for (const pattern of [".gsd", ".gsd-worktrees/", ".bg-shell/", "node_modules/", ".DS_Store"]) {
    assert.ok(written.has(pattern), `expected ${pattern} in .git/info/exclude`);
  }
});

test("ensureGitignore creates no .gitignore in a fresh repo", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  ensureGitignore(dir);

  assert.ok(!existsSync(join(dir, ".gitignore")), "must not create a tracked .gitignore");
});

test("ensureGitignore leaves an existing .gitignore byte-identical", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  const gitignore = join(dir, ".gitignore");
  const original = "# hand written\ndist/\n";
  writeFileSync(gitignore, original);

  ensureGitignore(dir);

  assert.equal(readFileSync(gitignore, "utf-8"), original);
});

// ─── Union semantics with the legacy committed block ─────────────────

test("ensureGitignore is a no-op when .gitignore already carries the full baseline", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  // Reproduce a legacy repo: everything GSD would write, already committed to
  // .gitignore, and nothing in the exclude file.
  ensureGitignore(dir);
  const exclude = excludePath(dir);
  writeFileSync(join(dir, ".gitignore"), readFileSync(exclude, "utf-8"));
  writeFileSync(exclude, "");

  assert.equal(ensureGitignore(dir), false, "nothing is missing, so nothing is written");
  assert.equal(readFileSync(exclude, "utf-8"), "", "exclude must stay empty");
});

test("ensureGitignore appends only the patterns .gitignore is missing", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  writeFileSync(join(dir, ".gitignore"), ".gsd\nnode_modules/\n");

  assert.equal(ensureGitignore(dir), true);

  const written = patternsIn(excludePath(dir));
  assert.ok(!written.has(".gsd"), ".gsd is already covered by .gitignore");
  assert.ok(!written.has("node_modules/"), "node_modules/ is already covered by .gitignore");
  assert.ok(written.has(".bg-shell/"), ".bg-shell/ is genuinely missing and must be added");
});

test("ensureGitignore does not duplicate patterns already in the exclude file", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  ensureGitignore(dir);
  const before = readFileSync(excludePath(dir), "utf-8");
  assert.ok(patternsIn(excludePath(dir)).has(".gsd"), "first call must populate the exclude file");

  assert.equal(ensureGitignore(dir), false, "second call is idempotent");
  assert.equal(readFileSync(excludePath(dir), "utf-8"), before);
});

test("ensureGitignore preserves pre-existing exclude content", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  const exclude = excludePath(dir);
  writeFileSync(exclude, "# user's own rules\nscratch/\n");

  ensureGitignore(dir);

  const content = readFileSync(exclude, "utf-8");
  assert.match(content, /# user's own rules/);
  assert.ok(patternsIn(exclude).has("scratch/"), "user's own pattern must survive");
  assert.ok(patternsIn(exclude).has(".gsd"), "baseline must still be appended");
});

// ─── Worktrees ───────────────────────────────────────────────────────

test("ensureGitignore from a linked worktree writes the main repo's exclude file", (t) => {
  const dir = makeTempRepo();
  const wt = join(dir, "..", `${crypto.randomUUID()}-wt`);
  t.after(() => { cleanup(dir); cleanup(wt); });

  git(dir, "worktree", "add", wt, "-b", "feature");

  assert.equal(ensureGitignore(wt), true);

  const mainExclude = join(dir, ".git", "info", "exclude");
  assert.ok(patternsIn(mainExclude).has(".gsd"), "baseline lands in the shared common dir");
  assert.ok(!existsSync(join(wt, ".gitignore")), "must not create a .gitignore in the worktree");
});

// ─── Opt-out and non-repos ───────────────────────────────────────────

test("ensureGitignore writes nothing anywhere when manageGitignore is false", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  assert.equal(ensureGitignore(dir, { manageGitignore: false }), false);
  assert.ok(!existsSync(join(dir, ".gitignore")), "must not create .gitignore");
  assert.equal(patternsIn(excludePath(dir)).size, 0, "must not write exclude");
});

test("ensureGitignore writes nothing outside a git repo", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-exclude-nogit-"));
  t.after(() => { cleanup(dir); });

  assert.equal(ensureGitignore(dir), false);
  assert.ok(!existsSync(join(dir, ".gitignore")), "must not create .gitignore");
});
