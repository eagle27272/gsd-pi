// gsd-pi — Temp git repositories for milestone branch name tests.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: GIT_ENV,
  }).trim();
}

/** A repo on `main` with one commit and an ignored `.gsd/`, as gsd sets up in production. */
export function makeRepo(prefix: string): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  appendFileSync(join(repo, ".git", "info", "exclude"), ".gsd\n");
  writeFileSync(join(repo, "README.md"), "# test\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "init");
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  return repo;
}

export function removeRepo(repo: string): void {
  rmSync(repo, { recursive: true, force: true });
}
