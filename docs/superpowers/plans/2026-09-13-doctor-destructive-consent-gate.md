# Doctor Destructive-Operation Consent Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `runGSDDoctor` from destroying git state (index mutations, branch deletions, worktree removals, `rm -rf`) unless the caller explicitly opted into `--fix`, and make the remaining destructive paths refuse to run when they would lose uncommitted work.

**Architecture:** `doctor.ts` already owns the single consent predicate — `shouldFix(code)` at [doctor.ts:220](../../../src/resources/extensions/gsd/doctor.ts#L220), which returns `false` unless `fix === true && dryRun === false`. Five destructive code paths bypass or under-check it. Each task closes one path, reusing predicates the codebase already has (`SLICE_BRANCH_RE`, `removeWorktree()`'s quarantine pipeline, `getSliceTasks`) rather than inventing new ones.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, `node --experimental-strip-types`.

**Spec:** [eagle27272/gsd-pi#11](https://github.com/eagle27272/gsd-pi/issues/11)

## Global Constraints

- **Test command (single file):**
  ```bash
  GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test <path/to/file.test.ts>
  ```
  One-time setup for that config (the developer's `~/.config/git/ignore` lists `.gsd`, which makes every fixture repo refuse to commit `.gsd/` files; CI has no such file):
  ```bash
  mkdir -p /tmp/gsd-test-git && printf '[core]\n\texcludesFile = /dev/null\n' > /tmp/gsd-test-git/config
  ```
- **Imports:** relative module specifiers inside `src/` end in `.js`; test files import source under test with `.ts` or `.js` matching the neighbouring test file's existing style.
- **Comments:** no comments restating what the code does. Comment only non-obvious *why*. Reference the issue as `(#11)` where a guard's motivation is not self-evident.
- **Issue codes:** every new `issues.push` must use a code already in `DoctorIssueCode` ([doctor-types.ts](../../../src/resources/extensions/gsd/doctor-types.ts)). No new codes are added by this plan.
- **No behaviour change under `--fix`** except where a guard explicitly refuses to destroy work; the doctor must still clean up what is genuinely safe to clean up.

---

### Task 1: Gate conflict auto-resolve on `shouldFix`

Issue §1. `checkGitHealth` runs `reconcileGitConflictsOnSignal` — which does `git checkout --theirs` + `git add`, and can run `abortAndReset` (`git merge --abort`, `git stash push`, `git reset --hard`) — whenever `!dryRun`. Both read-only callers ([headless.ts:471](../../../src/headless.ts#L471), labelled "Doctor: read-only health check", and [forensics.ts:420](../../../src/resources/extensions/gsd/forensics.ts#L420)) pass neither `fix` nor `dryRun`, so both mutate the index.

Gating on `shouldFix("unresolved_git_conflicts")` makes `dryRun` redundant — `shouldFix` already returns `false` when `dryRun` is true — so the parameter is removed.

**Files:**
- Modify: `src/resources/extensions/gsd/doctor-git-checks.ts:150-196`
- Modify: `src/resources/extensions/gsd/doctor.ts:258`
- Test: `src/resources/extensions/gsd/tests/doctor-git-checks-autoresolve.test.ts`

**Interfaces:**
- Consumes: `shouldFix: (code: DoctorIssueCode) => boolean` (already the 4th parameter of `checkGitHealth`).
- Produces: `checkGitHealth(basePath, issues, fixesApplied, shouldFix, isolationMode?)` — the trailing `dryRun` parameter is gone. Tasks 2–4 edit the same function and must use this signature.

- [ ] **Step 1: Write the failing test**

Append to `src/resources/extensions/gsd/tests/doctor-git-checks-autoresolve.test.ts`:

```ts
test("doctor without --fix does not touch the index when safe conflicts are present", async (t) => {
  const base = makeRepoWithConflict();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const report = await runGSDDoctor(base, { isolationMode: "none" });

  assert.ok(
    existsSync(join(base, ".git", "MERGE_HEAD")),
    "a non-fix run must leave merge state intact",
  );
  const conflictIssue = report.issues.find((issue) => issue.code === "unresolved_git_conflicts");
  assert.ok(conflictIssue, "the conflict should still be reported");
  assert.match(
    conflictIssue!.message,
    /\.gsd\/STATE\.md/,
    "the safe path must still be listed — a non-fix run must not have staged it",
  );
  assert.deepEqual(
    report.fixesApplied.filter((f) => f.includes("auto-resolved")),
    [],
    "a non-fix run must not report auto-resolve fixes",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/doctor-git-checks-autoresolve.test.ts
```

Expected: FAIL — `a non-fix run must leave merge state intact` (the reconcile clears `MERGE_HEAD`).

- [ ] **Step 3: Gate the reconcile and drop the `dryRun` parameter**

In `src/resources/extensions/gsd/doctor-git-checks.ts`, change the signature (drop the last parameter):

```ts
export async function checkGitHealth(
  basePath: string,
  issues: DoctorIssue[],
  fixesApplied: string[],
  shouldFix: (code: DoctorIssueCode) => boolean,
  isolationMode: "none" | "worktree" | "branch" = "none",
): Promise<void> {
```

Replace the comment block and guard at lines 177–196 with:

```ts
  // ── Auto-resolve safe conflicts before reporting ──────────────────────
  // A failed worktree merge (e.g. during complete-slice) can leave conflict
  // markers for paths that are always safe to accept from the milestone side
  // (.gsd/ state and build artifacts). Run the same reconciliation the
  // preflight/auto-worktree paths use before the doctor hard-blocks auto-mode,
  // so only genuinely-manual conflicts remain. This also clears stale
  // merge-state markers (e.g. MERGE_HEAD) in the same pass when auto-resolve
  // empties the unmerged set (#849).
  //
  // Reconciliation stages files and can hard-reset, so it needs the same
  // consent gate as every other fix — read-only doctor callers must not
  // mutate the index (#11).
  if (unmergedPaths.length > 0 && shouldFix("unresolved_git_conflicts")) {
    try {
      const reconcileFixes = reconcileGitConflictsOnSignal(basePath, probeGitConflictState(basePath));
      if (reconcileFixes.length > 0) {
        fixesApplied.push(...reconcileFixes);
        const refreshed = listUnmergedGitPaths(basePath);
        if (refreshed !== null) unmergedPaths = refreshed;
      }
    } catch {
      // Non-fatal — fall through to report the unmerged paths as-is
    }
  }
```

In `src/resources/extensions/gsd/doctor.ts:258`, drop the argument:

```ts
  await checkGitHealth(basePath, issues, fixesApplied, shouldFix, isolationMode);
```

- [ ] **Step 4: Update the two existing tests that assert fix behaviour**

Both tests exercise the auto-resolve, so they must opt in. In `doctor-git-checks-autoresolve.test.ts` change line 64:

```ts
  const report = await runGSDDoctor(base, { fix: true, isolationMode: "none" });
```

and line 100:

```ts
  const report = await runGSDDoctor(base, { fix: true, isolationMode: "none" });
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/doctor-git-checks-autoresolve.test.ts src/resources/extensions/gsd/tests/unborn-branch.test.ts
```

Expected: PASS, 4 tests in the autoresolve file. `unborn-branch.test.ts` already calls `checkGitHealth` with 5 arguments, so the signature change is source-compatible.

- [ ] **Step 6: Typecheck**

```bash
pnpm exec tsc --noEmit -p tsconfig.json
```

Expected: no errors mentioning `checkGitHealth` or `dryRun`.

- [ ] **Step 7: Commit**

```bash
git add src/resources/extensions/gsd/doctor-git-checks.ts src/resources/extensions/gsd/doctor.ts src/resources/extensions/gsd/tests/doctor-git-checks-autoresolve.test.ts
git commit -m "fix(doctor): gate conflict auto-resolve behind the shouldFix consent gate"
```

---

### Task 2: Narrow `legacy_slice_branches` to actual legacy slice branches

Issue §2. The glob `gsd/*/*` minus `gsd/quick/` force-deletes (`git branch -D`) two families of *live* branches:
- `gsd/submodule-rescue/<name>-<ts>`, created by [worktree-manager.ts:941](../../../src/resources/extensions/gsd/worktree-manager.ts#L941) *specifically to rescue uncommitted submodule work*.
- `gsd/${templateId}/${slug}`, created by [commands-workflow-templates.ts:457](../../../src/resources/extensions/gsd/commands-workflow-templates.ts#L457) and `:631` for current template runs.

The real legacy shape is `gsd/M001/S01`, documented in [PRD-branchless-worktree-architecture.md:36](../../../docs/dev/PRD-branchless-worktree-architecture.md#L36) and already encoded as `SLICE_BRANCH_RE` in [branch-patterns.ts:10](../../../src/resources/extensions/gsd/branch-patterns.ts#L10). Filtering through that single source of truth excludes all three non-legacy families at once.

Additionally, only delete branches already merged into the main branch. An unmerged legacy slice branch holds the only reference to its commits once the worktree is gone; the PRD calls these branches preserved read-only context.

**Files:**
- Modify: `src/resources/extensions/gsd/doctor-git-checks.ts:430-459`
- Test: `src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts` (create)

**Interfaces:**
- Consumes: `SLICE_BRANCH_RE` from `./branch-patterns.js`; `nativeBranchListMerged(basePath, target, pattern?): string[]` and `nativeDetectMainBranch(basePath): string` from `./native-git-bridge.js`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts`:

```ts
// Project/App: gsd-pi
// File Purpose: Doctor destructive git paths honour the shouldFix consent gate and refuse to destroy live work (#11).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGSDDoctor } from "../doctor.ts";
import { closeDatabase } from "../gsd-db.js";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function makeRepo(prefix: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  runGit(["init", "-b", "main"], base);
  runGit(["config", "user.name", "Test User"], base);
  runGit(["config", "user.email", "test@example.com"], base);
  writeFileSync(join(base, "README.md"), "base\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "chore: init"], base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function branchExists(base: string, branch: string): boolean {
  try {
    runGit(["rev-parse", "--verify", `refs/heads/${branch}`], base);
    return true;
  } catch {
    return false;
  }
}

test.after(() => {
  closeDatabase();
});

test("doctor --fix deletes legacy slice branches but spares template and rescue branches", async (t) => {
  const base = makeRepo("gsd-doctor-legacy-branches-");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  runGit(["branch", "gsd/M001/S01"], base);
  runGit(["branch", "gsd/hotfix/login-timeout"], base);
  runGit(["branch", "gsd/submodule-rescue/M001-1757000000000"], base);
  runGit(["branch", "gsd/quick/T01-tidy"], base);

  await runGSDDoctor(base, { fix: true, isolationMode: "none" });

  assert.equal(branchExists(base, "gsd/M001/S01"), false, "merged legacy slice branch should be deleted");
  assert.equal(branchExists(base, "gsd/hotfix/login-timeout"), true, "live template branch must survive");
  assert.equal(
    branchExists(base, "gsd/submodule-rescue/M001-1757000000000"),
    true,
    "submodule rescue branch must survive — it is the only copy of rescued work",
  );
  assert.equal(branchExists(base, "gsd/quick/T01-tidy"), true, "quick branch must survive");
});

test("doctor --fix keeps an unmerged legacy slice branch", async (t) => {
  const base = makeRepo("gsd-doctor-unmerged-legacy-");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  runGit(["checkout", "-b", "gsd/M001/S01"], base);
  writeFileSync(join(base, "work.txt"), "unmerged work\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "feat: unmerged slice work"], base);
  runGit(["checkout", "main"], base);

  await runGSDDoctor(base, { fix: true, isolationMode: "none" });

  assert.equal(
    branchExists(base, "gsd/M001/S01"),
    true,
    "an unmerged legacy slice branch holds the only reference to its commits",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts
```

Expected: FAIL — `live template branch must survive` and `an unmerged legacy slice branch holds the only reference to its commits`.

- [ ] **Step 3: Narrow the glob and require merged**

In `src/resources/extensions/gsd/doctor-git-checks.ts`, add to the import block:

```ts
import { SLICE_BRANCH_RE } from "./branch-patterns.js";
```

and add `nativeBranchListMerged` and `nativeDetectMainBranch` to the existing `./native-git-bridge.js` import list.

Replace the whole `── Legacy slice branches ──` block (lines 430–459) with:

```ts
  // ── Legacy slice branches ──────────────────────────────────────────────
  // Only `gsd/[worktree/]M001/S01` is a legacy slice branch. The `gsd/*/*`
  // glob also matches live branches this check must never delete:
  // `gsd/quick/*` task branches, `gsd/<template>/<slug>` workflow-template
  // branches, and `gsd/submodule-rescue/*` — the sole copy of rescued
  // uncommitted submodule work (#11).
  try {
    const branchList = nativeBranchList(basePath, "gsd/*/*")
      .filter((branch) => SLICE_BRANCH_RE.test(branch));
    if (branchList.length > 0) {
      // An unmerged legacy branch is the only reference to its commits, so it
      // is reported but never deleted (#11).
      const mergedBranches = new Set(
        nativeBranchListMerged(basePath, nativeDetectMainBranch(basePath)),
      );
      const deletable = branchList.filter((branch) => mergedBranches.has(branch));

      issues.push({
        severity: "info",
        code: "legacy_slice_branches",
        scope: "project",
        unitId: "project",
        message: `${branchList.length} legacy slice branch(es) found: ${branchList.slice(0, 3).join(", ")}${branchList.length > 3 ? "..." : ""}. These are no longer used (branchless architecture).${deletable.length < branchList.length ? ` ${branchList.length - deletable.length} are unmerged and will be kept.` : ""}`,
        fixable: deletable.length > 0,
      });

      if (shouldFix("legacy_slice_branches")) {
        let deleted = 0;
        for (const branch of deletable) {
          try {
            nativeBranchDelete(basePath, branch, true);
            deleted++;
          } catch { /* skip branches that can't be deleted */ }
        }
        if (deleted > 0) {
          fixesApplied.push(`deleted ${deleted} legacy slice branch(es)`);
        }
      }
    }
  } catch {
    // git branch list failed — skip
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/gsd/doctor-git-checks.ts src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts
git commit -m "fix(doctor): stop legacy_slice_branches force-deleting live gsd/ branches"
```

---

### Task 3: Route `orphaned_auto_worktree` through the safe removal path and restore cwd

Issue §3. The fix calls `nativeWorktreeRemove(basePath, wt.path, true)` — a raw `git worktree remove --force` — purely because the roadmap says the milestone is closed. `isClosedStatus` includes `cancelled` and `skipped`, so a cancelled milestone's worktree is force-deleted with its uncommitted work.

[removeWorktree()](../../../src/resources/extensions/gsd/worktree-manager.ts#L849) already implements every safety the sibling `worktree_branch_merged` check relies on: containment checks against `.gsd/worktrees/`, submodule rescue, nested-`.git` rescue, and **dirty-worktree quarantine** (moves the tree to `.gsd/quarantine/worktrees/<name>-<ts>/` instead of deleting it, and preserves the branch). Routing through it with `deleteBranch: false` fixes the data-loss half.

Separately, `process.chdir(basePath)` at `:283` is never undone, so everything downstream — including `process.cwd()` at `:635` — silently runs from a different directory.

**Files:**
- Modify: `src/resources/extensions/gsd/doctor-git-checks.ts:260-296`
- Test: `src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts` (append)

**Interfaces:**
- Consumes: `removeWorktree(basePath, name, opts: { deleteBranch?: boolean; force?: boolean; branch?: string }): boolean` from `./worktree-manager.js`; `WorktreeInfo.name` from `listWorktrees`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts`. Add these imports at the top of the file:

```ts
import { readdirSync } from "node:fs";
import { openDatabase, insertMilestone, insertSlice } from "../gsd-db.js";
import { createWorktree, worktreePath } from "../worktree-manager.ts";
```

and the test:

```ts
test("doctor --fix quarantines rather than deletes a dirty worktree for a cancelled milestone", async (t) => {
  const base = makeRepo("gsd-doctor-orphan-dirty-");
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Cancelled", status: "cancelled" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "in_progress" });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\ngit:\n  isolation: worktree\n---\n");

  createWorktree(base, "M001", { branch: "milestone/M001" });
  const wtPath = worktreePath(base, "M001");
  writeFileSync(join(wtPath, "unsaved.txt"), "work in progress\n", "utf-8");

  const cwdBefore = process.cwd();
  await runGSDDoctor(base, { fix: true, isolationMode: "worktree" });

  assert.equal(process.cwd(), cwdBefore, "doctor must not relocate the process");

  const quarantineRoot = join(base, ".gsd", "quarantine", "worktrees");
  assert.ok(existsSync(quarantineRoot), "dirty worktree should have been quarantined, not deleted");
  const preserved = readdirSync(quarantineRoot)
    .some((entry) => existsSync(join(quarantineRoot, entry, "unsaved.txt")));
  assert.ok(preserved, "uncommitted work must survive in the quarantine snapshot");
  assert.ok(branchExists(base, "milestone/M001"), "the branch must be preserved");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts
```

Expected: FAIL — `dirty worktree should have been quarantined, not deleted` (the raw force-remove deletes it outright).

- [ ] **Step 3: Use `removeWorktree` and restore the cwd**

In `src/resources/extensions/gsd/doctor-git-checks.ts`, replace the `if (shouldFix("orphaned_auto_worktree")) { ... }` body (lines 270–295) with:

```ts
        if (shouldFix("orphaned_auto_worktree")) {
          // If cwd is inside the worktree, chdir out first — matching the
          // pattern in removeWorktree() (#1946). Without this, git cannot
          // remove the worktree and the doctor enters a deadlock where it
          // detects the orphan every run but never cleans it up.
          let cwd = basePath;
          try {
            cwd = process.cwd();
          } catch {
            cwd = basePath;
          }
          const relocated = isSameOrNestedPath(cwd, wt.path);
          if (relocated) {
            try {
              process.chdir(basePath);
            } catch {
              fixesApplied.push(`skipped removing worktree at ${wt.path} (cannot chdir to basePath)`);
              continue;
            }
          }
          try {
            // removeWorktree() quarantines uncommitted work, rescues submodule
            // and nested-.git state, and refuses paths outside the worktrees
            // dir. A closed roadmap status alone is not evidence the tree is
            // safe to force-delete — `cancelled` and `skipped` count as closed
            // (#11). deleteBranch stays false: the branch is the recovery
            // handle for anything the worktree held.
            const removed = removeWorktree(basePath, wt.name, {
              deleteBranch: false,
              branch: wt.branch,
            });
            fixesApplied.push(
              removed
                ? `removed orphaned worktree ${wt.path}`
                : `preserved orphaned worktree ${wt.path} (uncommitted work could not be quarantined)`,
            );
          } catch {
            fixesApplied.push(`failed to remove worktree ${wt.path}`);
          } finally {
            // Leaving the process relocated silently changes process.cwd() for
            // every later check. Only restore when the original directory
            // survived the removal (#11).
            if (relocated && existsSync(cwd)) {
              try {
                process.chdir(cwd);
              } catch { /* original cwd is gone — stay at basePath */ }
            }
          }
        }
```

Add `removeWorktree` to the existing `./worktree-manager.js` import at line 12:

```ts
import { allWorktreesDirs, createWorktree, listWorktrees, removeWorktree, resolveGitDir } from "./worktree-manager.js";
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts src/resources/extensions/gsd/tests/doctor-git-checks-terminal.test.ts
```

Expected: PASS. `doctor-git-checks-terminal.test.ts` only asserts the issue is *reported* (it does not pass `fix`), so it is unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/gsd/doctor-git-checks.ts src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts
git commit -m "fix(doctor): quarantine dirty orphaned worktrees and restore cwd after removal"
```

---

### Task 4: Guard the mass `rmSync` loop and the empty-worktree recreate

Issue §4, two sites.

**4a — `worktree_directory_orphaned` (`rmSync` at `:548`).** `registeredPaths` comes only from `nativeWorktreeList(basePath)`, whose CLI fallback is `gitExec(..., allowFailure=true)` → `""` → `[]` on any non-zero exit ([native-git-bridge.ts:604-632](../../../src/resources/extensions/gsd/native-git-bridge.ts#L604)). One transient git failure makes every directory under `allWorktreesDirs` look unregistered and `rmSync(fullPath, {recursive: true, force: true})` runs on all of them. A successful `git worktree list` always contains at least the main worktree, so an empty set means the query failed — never that nothing is registered.

**4b — `worktree_empty_with_project_content` (remove + recreate + `git reset --hard` at `:231-242`).** `hasProjectContentOnDisk` excludes any `.gsd` path segment (`isProjectContentPath`, `:70`), and `.gsd/` is gitignored so `git status` does not see it either. A worktree whose only content is uncommitted `.gsd/` planning work therefore looks empty and is destroyed. Skip the fix when the worktree carries `.gsd/` state beyond the doctor's own history file.

**Files:**
- Modify: `src/resources/extensions/gsd/doctor-git-checks.ts:219-258` and `:510-559`
- Test: `src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts` (append)

**Interfaces:**
- Consumes: `isDoctorArtifactOnly(dirPath: string): boolean` (already private in this file).
- Produces: new private helper in `doctor-git-checks.ts`:
  ```ts
  function hasWorktreeGsdState(dirPath: string): boolean
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts`:

```ts
test("doctor --fix does not delete worktree directories when git worktree list comes back empty", async (t) => {
  const base = makeRepo("gsd-doctor-worktree-dirs-");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const { checkGitHealth } = await import("../doctor-git-checks.ts");
  const bridge = await import("../native-git-bridge.ts");
  const original = bridge.nativeWorktreeList;
  // Simulate the CLI fallback's failure mode: a non-zero git exit yields [].
  (bridge as { nativeWorktreeList: typeof original }).nativeWorktreeList = () => [];
  t.after(() => {
    (bridge as { nativeWorktreeList: typeof original }).nativeWorktreeList = original;
  });

  const strayDir = join(base, ".gsd-worktrees", "M001");
  mkdirSync(strayDir, { recursive: true });
  writeFileSync(join(strayDir, "keep.txt"), "real work\n", "utf-8");

  const issues: Parameters<typeof checkGitHealth>[1] = [];
  const fixesApplied: string[] = [];
  await checkGitHealth(base, issues, fixesApplied, () => true, "worktree");

  assert.ok(
    existsSync(join(strayDir, "keep.txt")),
    "an empty worktree list means the git query failed, not that every dir is orphaned",
  );
  assert.ok(
    !issues.some((issue) => issue.code === "worktree_directory_orphaned"),
    "no orphan should be reported when the registered-worktree query yields nothing",
  );
});

test("doctor --fix does not destroy a worktree whose only content is uncommitted .gsd state", async (t) => {
  const base = makeRepo("gsd-doctor-empty-worktree-");
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Active", status: "active" });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\ngit:\n  isolation: worktree\n---\n");

  createWorktree(base, "M001", { branch: "milestone/M001" });
  const wtPath = worktreePath(base, "M001");
  for (const entry of readdirSync(wtPath)) {
    if (entry !== ".git") rmSync(join(wtPath, entry), { recursive: true, force: true });
  }
  mkdirSync(join(wtPath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(
    join(wtPath, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# M001 Roadmap\n\nUnsaved planning work.\n",
    "utf-8",
  );

  await runGSDDoctor(base, { fix: true, isolationMode: "worktree" });

  assert.ok(
    existsSync(join(wtPath, ".gsd", "milestones", "M001", "M001-ROADMAP.md")),
    "uncommitted .gsd planning state must not be destroyed by the empty-worktree recreate",
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts
```

Expected: FAIL on both new tests — the stray dir is deleted, and the `.gsd`-only worktree is removed and recreated.

Note: if module-namespace reassignment is rejected at runtime (ESM namespace objects are frozen), replace the stub with a temporary rename of the `git` binary resolution — simplest alternative is to point `PATH` at a directory containing a `git` shim that exits 1 for `worktree list`. Pick whichever the runtime allows; the assertion stays identical.

- [ ] **Step 3: Add the guards**

In `src/resources/extensions/gsd/doctor-git-checks.ts`, add this helper next to `isDoctorArtifactOnly`:

```ts
/**
 * True when the worktree holds `.gsd/` state a remove-and-recreate would
 * destroy. `hasProjectContentOnDisk` deliberately ignores `.gsd` segments and
 * `.gsd/` is gitignored, so neither it nor `git status` can see uncommitted
 * planning work — this is a direct disk read (#11).
 */
function hasWorktreeGsdState(dirPath: string): boolean {
  const gsdDir = join(dirPath, ".gsd");
  if (!existsSync(gsdDir)) return false;
  try {
    return readdirSync(gsdDir).some(entry => entry !== "doctor-history.jsonl");
  } catch {
    return true;
  }
}
```

Change the `worktree_empty_with_project_content` fix guard at line 229 from:

```ts
        if (shouldFix("worktree_empty_with_project_content")) {
```

to:

```ts
        if (shouldFix("worktree_empty_with_project_content") && !hasWorktreeGsdState(wt.path)) {
```

and immediately after that `if` block (still inside the `if (!isComplete && ...)` body), add:

```ts
        if (shouldFix("worktree_empty_with_project_content") && hasWorktreeGsdState(wt.path)) {
          fixesApplied.push(
            `skipped recreating empty worktree ${wt.path} — it holds uncommitted .gsd/ state`,
          );
        }
```

Replace the orphaned-worktree-directory block (lines 514–559) with a version that computes `registeredPaths` once and refuses to act on an empty set:

```ts
  try {
    const normalizePath = (p: string): string => {
      try { p = realpathSync(p); } catch { /* path may not exist */ }
      return p.replaceAll("\\", "/");
    };
    // Resolve symlinks and normalize separators so that symlinked .gsd
    // paths (e.g. ~/.gsd/projects/<hash>/worktrees/…) match the paths
    // returned by `git worktree list`.
    const registeredPaths = new Set(
      nativeWorktreeList(basePath).map(entry => normalizePath(entry.path)),
    );
    // A successful listing always contains the main worktree. An empty set
    // means the query failed — the CLI fallback returns [] on any non-zero
    // exit — and treating that as "nothing is registered" would rm -rf every
    // worktree directory, dirty ones included (#11).
    if (registeredPaths.size > 0) {
      for (const wtDir of allWorktreesDirs(basePath)) {
        if (!existsSync(wtDir)) continue;
        for (const entry of readdirSync(wtDir)) {
          const fullPath = join(wtDir, entry);
          try {
            if (!statSync(fullPath).isDirectory()) continue;
          } catch { continue; }
          if (registeredPaths.has(normalizePath(fullPath))) continue;
          // Skip directories that only contain doctor artifacts (.gsd/doctor-history.jsonl).
          // appendDoctorHistory() can recreate these dirs during the audit itself,
          // causing a circular false positive (#3105 Bug 1).
          if (isDoctorArtifactOnly(fullPath)) continue;
          issues.push({
            severity: "warning",
            code: "worktree_directory_orphaned",
            scope: "project",
            unitId: entry,
            message: `Worktree directory ${fullPath} exists on disk but is not registered with git. Run "git worktree prune" or doctor --fix to remove it.`,
            fixable: true,
          });
          if (shouldFix("worktree_directory_orphaned")) {
            try {
              rmSync(fullPath, { recursive: true, force: true });
              fixesApplied.push(`removed orphaned worktree directory ${fullPath}`);
            } catch {
              fixesApplied.push(`failed to remove orphaned worktree directory ${fullPath}`);
            }
          }
        }
      }
    }
  } catch {
    // Non-fatal — orphaned worktree directory check failed
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/gsd/doctor-git-checks.ts src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts
git commit -m "fix(doctor): guard worktree directory removal against empty git listings and .gsd state"
```

---

### Task 5: Make `isCompletedMilestoneTerminal` inspect slices and tasks on every path

Issue §5. Two early `return true` paths — `:70` (`lifecycleStatus === "completed" || "cancelled"`) and `:81` (`isClosedStatus(milestone.status)`) — return before `getMilestoneSlices` is called. The fallback at `:86-88` reads only `slice.status`; `getSliceTasks` is never called in the file. Because `isClosedStatus` includes `cancelled` and `skipped`, a cancelled milestone with open slices and open tasks satisfies the predicate, and it gates `nativeBranchDelete(basePath, branch, true)` at [doctor-git-checks.ts:329](../../../src/resources/extensions/gsd/doctor-git-checks.ts#L329).

The two early-return paths carry explicit closeout evidence, so zero slices is fine there; the fallback path uses slice closure *as* its evidence, so it must keep requiring at least one slice. Both must refuse when open work exists.

**Files:**
- Modify: `src/resources/extensions/gsd/milestone-closeout.ts:59-89`
- Test: `src/resources/extensions/gsd/tests/milestone-closeout.test.ts` (append)

**Interfaces:**
- Consumes: `getSliceTasks(milestoneId: string, sliceId: string): TaskRow[]` — re-exported from `./gsd-db.js` via `export * from "./db/queries.js"`.
- Produces: new private helper in `milestone-closeout.ts`:
  ```ts
  function hasOpenMilestoneWork(milestoneId: string): boolean
  ```
  `isCompletedMilestoneTerminal`'s exported signature is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `src/resources/extensions/gsd/tests/milestone-closeout.test.ts`, and add `insertTask` to the existing `../gsd-db.js` import list:

```ts
test("isCompletedMilestoneTerminal rejects a cancelled milestone with open slices", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-terminal-cancelled-open-slice-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M009", title: "Cancelled", status: "cancelled" });
  insertSlice({ id: "S01", milestoneId: "M009", title: "Open slice", status: "in_progress" });

  assert.equal(await isCompletedMilestoneTerminal(base, "M009"), false);
});

test("isCompletedMilestoneTerminal rejects a closed milestone whose slices hide open tasks", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-terminal-open-task-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M010", title: "Done", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M010", title: "Slice", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M010", title: "Open task", status: "in_progress" });

  assert.equal(await isCompletedMilestoneTerminal(base, "M010"), false);
});

test("isCompletedMilestoneTerminal accepts a closed milestone with all slices and tasks closed", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-terminal-all-closed-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M011", title: "Done", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M011", title: "Slice", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M011", title: "Task", status: "complete" });

  assert.equal(await isCompletedMilestoneTerminal(base, "M011"), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-closeout.test.ts
```

Expected: the first two new tests FAIL (`expected false, got true`); the third PASSES.

- [ ] **Step 3: Rewrite the predicate**

In `src/resources/extensions/gsd/milestone-closeout.ts`, add `getSliceTasks` to the existing `./gsd-db.js` import list, and replace lines 52–89 with:

```ts
/**
 * True when any slice or task under the milestone is still open.
 *
 * `isClosedStatus` treats `cancelled` and `skipped` as closed, so a milestone
 * row can read terminal while its slices and tasks are mid-flight. Git cleanup
 * force-deletes branches, so it must see the whole tree, not just the
 * milestone row (#11).
 */
function hasOpenMilestoneWork(milestoneId: string): boolean {
  return getMilestoneSlices(milestoneId).some((slice) =>
    !isClosedStatus(slice.status) ||
    getSliceTasks(milestoneId, slice.id).some((task) => !isClosedStatus(task.status)),
  );
}

/**
 * True when a milestone is terminal for git cleanup (orphaned worktrees, stale branches).
 * DB-authoritative (ADR-017): closed status, or validation-pass with all slices closed.
 * When the DB is unavailable we cannot make this decision and conservatively
 * return false so callers leave the worktree/branch alone instead of cleaning
 * up based on parsed projections.
 */
export async function isCompletedMilestoneTerminal(
  basePath: string,
  milestoneId: string,
): Promise<boolean> {
  if (!isDbAvailable()) return false;

  const milestone = getMilestone(milestoneId);
  if (!milestone) return false;

  const lifecycleStatus = readMilestoneLifecycleStatus(milestoneId);
  if (lifecycleStatus) {
    if (lifecycleStatus === "completed" || lifecycleStatus === "cancelled") {
      return !hasOpenMilestoneWork(milestoneId);
    }
    const artifactBasePath = resolveCanonicalMilestoneRoot(basePath, milestoneId);
    const source = captureMilestoneVerificationSourceRevision(
      artifactBasePath,
      loadEffectiveGSDPreferences(artifactBasePath)?.preferences,
    );
    if (!source.ok || !readMilestoneCloseoutAuthorization({
      milestoneId,
      sourceRevision: source.sourceRevision,
    }).authorized) return false;
  } else {
    if (isClosedStatus(milestone.status)) {
      return !hasOpenMilestoneWork(milestoneId);
    }
    const validation = getLatestAssessmentByScope(milestoneId, "milestone-validation");
    if (validation?.status !== "pass") return false;
  }

  // No explicit closeout record — slice and task closure is the only evidence,
  // so an empty slice set proves nothing.
  const slices = getMilestoneSlices(milestoneId);
  if (slices.length === 0) return false;
  return !hasOpenMilestoneWork(milestoneId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-closeout.test.ts src/resources/extensions/gsd/tests/doctor-git-checks-terminal.test.ts src/resources/extensions/gsd/tests/adopted-milestone-validation-waiver.test.ts src/resources/extensions/gsd/tests/guidance.test.ts
```

Expected: all PASS. The two pre-existing `isCompletedMilestoneTerminal` tests use closed slices with no tasks, so both still return true.

- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/gsd/milestone-closeout.ts src/resources/extensions/gsd/tests/milestone-closeout.test.ts
git commit -m "fix(doctor): require closed slices and tasks before treating a milestone as terminal"
```

---

### Task 6: Full-suite verification

**Files:**
- Modify: none (verification only)

**Interfaces:**
- Consumes: all five prior tasks.
- Produces: nothing.

- [ ] **Step 1: Typecheck**

```bash
pnpm exec tsc --noEmit -p tsconfig.json
```

Expected: no new errors.

- [ ] **Step 2: Lint the changed files**

```bash
pnpm exec eslint src/resources/extensions/gsd/doctor-git-checks.ts src/resources/extensions/gsd/doctor.ts src/resources/extensions/gsd/milestone-closeout.ts src/resources/extensions/gsd/tests/doctor-destructive-consent.test.ts
```

Expected: clean.

- [ ] **Step 3: Run the unit suite**

```bash
GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config pnpm run test:unit
```

Expected: same pass/fail set as `main`, plus the new tests passing. Record any pre-existing failure explicitly rather than attributing it to this change.

- [ ] **Step 4: Commit anything the suite forced**

```bash
git add -A
git commit -m "test(doctor): align suite with destructive-operation consent gates"
```

(Skip if the tree is clean.)

---

## Self-Review

**Spec coverage:**
- Issue §1 (conflict auto-resolve gated on `!dryRun`) → Task 1.
- Issue §2 (`gsd/*/*` glob force-deletes live branches) → Task 2.
- Issue §3 (`orphaned_auto_worktree` force-removes on status alone; cwd never restored) → Task 3.
- Issue §4 (transient git failure → mass worktree deletion; `.gsd`-only worktree destroyed) → Task 4.
- Issue §5 (`isCompletedMilestoneTerminal` early returns) → Task 5.

**Deliberate deviation from the issue's suggested fix:** the issue asks to "make `nativeWorktreeList` distinguish failure from empty." Task 4a instead guards at the call site. `nativeWorktreeList` has eight callers across four modules, all of which currently treat `[]` as "no worktrees"; changing its return type would force a null check into every one of them for a risk that only exists at the single `rmSync` site. The `registeredPaths.size > 0` guard is exact — a successful listing always includes the main worktree — and is confined to the destructive path.

The issue also asks for an "unpushed" check on `orphaned_auto_worktree`. Task 3 gates on uncommitted state only, because `git worktree remove` deletes the working directory but not the branch: committed-but-unpushed work survives in the shared object store, and `deleteBranch: false` keeps the ref. Requiring zero unpushed commits would block cleanup in every repo without a remote, where `nativeUnpushedCount` returns the full history.

**Type consistency:** `checkGitHealth`'s 5-parameter signature is introduced in Task 1 and used unchanged in Tasks 2–4. `hasWorktreeGsdState` (Task 4) and `hasOpenMilestoneWork` (Task 5) are private to their files. `removeWorktree`'s option names (`deleteBranch`, `branch`) match [worktree-manager.ts:849](../../../src/resources/extensions/gsd/worktree-manager.ts#L849).
