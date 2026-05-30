// Project/App: gsd-pi
// File Purpose: Bootstrap behavior tests for completed milestone orphan merges.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapAutoSession } from "../auto-start.ts";
import { AutoSession } from "../auto/session.ts";
import {
  closeDatabase,
  insertMilestone,
  openDatabase,
} from "../gsd-db.ts";

function runGit(base: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: base,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepoWithUnmergedCompletedMilestone(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-orphan-bootstrap-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\ngit:\n  isolation: \"branch\"\n---\n",
  );
  runGit(base, ["init"]);
  runGit(base, ["config", "user.email", "test@test.com"]);
  runGit(base, ["config", "user.name", "Test"]);
  writeFileSync(join(base, "README.md"), "# test\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "init"]);
  runGit(base, ["branch", "-M", "main"]);

  runGit(base, ["checkout", "-b", "milestone/M002"]);
  writeFileSync(join(base, "m002.txt"), "complete but unmerged\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "feat: M002 work"]);
  runGit(base, ["checkout", "main"]);

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M002", title: "Completed milestone", status: "complete" });
  insertMilestone({ id: "M003", title: "Next milestone", status: "active" });
  closeDatabase();

  return base;
}

function makeRepoWithStrandedActiveMilestone(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-stranded-bootstrap-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\ngit:\n  isolation: \"none\"\n---\n",
  );
  runGit(base, ["init"]);
  runGit(base, ["config", "user.email", "test@test.com"]);
  runGit(base, ["config", "user.name", "Test"]);
  writeFileSync(join(base, "README.md"), "# test\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "init"]);
  runGit(base, ["branch", "-M", "main"]);

  runGit(base, ["checkout", "-b", "milestone/M001"]);
  writeFileSync(join(base, "m001.txt"), "in-progress stranded work\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "feat: M001 in progress"]);
  runGit(base, ["checkout", "main"]);

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Active milestone", status: "active" });
  closeDatabase();

  return base;
}

function makeCtx(notifications: Array<{ message: string; level?: string }>) {
  const model = { provider: "claude-code", id: "claude-sonnet-4-6", contextWindow: 128000 };
  return {
    ui: {
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
      setStatus: () => {},
      setWidget: () => {},
    },
    model,
    modelRegistry: {
      getAvailable: () => [model],
      isProviderRequestReady: () => true,
      getProviderAuthMode: () => "oauth",
    },
    sessionManager: {
      getSessionId: () => "orphan-bootstrap-test",
      getSessionFile: () => null,
      getEntries: () => [],
    },
  };
}

test("bootstrap aborts before starting next milestone when completed orphan merge fails", async () => {
  const base = makeRepoWithUnmergedCompletedMilestone();
  const previousCwd = process.cwd();
  const s = new AutoSession();
  const mergeCalls: string[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];

  try {
    const ready = await bootstrapAutoSession(
      s,
      makeCtx(notifications) as any,
      {
        getThinkingLevel: () => "medium",
        getActiveTools: () => [],
        events: { emit: () => {} },
      } as any,
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => true,
        registerSigtermHandler: () => {},
        registerAutoWorkerForSession: () => {},
        lockBase: () => base,
        buildLifecycle: () => ({
          adoptSessionRoot: (sessionBase: string, originalBase?: string) => {
            s.basePath = sessionBase;
            if (originalBase !== undefined) {
              s.originalBasePath = originalBase;
            } else if (!s.originalBasePath) {
              s.originalBasePath = sessionBase;
            }
          },
          exitMilestone: (milestoneId: string) => {
            mergeCalls.push(milestoneId);
            return {
              ok: false,
              reason: "teardown-failed",
              cause: new Error("synthetic merge failure"),
            };
          },
          enterMilestone: () => ({ ok: true, mode: "none", path: base }),
          // ADR-016 phase 2 / B4 (#5622): the orphan-merge dance now goes
          // through `adoptOrphanWorktree`. The mock invokes the callback
          // and returns its result without exercising the swap-revert
          // protocol — this test only cares about the merge call being
          // recorded and the bootstrap returning `false` on failure.
          adoptOrphanWorktree: <T extends { merged: boolean }>(
            _mid: string,
            _base: string,
            run: () => T,
          ): T => run(),
        }) as any,
      },
      {
        classification: "none",
        lock: null,
        pausedSession: null,
        state: null,
        recovery: null,
        recoveryPrompt: null,
        recoveryToolCallCount: 0,
        artifactSatisfied: false,
        hasResumableDiskState: false,
        isBootstrapCrash: false,
      },
    );

    assert.equal(ready, false);
    assert.deepEqual(mergeCalls, ["M002"]);
    assert.equal(s.active, false);
    assert.match(
      notifications.map((entry) => entry.message).join("\n"),
      /Could not merge orphan milestone M002: synthetic merge failure/,
    );
  } finally {
    try {
      closeDatabase();
    } catch {}
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("bootstrap adopts stranded active branch even when isolation is none", async () => {
  const base = makeRepoWithStrandedActiveMilestone();
  const previousCwd = process.cwd();
  const s = new AutoSession();
  const adoptCalls: Array<{ milestoneId: string; mode: string }> = [];
  const enterCalls: string[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];

  try {
    const ready = await bootstrapAutoSession(
      s,
      makeCtx(notifications) as any,
      {
        getThinkingLevel: () => "medium",
        getActiveTools: () => [],
        events: { emit: () => {} },
      } as any,
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => false,
        registerSigtermHandler: () => {},
        registerAutoWorkerForSession: () => {},
        lockBase: () => base,
        buildLifecycle: () => ({
          adoptSessionRoot: (sessionBase: string, originalBase?: string) => {
            s.basePath = sessionBase;
            if (originalBase !== undefined) {
              s.originalBasePath = originalBase;
            } else if (!s.originalBasePath) {
              s.originalBasePath = sessionBase;
            }
          },
          enterMilestone: (milestoneId: string) => {
            enterCalls.push(milestoneId);
            return { ok: true, mode: "none", path: base };
          },
          adoptStrandedMilestone: (
            milestoneId: string,
            sessionBase: string,
            _ctx: unknown,
            opts: { mode: "worktree" | "branch" },
          ) => {
            adoptCalls.push({ milestoneId, mode: opts.mode });
            s.basePath = sessionBase;
            s.originalBasePath = sessionBase;
            s.strandedRecoveryIsolationMode = opts.mode;
            return { ok: true, mode: opts.mode, path: sessionBase };
          },
          adoptOrphanWorktree: <T extends { merged: boolean }>(
            _mid: string,
            _base: string,
            run: () => T,
          ): T => run(),
        }) as any,
      },
      {
        classification: "none",
        lock: null,
        pausedSession: null,
        state: null,
        recovery: null,
        recoveryPrompt: null,
        recoveryToolCallCount: 0,
        artifactSatisfied: false,
        hasResumableDiskState: false,
        isBootstrapCrash: false,
      },
    );

    assert.equal(ready, true);
    assert.deepEqual(adoptCalls, [{ milestoneId: "M001", mode: "branch" }]);
    assert.deepEqual(enterCalls, []);
    assert.equal(s.currentMilestoneId, "M001");
    assert.equal(s.strandedRecoveryIsolationMode, "branch");
    assert.match(
      notifications.map((entry) => entry.message).join("\n"),
      /Recovering stranded work for M001/,
    );
  } finally {
    try {
      closeDatabase();
    } catch {}
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});
