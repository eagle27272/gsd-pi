// gsd-pi — Issue #6: a failed worktree DB reconcile must never look like success.
//
// `reconcileWorktreeDb` used to return a zero-count `ReconcileResult` on three
// failure branches (unsafe path characters, main DB cannot be opened, any
// mid-merge exception). A zero result is indistinguishable from "the worktree
// had nothing to merge", so `teardownAutoWorktree` deleted the worktree — and
// with it the only copy of `.gsd/gsd.db`, which is gitignored.
//
// These tests pin the contract that replaced it:
//   - genuine no-ops (absent worktree DB, same physical file) still return zero
//   - every failure branch throws WorktreeReconciliationError
//   - teardown preserves the worktree when reconciliation throws
//   - worktree-wins conflicts are surfaced, not discarded

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  closeDatabase,
  openDatabase,
  insertDecision,
  getActiveDecisions,
  reconcileWorktreeDb,
} from "../gsd-db.ts";
import {
  WorktreeReconciliationError,
  _setMainDbOpenerFnForTests,
} from "../db/writers/reconcile.ts";
import { createAutoWorktree } from "../auto-worktree-creation.ts";
import { teardownAutoWorktree } from "../auto-worktree-teardown.ts";
import { _resetAutoWorktreeOriginalBaseForTests } from "../auto-worktree-session-registry.ts";
import { resolveGsdPathContract } from "../paths.ts";
import { worktreePath } from "../worktree-manager.ts";
import { reconcileWorktreeDbBeforeManualMerge } from "../worktree-command.ts";
import {
  drainLogs,
  setStderrLoggingEnabled,
  _resetLogs,
  type LogEntry,
} from "../workflow-logger.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tempDir(prefix = "gsd-reconcile-fatal-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function seedDb(dbPath: string, id = "D001"): void {
  openDatabase(dbPath);
  insertDecision({
    id,
    when_context: "2026-01-01",
    scope: "M001/S01",
    decision: "x",
    choice: "x",
    rationale: "x",
    revisable: "yes",
    made_by: "agent",
    superseded_by: null,
  });
  closeDatabase();
}

function captureLogs<T>(fn: () => T): { result: T; logs: LogEntry[] } {
  const previous = setStderrLoggingEnabled(false);
  _resetLogs();
  try {
    const result = fn();
    return { result, logs: drainLogs() };
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previous);
  }
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function createTempRepo(): string {
  const dir = tempDir("gsd-reconcile-fatal-repo-");
  git(["init"], dir);
  git(["config", "user.email", "test@gsd.test"], dir);
  git(["config", "user.name", "Test"], dir);
  // A developer's global ignore file may list `.gsd`, which would silently
  // drop the seeded milestone from the fixture commit.
  git(["config", "core.excludesFile", "/dev/null"], dir);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# test\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  git(["branch", "-M", "main"], dir);
  return dir;
}

function seedMilestone(repoDir: string, milestoneId: string): void {
  const msDir = join(repoDir, ".gsd", "milestones", milestoneId);
  mkdirSync(msDir, { recursive: true });
  writeFileSync(join(msDir, "CONTEXT.md"), `# ${milestoneId} Context\n`);
  git(["add", "."], repoDir);
  git(["commit", "-m", `add ${milestoneId}`], repoDir);
}

// ─── reconcileWorktreeDb: failure branches throw ─────────────────────────────

describe("#6: reconcileWorktreeDb failure branches throw instead of returning zero", () => {
  let dirs: string[] = [];

  beforeEach(() => { dirs = []; });
  afterEach(() => {
    closeDatabase();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function track(dir: string): string { dirs.push(dir); return dir; }

  test("throws when the worktree DB path contains ATTACH-unsafe characters", () => {
    // A project path like /Users/O'Brien/proj trips the sanitizer. Before the
    // fix this returned zero counts and every worktree-local row was dropped.
    const mainDir = track(tempDir());
    const wtDir = track(tempDir("gsd-reconcile-fatal-unsafe-'"));
    const mainDb = join(mainDir, "gsd.db");
    seedDb(mainDb);
    const wtDb = join(wtDir, "gsd.db");
    copyFileSync(mainDb, wtDb);

    openDatabase(mainDb);
    const previous = setStderrLoggingEnabled(false);
    try {
      assert.throws(
        () => reconcileWorktreeDb(mainDb, wtDb),
        (err: unknown) => {
          assert.ok(
            err instanceof WorktreeReconciliationError,
            `expected WorktreeReconciliationError, got ${String(err)}`,
          );
          assert.match(err.message, /unsafe characters/u);
          return true;
        },
      );
    } finally {
      setStderrLoggingEnabled(previous);
      closeDatabase();
    }
  });

  test("throws when the main DB cannot be opened", () => {
    const mainDir = track(tempDir());
    const wtDir = track(tempDir());
    const mainDb = join(mainDir, "gsd.db");
    seedDb(mainDb);
    const wtDb = join(wtDir, "gsd.db");
    copyFileSync(mainDb, wtDb);

    const restore = _setMainDbOpenerFnForTests(() => false);
    const previous = setStderrLoggingEnabled(false);
    try {
      assert.throws(
        () => reconcileWorktreeDb(mainDb, wtDb),
        (err: unknown) => {
          assert.ok(err instanceof WorktreeReconciliationError);
          assert.match(err.message, /cannot open main DB/u);
          return true;
        },
      );
    } finally {
      setStderrLoggingEnabled(previous);
      restore();
      closeDatabase();
    }
  });

  test("throws when the merge itself fails (corrupt worktree DB)", () => {
    const mainDir = track(tempDir());
    const wtDir = track(tempDir());
    const mainDb = join(mainDir, "gsd.db");
    seedDb(mainDb);
    const wtDb = join(wtDir, "gsd.db");
    writeFileSync(wtDb, "this is not a sqlite database", "utf-8");

    openDatabase(mainDb);
    const previous = setStderrLoggingEnabled(false);
    try {
      assert.throws(
        () => reconcileWorktreeDb(mainDb, wtDb),
        (err: unknown) => {
          assert.ok(err instanceof WorktreeReconciliationError);
          assert.ok(err.cause, "the underlying ATTACH/merge error is preserved as cause");
          return true;
        },
      );
    } finally {
      setStderrLoggingEnabled(previous);
      closeDatabase();
    }
  });

  test("still returns a zero result when the worktree DB does not exist", () => {
    const mainDir = track(tempDir());
    const mainDb = join(mainDir, "gsd.db");
    seedDb(mainDb);

    openDatabase(mainDb);
    try {
      const result = reconcileWorktreeDb(mainDb, join(mainDir, "absent", "gsd.db"));
      assert.equal(result.decisions, 0);
      assert.equal(result.conflicts.length, 0);
    } finally {
      closeDatabase();
    }
  });

  test("still returns a zero result when both paths are the same file", () => {
    const mainDir = track(tempDir());
    const mainDb = join(mainDir, "gsd.db");
    seedDb(mainDb);

    openDatabase(mainDb);
    try {
      const result = reconcileWorktreeDb(mainDb, mainDb);
      assert.equal(result.decisions, 0);
      assert.equal(result.conflicts.length, 0);
    } finally {
      closeDatabase();
    }
  });
});

// ─── teardownAutoWorktree: gated on reconcile success ────────────────────────

describe("#6: teardownAutoWorktree preserves the worktree when reconcile fails", () => {
  const savedCwd = process.cwd();
  let repoDir = "";

  beforeEach(() => {
    _resetAutoWorktreeOriginalBaseForTests();
    process.chdir(savedCwd);
  });

  afterEach(() => {
    closeDatabase();
    _resetAutoWorktreeOriginalBaseForTests();
    process.chdir(savedCwd);
    if (repoDir && existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
    repoDir = "";
  });

  test("a corrupt worktree DB blocks worktree removal instead of deleting it", () => {
    repoDir = createTempRepo();
    seedMilestone(repoDir, "M001");
    createAutoWorktree(repoDir, "M001");

    const wtDir = worktreePath(repoDir, "M001");
    const contract = resolveGsdPathContract(process.cwd(), repoDir);
    const wtGsd = contract.worktreeGsd ?? join(process.cwd(), ".gsd");
    const wtDb = join(wtGsd, "gsd.db");
    const mainDb = contract.projectDb;

    assert.notEqual(
      realpathSync(wtGsd),
      realpathSync(contract.projectGsd),
      "the worktree must have its own .gsd for this scenario to be meaningful",
    );

    mkdirSync(wtGsd, { recursive: true });
    seedDb(mainDb);
    // Unreadable bytes force the ATTACH to fail — the exact shape that used to
    // return zero counts and let teardown delete the worktree.
    writeFileSync(wtDb, "this is not a sqlite database", "utf-8");

    const { logs } = captureLogs(() => teardownAutoWorktree(repoDir, "M001"));

    assert.ok(
      existsSync(wtDir),
      "worktree directory must survive a failed reconcile — its gsd.db is the only copy",
    );
    assert.ok(
      existsSync(wtDb),
      "the un-merged worktree DB must still be on disk for manual recovery",
    );
    const err = logs.find(
      (e) => e.severity === "error" && /reconciliation failed/u.test(e.message),
    );
    assert.ok(err, "the failure must be logged as an error");
  });

  test("a healthy worktree DB still tears down and surfaces conflicts", () => {
    repoDir = createTempRepo();
    seedMilestone(repoDir, "M002");
    createAutoWorktree(repoDir, "M002");

    const wtDir = worktreePath(repoDir, "M002");
    const contract = resolveGsdPathContract(process.cwd(), repoDir);
    const wtGsd = contract.worktreeGsd ?? join(process.cwd(), ".gsd");
    const wtDb = join(wtGsd, "gsd.db");
    const mainDb = contract.projectDb;

    mkdirSync(wtGsd, { recursive: true });
    seedDb(mainDb, "D-MAIN");
    seedDb(wtDb, "D-WT");
    closeDatabase();

    teardownAutoWorktree(repoDir, "M002");

    assert.ok(!existsSync(wtDir), "a successful reconcile still removes the worktree");

    openDatabase(mainDb);
    const ids = getActiveDecisions().map((d) => d.id);
    closeDatabase();
    assert.ok(
      ids.includes("D-WT"),
      `the worktree decision must be merged into the project DB before removal (got ${ids.join(", ")})`,
    );
  });
});

// ─── Manual /worktree merge surfaces the failure ─────────────────────────────

describe("#6: reconcileWorktreeDbBeforeManualMerge rethrows reconcile failures", () => {
  let dirs: string[] = [];

  beforeEach(() => { dirs = []; });
  afterEach(() => {
    closeDatabase();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("a corrupt worktree DB aborts the manual merge", async () => {
    const mainDir = tempDir(); dirs.push(mainDir);
    const wtDir = tempDir(); dirs.push(wtDir);
    const mainDb = join(mainDir, "gsd.db");
    seedDb(mainDb);
    const wtDb = join(wtDir, "gsd.db");
    writeFileSync(wtDb, "this is not a sqlite database", "utf-8");

    openDatabase(mainDb);
    const previous = setStderrLoggingEnabled(false);
    try {
      await assert.rejects(
        () => reconcileWorktreeDbBeforeManualMerge(mainDb, wtDb),
        (err: unknown) => {
          assert.ok(err instanceof WorktreeReconciliationError);
          return true;
        },
      );
    } finally {
      setStderrLoggingEnabled(previous);
      closeDatabase();
    }
  });
});
