import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatCleanKeepReason,
  getStatus,
  handleWorktree,
  type WorktreeStatus,
} from "../commands-worktree.ts";
import { withCommandCwd } from "../commands/context.ts";
import { createWorktree } from "../worktree-manager.ts";
import {
  disableDebug,
  enableDebug,
  getDebugCounters,
} from "../debug-logger.ts";

function mkStatus(over: Partial<WorktreeStatus>): WorktreeStatus {
  const name = over.name ?? "feat-x";
  return {
    name,
    path: `/repo/.gsd/worktrees/${name}`,
    branch: `gsd/${name}`,
    exists: true,
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    uncommitted: false,
    commits: 0,
    ...over,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function makeRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-worktree-command-"));
  git(base, ["init", "-b", "main"]);
  git(base, ["config", "user.name", "Test User"]);
  git(base, ["config", "user.email", "test@example.com"]);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, "README.md"), "# Test\n", "utf-8");
  git(base, ["add", "."]);
  git(base, ["commit", "-m", "chore: init"]);
  return base;
}

function createCommittedWorktree(base: string, name: string): void {
  const wt = createWorktree(base, name);
  writeFileSync(join(wt.path, `${name}.txt`), `${name}\n`, "utf-8");
  git(wt.path, ["add", "."]);
  git(wt.path, ["commit", "-m", `feat: ${name}`]);
}

function createMockCtx() {
  const notifications: { message: string; level: string }[] = [];
  return {
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };
}

test("clean keep reason shows uncommitted-only worktrees clearly", () => {
  const reason = formatCleanKeepReason(mkStatus({ uncommitted: true }));
  assert.equal(reason, "uncommitted changes");
});

test("clean keep reason includes uncommitted context with changed files", () => {
  const reason = formatCleanKeepReason(mkStatus({ filesChanged: 2, uncommitted: true }));
  assert.equal(reason, "2 changed files, uncommitted");
});

test("clean keep reason flags missing directory with prune hint", () => {
  const reason = formatCleanKeepReason(mkStatus({ exists: false }));
  assert.equal(reason, "directory missing — run 'git worktree prune' to unregister");
});

test("clean keep reason reports changed files without uncommitted suffix", () => {
  const reason = formatCleanKeepReason(mkStatus({ filesChanged: 2, uncommitted: false }));
  assert.equal(reason, "2 changed files");
});

test("clean keep reason uses singular form for a single changed file", () => {
  const reason = formatCleanKeepReason(mkStatus({ filesChanged: 1, uncommitted: false }));
  assert.equal(reason, "1 changed file");
});

test("getStatus reports uncommitted when the worktree state cannot be read", () => {
  const base = makeRepo();
  const unreadable = mkdtempSync(join(tmpdir(), "gsd-not-a-repo-"));
  try {
    // `uncommitted` gates the auto-commit before a squash merge, so an
    // unreadable worktree must not be reported as clean.
    const status = getStatus(base, "ghost", unreadable, "main");
    assert.equal(status.uncommitted, true, "unknown worktree state must fail closed");
  } finally {
    rmSync(unreadable, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

test("getStatus does not reuse a cached clean verdict for a worktree that just became dirty", () => {
  const base = makeRepo();
  try {
    const wt = createWorktree(base, "cache-a");
    const clean = getStatus(base, "cache-a", wt.path, "main");
    assert.equal(clean.uncommitted, false, "a fresh worktree starts clean");

    writeFileSync(join(wt.path, "scratch.ts"), "export const x = 1;\n", "utf-8");
    const dirty = getStatus(base, "cache-a", wt.path, "main");
    assert.equal(dirty.uncommitted, true, "a worktree dirtied within the cache TTL must read as dirty");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("worktree remove reports the quarantine path when dirty work is preserved", async () => {
  const base = makeRepo();
  try {
    const wt = createWorktree(base, "dirty-a");
    writeFileSync(join(wt.path, "scratch.ts"), "export const x = 1;\n", "utf-8");

    const ctx = createMockCtx();
    await withCommandCwd(base, async () => {
      await handleWorktree("remove dirty-a --force", ctx as any);
    });

    const message = ctx.notifications.map((n) => n.message).join("\n");
    assert.match(message, /quarantine/i, "the user must be told the work was quarantined");
    assert.match(
      message,
      /\.gsd[/\\]quarantine[/\\]worktrees[/\\]dirty-a-/,
      `the quarantine path must appear in the output, got: ${message}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("worktree merge carries uncommitted work into the merge instead of quarantining it", async () => {
  const base = makeRepo();
  try {
    const wt = createWorktree(base, "dirty-b");
    writeFileSync(join(wt.path, "feature.ts"), "export const shipped = true;\n", "utf-8");
    git(wt.path, ["add", "."]);
    git(wt.path, ["commit", "-m", "feat: dirty-b"]);
    writeFileSync(join(wt.path, "scratch.ts"), "export const x = 1;\n", "utf-8");

    const ctx = createMockCtx();
    await withCommandCwd(base, async () => {
      await handleWorktree("merge dirty-b", ctx as any);
    });

    const message = ctx.notifications.map((n) => n.message).join("\n");
    assert.match(message, /Merged dirty-b/, `merge should succeed, got: ${message}`);
    assert.ok(
      existsSync(join(base, "scratch.ts")),
      "uncommitted work must reach main via auto-commit, not be left behind",
    );
    assert.doesNotMatch(message, /quarantine/i, "nothing should need quarantining on this path");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("worktree list detects main branch once for the command", async (t) => {
  if (process.env.GSD_ENABLE_NATIVE_GSD_GIT === "1") {
    t.skip("git invocation regression is specific to the CLI fallback path");
    return;
  }

  const base = makeRepo();
  try {
    createCommittedWorktree(base, "feature-a");
    createCommittedWorktree(base, "feature-b");

    const ctx = createMockCtx();
    enableDebug(base);
    try {
      await withCommandCwd(base, async () => {
        await handleWorktree("list", ctx as any);
      });

      assert.equal(ctx.notifications.length, 1);
      assert.match(ctx.notifications[0].message, /Worktrees — 2/);
      assert.equal(getDebugCounters().gitInvocations, 12);
    } finally {
      disableDebug();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
