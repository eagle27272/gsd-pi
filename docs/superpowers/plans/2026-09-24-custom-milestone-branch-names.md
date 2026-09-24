# Custom Milestone Branch Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** gsd asks the user what to call each milestone's working branch, suggests a name that follows the team convention, and uses that name everywhere it uses `milestone/<MID>` today.

**Architecture:** A leaf module, `milestone-branch-registry.ts`, stores one durable record per milestone at `.gsd/milestone-branches/<MID>.json` (project root) and owns every name lookup: build, detect, parse, list. A second module, `milestone-branch-choice.ts`, validates and records a name, asks for it in the TUI, and renders the discuss-prompt question. The discuss agent records the answer through a new workflow tool, `gsd_milestone_set_branch`. About 45 call sites move from `milestone/${id}` string handling to the registry.

**Tech Stack:** TypeScript, `node:test` with `--experimental-strip-types`, TypeBox for Pi tool schemas, Zod for MCP tool schemas, git via `native-git-bridge.ts`.

**Spec:** [docs/superpowers/specs/2026-09-24-custom-milestone-branch-names-design.md](../specs/2026-09-24-custom-milestone-branch-names-design.md)

## Global Constraints

- Record location, verbatim: `.gsd/milestone-branches/<MID>.json` under `gsdRoot(resolveWorktreeProjectRoot(basePath))`, content `{ "branch": "<name>" }`. Never use `gsdRoot(basePath)` directly: for a worktree path it returns the worktree's own `.gsd`.
- Default name, verbatim: `milestone/<MID>`. A milestone with no record uses it.
- Any branch under `milestone/` still counts as a milestone branch, as it does today. `milestoneIdForBranch` returns the text after `milestone/` for those branches.
- An unreadable record makes `autoWorktreeBranch` throw a `GSDError`. It never falls back to `milestone/<MID>`. Scans over all records (`milestoneIdForBranch`, `listMilestoneBranches`) skip an unreadable record with `logWarning`.
- A record means "someone asked". Accepting the default writes `milestone/<MID>` as a record.
- Records are removed only through `forgetMilestoneBranchIfDeleted`, only right after gsd deletes the branch, and only when the branch is really gone.
- Headless sessions (`ctx.hasUI === false`) record nothing.
- Preference key, verbatim: `git.milestone_branch_format` (free-text string).
- Tool name, verbatim: `gsd_milestone_set_branch`, parameters `{ milestoneId, branch }`, no aliases.
- Discuss question ID, verbatim: `milestone_branch_<ID>`. It must never contain `depth_verification`, because the write gate treats any question ID containing that text as the depth gate.
- Prompt variable, verbatim: `{{milestoneBranchQuestion}}`. It renders as an empty string when `git.isolation` is not `worktree` or `branch`.
- `tsconfig.options.json` sets `noUnusedLocals`. Remove every import a change leaves unused.
- When a task imports names from a module that the file already imports (usually `./milestone-branch-registry.js`, added by an earlier task), extend the existing import statement. Do not add a second import of the same module.
- Comments: no comments that restate what the code does, no comments narrating changes. Only a non-obvious *why*. Do not use tool terminology from superpowers.
- Commits: conventional style (`feat(gsd): …`, `test(gsd): …`). No Claude attribution and no `Co-Authored-By` line.

### Deliberate refinements of the spec

- `setMilestoneBranch` lives in `milestone-branch-choice.ts`, not in the registry. It needs `readIntegrationBranch` from `git-service.ts`, and `git-service.ts` imports the registry, so keeping it in the registry would create an import cycle.
- `ensureMilestoneBranchName` does not check isolation itself. Both callers already know the isolation mode and call it only when the mode is not `none`.
- The `autoWorktreeBranch` test override in `WorktreeLifecycleDeps` and `LoopDeps` keeps its one-argument shape `(milestoneId) => string`. Production wiring closes over the project root. This keeps about ten existing test doubles unchanged.
- Validation rejects three more inputs than the spec lists: names that start with `refs/`, names that start with `-`, and names that clash with an existing branch by case or by path prefix (`feat` next to `feat/x`). Git accepts the first two literally and fails on the third only at branch creation, in the middle of an auto-mode run.
- Branch deletion happens in seven places, not three. Task 7 covers all of them.
- `src/worktree-status-banner.ts` stays as it is. It matches worktrees by directory. The branch-name fallback matters only for odd Windows path forms, and importing the registry would pull `native-git-bridge` and `workflow-logger` into CLI startup.

### Running tests

A global gitignore that lists `.gsd` breaks git fixture repos locally. Create this file once:

```bash
mkdir -p /tmp/gsd-test-git && printf '[core]\n\texcludesFile = /dev/null\n' > /tmp/gsd-test-git/config
```

Run one test file directly from TypeScript, with no build:

```bash
GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/<file>.test.ts
```

Type-check after each task:

```bash
pnpm run typecheck:extensions
```

If the type check reports errors in files the task did not touch, the build output is stale. Run `pnpm run build:core` once, then run the type check again.

## Review Focus

1. A name that clashes with an existing branch by case (`Feat/X` next to `feat/x`) or by path (`feat` next to `feat/x`). Expected: rejected when the user types it, not a failure at milestone entry. Test: Task 2.
2. A name the user pastes with a `refs/heads/` prefix, a leading `-`, or surrounding spaces. Expected: the prefix and dash are rejected, the spaces are trimmed. Test: Task 2.
3. A call from inside a worktree. Expected: the worktree path and the project root read and write the same record. Test: Task 1.
4. A project upgraded while `milestone/M003` is in flight. Expected: resume records `milestone/M003` without a prompt and keeps working on it. Test: Task 4.
5. The user presses Esc or submits an empty answer. Expected: the default is recorded and nothing asks again on the next run. Test: Task 4.

---

## File Structure

Create:

- `src/resources/extensions/gsd/milestone-branch-registry.ts`: record storage and every name lookup. Leaf module.
- `src/resources/extensions/gsd/milestone-branch-choice.ts`: `setMilestoneBranch`, `ensureMilestoneBranchName`, `renderMilestoneBranchQuestion`.
- `src/resources/extensions/gsd/tests/milestone-branch-fixture.ts`: temp git repo helpers.
- Tests: `milestone-branch-registry.test.ts`, `milestone-branch-choice.test.ts`, `milestone-branch-prompt.test.ts`, `milestone-branch-lifecycle.test.ts`, `milestone-branch-detection.test.ts`, `milestone-branch-cleanup.test.ts`, `milestone-set-branch-tool.test.ts`, `milestone-branch-prompt-rendering.test.ts`, `milestone-branch-transition-prompt.test.ts`, all under `src/resources/extensions/gsd/tests/`.

Modify (by task):

- Task 3: `git-service.ts` (type), `preferences-validation.ts`, `config-overlay.ts`, `docs/preferences-reference.md`, `docs/user-docs/configuration.md`.
- Task 5: `auto-worktree-branch-lifecycle.ts`, `auto-worktree-creation.ts`, `auto-worktree-teardown.ts`, `auto-worktree-merge.ts`, `slice-cadence.ts`, `worktree-lifecycle.ts`, `guidance.ts`, `parallel-orchestrator.ts`, `auto/orchestrator.ts`, `auto.ts`, `unmerged-milestone-guard.ts`, `clean-root-preflight.ts`, `auto-start.ts`, `orphan-milestone-discard.ts`, `milestone-actions.ts`, `doctor-git-checks.ts`, `github-sync/sync.ts`.
- Task 6: `git-service.ts`, `auto-start.ts`, `milestone-implementation-evidence.ts`, `auto-worktree-entry.ts`, `unit-closeout.ts`, `auto-worktree-session-registry.ts`, `doctor-git-checks.ts`, `worktree-manager.ts`, `commands-maintenance.ts`, `closeout-wizard.ts`.
- Task 7: `auto-worktree-teardown.ts`, `auto-worktree-merge-cleanup.ts`, `milestone-actions.ts`, `orphan-milestone-discard.ts`, `doctor-git-checks.ts`, `commands-maintenance.ts`, `auto-start.ts`.
- Task 8: `packages/contracts/src/workflow.ts`, `bootstrap/db-tools.ts`, `unit-registry.ts`, `constants.ts`, `bootstrap/write-gate.ts`, `packages/mcp-server/src/workflow-tools.ts`, `packages/mcp-server/src/workflow-tools.test.ts`, `tests/token-tool-gating.test.ts`, `tests/discuss-tool-scoping.test.ts`.
- Task 9: `prompts/discuss.md`, `prompts/guided-discuss-milestone.md`, `prompts/queue.md`, `guided-flow.ts`, `guided-flow-queue.ts`, `auto-prompts.ts`, and three prompt tests.
- Task 10: `auto-start.ts`, `auto/pre-dispatch.ts`, `docs/user-docs/git-strategy.md`.

All paths without a directory prefix are under `src/resources/extensions/gsd/`.

---

### Task 1: Milestone branch registry

**Files:**
- Create: `src/resources/extensions/gsd/milestone-branch-registry.ts`
- Create: `src/resources/extensions/gsd/tests/milestone-branch-fixture.ts`
- Test: `src/resources/extensions/gsd/tests/milestone-branch-registry.test.ts`

**Interfaces:**
- Consumes: `gsdRoot` (`paths.ts`), `resolveWorktreeProjectRoot` (`worktree-root.ts`), `nativeBranchExists`, `nativeBranchList`, `nativeBranchListMerged` (`native-git-bridge.ts`), `atomicWriteSync` (`atomic-write.ts`), `MILESTONE_BRANCH_PREFIX` (`branch-patterns.ts`).
- Produces:
  - `defaultMilestoneBranch(milestoneId: string): string`
  - `milestoneIdFromDefaultBranch(branch: string): string | null`
  - `readMilestoneBranchRecord(basePath: string, milestoneId: string): string | null` (throws `GSDError` when unreadable)
  - `writeMilestoneBranchRecord(basePath: string, milestoneId: string, branch: string): void`
  - `hasMilestoneBranchRecord(basePath: string, milestoneId: string): boolean`
  - `autoWorktreeBranch(basePath: string, milestoneId: string): string`
  - `milestoneIdForBranch(basePath: string, branch: string): string | null`
  - `isMilestoneBranch(basePath: string, branch: string): boolean`
  - `listMilestoneBranches(basePath: string, git?: { branchList?: typeof nativeBranchList; branchExists?: typeof nativeBranchExists }): string[]`
  - `listMergedMilestoneBranches(basePath: string, target: string): string[]`
  - `forgetMilestoneBranchIfDeleted(basePath: string, milestoneId: string): void`
  - Fixture: `git(cwd: string, ...args: string[]): string`, `makeRepo(prefix: string): string`, `removeRepo(repo: string): void`

- [ ] **Step 1: Write the fixture**

Create `src/resources/extensions/gsd/tests/milestone-branch-fixture.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing tests**

Create `src/resources/extensions/gsd/tests/milestone-branch-registry.test.ts`:

```ts
// gsd-pi — Milestone branch registry: records, default names, reverse lookup.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  autoWorktreeBranch,
  forgetMilestoneBranchIfDeleted,
  hasMilestoneBranchRecord,
  isMilestoneBranch,
  listMergedMilestoneBranches,
  listMilestoneBranches,
  milestoneIdForBranch,
  readMilestoneBranchRecord,
  writeMilestoneBranchRecord,
} from "../milestone-branch-registry.ts";
import { worktreePath } from "../worktree-manager.ts";
import { git, makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

describe("milestone branch registry", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo("gsd-ms-branch-registry-");
  });

  afterEach(() => {
    removeRepo(repo);
  });

  test("a milestone with no record uses milestone/<MID>", () => {
    assert.equal(autoWorktreeBranch(repo, "M001"), "milestone/M001");
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), false);
  });

  test("a recorded name replaces the default", () => {
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");
    assert.equal(autoWorktreeBranch(repo, "M001"), "feat/add_auth");
    assert.equal(readMilestoneBranchRecord(repo, "M001"), "feat/add_auth");
    assert.ok(existsSync(join(repo, ".gsd", "milestone-branches", "M001.json")));
  });

  test("a worktree path and the project root read the same record", () => {
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");
    const wt = worktreePath(repo, "M001");
    mkdirSync(wt, { recursive: true });
    assert.equal(hasMilestoneBranchRecord(wt, "M001"), true);
    assert.equal(autoWorktreeBranch(wt, "M001"), "feat/add_auth");
  });

  test("milestoneIdForBranch resolves default names and recorded names", () => {
    writeMilestoneBranchRecord(repo, "M002", "feat/billing");
    assert.equal(milestoneIdForBranch(repo, "milestone/M001"), "M001");
    assert.equal(milestoneIdForBranch(repo, "feat/billing"), "M002");
    assert.equal(milestoneIdForBranch(repo, "main"), null);
    assert.equal(isMilestoneBranch(repo, "feat/billing"), true);
    assert.equal(isMilestoneBranch(repo, "feat/other"), false);
  });

  test("listMilestoneBranches includes a recorded name only once its branch exists", () => {
    git(repo, "branch", "milestone/M001");
    writeMilestoneBranchRecord(repo, "M002", "feat/billing");
    writeMilestoneBranchRecord(repo, "M003", "feat/not_created_yet");
    git(repo, "branch", "feat/billing");
    assert.deepEqual(listMilestoneBranches(repo).sort(), ["feat/billing", "milestone/M001"]);
  });

  test("listMergedMilestoneBranches returns merged default and recorded branches only", () => {
    git(repo, "branch", "milestone/M001");
    git(repo, "branch", "feat/billing");
    git(repo, "branch", "feat/unrelated");
    writeMilestoneBranchRecord(repo, "M002", "feat/billing");
    assert.deepEqual(listMergedMilestoneBranches(repo, "main").sort(), ["feat/billing", "milestone/M001"]);
  });

  test("an unreadable record stops autoWorktreeBranch, and scans skip it", () => {
    mkdirSync(join(repo, ".gsd", "milestone-branches"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "milestone-branches", "M001.json"), "{not json");
    assert.throws(() => autoWorktreeBranch(repo, "M001"), /M001\.json/);
    assert.equal(milestoneIdForBranch(repo, "feat/anything"), null);
  });

  test("forgetMilestoneBranchIfDeleted keeps the record until the branch is gone", () => {
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");
    git(repo, "branch", "feat/add_auth");
    forgetMilestoneBranchIfDeleted(repo, "M001");
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), true);

    git(repo, "branch", "-D", "feat/add_auth");
    forgetMilestoneBranchIfDeleted(repo, "M001");
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), false);
  });
});
```

- [ ] **Step 3: Run the tests to make sure they fail**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-registry.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `milestone-branch-registry.ts`.

- [ ] **Step 4: Write the registry**

Create `src/resources/extensions/gsd/milestone-branch-registry.ts`:

```ts
// gsd-pi — Milestone branch registry.
//
// Owns the name of each milestone's working branch. A milestone uses
// `milestone/<MID>` unless .gsd/milestone-branches/<MID>.json at the project
// root records a name the user chose. Teardown never deletes a record:
// stopping auto-mode keeps the branch, so resuming must find the same name.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteSync } from "./atomic-write.js";
import { MILESTONE_BRANCH_PREFIX } from "./branch-patterns.js";
import { GSDError, GSD_PARSE_ERROR } from "./errors.js";
import { nativeBranchExists, nativeBranchList, nativeBranchListMerged } from "./native-git-bridge.js";
import { gsdRoot } from "./paths.js";
import { logWarning } from "./workflow-logger.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";

const RECORD_DIR_NAME = "milestone-branches";
const RECORD_SUFFIX = ".json";

function recordDir(basePath: string): string {
  return join(gsdRoot(resolveWorktreeProjectRoot(basePath)), RECORD_DIR_NAME);
}

function recordPath(basePath: string, milestoneId: string): string {
  return join(recordDir(basePath), `${milestoneId}${RECORD_SUFFIX}`);
}

function parseRecord(file: string): string {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new GSDError(
      GSD_PARSE_ERROR,
      `Milestone branch record ${file} is unreadable (${err instanceof Error ? err.message : String(err)}). Fix or delete the file.`,
    );
  }
  const branch = (data as { branch?: unknown } | null)?.branch;
  if (typeof branch !== "string" || branch.trim() === "") {
    throw new GSDError(GSD_PARSE_ERROR, `Milestone branch record ${file} has no "branch" string. Fix or delete the file.`);
  }
  return branch;
}

function listRecordFiles(basePath: string): { dir: string; entries: string[] } | null {
  try {
    const dir = recordDir(basePath);
    return { dir, entries: readdirSync(dir) };
  } catch {
    return null;
  }
}

function readAllRecords(basePath: string): Map<string, string> {
  const records = new Map<string, string>();
  const listing = listRecordFiles(basePath);
  if (!listing) return records;
  for (const entry of listing.entries) {
    if (!entry.endsWith(RECORD_SUFFIX)) continue;
    try {
      records.set(entry.slice(0, -RECORD_SUFFIX.length), parseRecord(join(listing.dir, entry)));
    } catch (err) {
      logWarning("worktree", `${err instanceof Error ? err.message : String(err)} Skipping it.`);
    }
  }
  return records;
}

export function defaultMilestoneBranch(milestoneId: string): string {
  return `${MILESTONE_BRANCH_PREFIX}${milestoneId}`;
}

export function milestoneIdFromDefaultBranch(branch: string): string | null {
  if (!branch.startsWith(MILESTONE_BRANCH_PREFIX)) return null;
  return branch.slice(MILESTONE_BRANCH_PREFIX.length) || null;
}

export function readMilestoneBranchRecord(basePath: string, milestoneId: string): string | null {
  const file = recordPath(basePath, milestoneId);
  return existsSync(file) ? parseRecord(file) : null;
}

/** Writes without validation. Callers go through setMilestoneBranch. */
export function writeMilestoneBranchRecord(basePath: string, milestoneId: string, branch: string): void {
  const file = recordPath(basePath, milestoneId);
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteSync(file, `${JSON.stringify({ branch }, null, 2)}\n`);
}

export function hasMilestoneBranchRecord(basePath: string, milestoneId: string): boolean {
  return existsSync(recordPath(basePath, milestoneId));
}

/**
 * Throws on an unreadable record instead of falling back to the default:
 * the fallback would start a second branch and split the milestone's work.
 */
export function autoWorktreeBranch(basePath: string, milestoneId: string): string {
  return readMilestoneBranchRecord(basePath, milestoneId) ?? defaultMilestoneBranch(milestoneId);
}

export function milestoneIdForBranch(basePath: string, branch: string): string | null {
  const fromDefault = milestoneIdFromDefaultBranch(branch);
  if (fromDefault) return fromDefault;
  for (const [milestoneId, recorded] of readAllRecords(basePath)) {
    if (recorded === branch) return milestoneId;
  }
  return null;
}

export function isMilestoneBranch(basePath: string, branch: string): boolean {
  return milestoneIdForBranch(basePath, branch) !== null;
}

export function listMilestoneBranches(
  basePath: string,
  git: { branchList?: typeof nativeBranchList; branchExists?: typeof nativeBranchExists } = {},
): string[] {
  const branchList = git.branchList ?? nativeBranchList;
  const branchExists = git.branchExists ?? nativeBranchExists;
  const branches = new Set(branchList(basePath, `${MILESTONE_BRANCH_PREFIX}*`));
  for (const recorded of readAllRecords(basePath).values()) {
    if (!branches.has(recorded) && branchExists(basePath, recorded)) branches.add(recorded);
  }
  return [...branches];
}

export function listMergedMilestoneBranches(basePath: string, target: string): string[] {
  const recorded = new Set(readAllRecords(basePath).values());
  return nativeBranchListMerged(basePath, target)
    .map((branch) => branch.replace(/^[*+]\s+/, ""))
    .filter((branch) => branch.startsWith(MILESTONE_BRANCH_PREFIX) || recorded.has(branch));
}

/**
 * Keeps the record when the branch still exists (the delete failed) or the
 * record is unreadable, so the branch stays attributable to its milestone.
 */
export function forgetMilestoneBranchIfDeleted(basePath: string, milestoneId: string): void {
  try {
    const branch = readMilestoneBranchRecord(basePath, milestoneId);
    if (branch === null) return;
    if (nativeBranchExists(resolveWorktreeProjectRoot(basePath), branch)) return;
    unlinkSync(recordPath(basePath, milestoneId));
  } catch (err) {
    logWarning(
      "worktree",
      `Could not clear the branch record for ${milestoneId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-registry.test.ts`
Expected: PASS, 8 tests.

If "a worktree path and the project root read the same record" fails, print `resolveWorktreeProjectRoot(wt)`. It must equal `repo`. Fix the registry's path resolution, not the test.

- [ ] **Step 6: Type-check**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/resources/extensions/gsd/milestone-branch-registry.ts src/resources/extensions/gsd/tests/milestone-branch-fixture.ts src/resources/extensions/gsd/tests/milestone-branch-registry.test.ts
git commit -m "feat(gsd): add a durable registry for milestone branch names"
```

---

### Task 2: Validate and record a chosen name

**Files:**
- Create: `src/resources/extensions/gsd/milestone-branch-choice.ts`
- Test: `src/resources/extensions/gsd/tests/milestone-branch-choice.test.ts`

**Interfaces:**
- Consumes: Task 1 (`defaultMilestoneBranch`, `milestoneIdForBranch`, `milestoneIdFromDefaultBranch`, `readMilestoneBranchRecord`, `writeMilestoneBranchRecord`), `readIntegrationBranch` and `VALID_BRANCH_NAME` (`git-service.ts`), `gitCapture` (`git-exec.ts`), `SLICE_BRANCH_RE`, `QUICK_BRANCH_RE`, `WORKFLOW_BRANCH_RE` (`branch-patterns.ts`).
- Produces: `setMilestoneBranch(basePath: string, milestoneId: string, requestedBranch: string): { ok: true; branch: string } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing tests**

Create `src/resources/extensions/gsd/tests/milestone-branch-choice.test.ts`:

```ts
// gsd-pi — setMilestoneBranch: which names a milestone may use.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { writeIntegrationBranch } from "../git-service.ts";
import { setMilestoneBranch } from "../milestone-branch-choice.ts";
import {
  autoWorktreeBranch,
  hasMilestoneBranchRecord,
  writeMilestoneBranchRecord,
} from "../milestone-branch-registry.ts";
import { git, makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

function reasonOf(result: ReturnType<typeof setMilestoneBranch>): string {
  assert.equal(result.ok, false, "expected a rejection");
  return (result as { reason: string }).reason;
}

describe("setMilestoneBranch", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo("gsd-ms-branch-choice-");
  });

  afterEach(() => {
    removeRepo(repo);
  });

  test("records a valid new name, trimmed", () => {
    assert.deepEqual(setMilestoneBranch(repo, "M001", "  feat/add_auth  "), { ok: true, branch: "feat/add_auth" });
    assert.equal(autoWorktreeBranch(repo, "M001"), "feat/add_auth");
  });

  test("records the default name", () => {
    assert.deepEqual(setMilestoneBranch(repo, "M001", "milestone/M001"), { ok: true, branch: "milestone/M001" });
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), true);
  });

  test("lets the user change the name until the branch exists", () => {
    assert.equal(setMilestoneBranch(repo, "M001", "feat/one").ok, true);
    assert.equal(setMilestoneBranch(repo, "M001", "feat/two").ok, true);
    git(repo, "branch", "feat/two");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "feat/three")), /fixed once the branch exists/);
    assert.deepEqual(setMilestoneBranch(repo, "M001", "feat/two"), { ok: true, branch: "feat/two" });
  });

  test("a live legacy milestone/<MID> branch fixes the name", () => {
    git(repo, "branch", "milestone/M001");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "feat/x")), /milestone\/M001/);
    assert.deepEqual(setMilestoneBranch(repo, "M001", "milestone/M001"), { ok: true, branch: "milestone/M001" });
  });

  for (const bad of ["feat/bad name", "feat..x", "-feat", "refs/heads/feat/x", "", "   "]) {
    test(`rejects the invalid name ${JSON.stringify(bad)}`, () => {
      assert.match(reasonOf(setMilestoneBranch(repo, "M001", bad)), /not a valid git branch name/);
      assert.equal(hasMilestoneBranchRecord(repo, "M001"), false);
    });
  }

  test("rejects another milestone's default name", () => {
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "milestone/M002")), /reserved/);
  });

  test("rejects names reserved for gsd slice, quick-task, and workflow branches", () => {
    for (const name of ["gsd/M001/S01", "gsd/quick/1-fix", "gsd/hotfix/login"]) {
      assert.match(reasonOf(setMilestoneBranch(repo, "M001", name)), /reserves/);
    }
  });

  test("rejects a name another milestone recorded", () => {
    writeMilestoneBranchRecord(repo, "M002", "feat/shared");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "feat/shared")), /Milestone M002 already uses/);
  });

  test("rejects the milestone's integration branch", () => {
    writeIntegrationBranch(repo, "M001", "develop");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "develop")), /integration branch/);
  });

  test("rejects an existing branch", () => {
    git(repo, "branch", "feat/taken");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "feat/taken")), /already exists/);
  });

  test("rejects a name that differs from an existing branch only in case", () => {
    git(repo, "branch", "feat/Upper");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "feat/upper")), /clashes with the existing branch "feat\/Upper"/);
  });

  test("rejects a name that is a parent or child path of an existing branch", () => {
    git(repo, "branch", "feat");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "feat/x")), /clashes with the existing branch "feat"/);
    git(repo, "branch", "team/x");
    assert.match(reasonOf(setMilestoneBranch(repo, "M001", "team")), /clashes with the existing branch "team\/x"/);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-choice.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `milestone-branch-choice.ts`.

- [ ] **Step 3: Write `setMilestoneBranch`**

Create `src/resources/extensions/gsd/milestone-branch-choice.ts`:

```ts
// gsd-pi — Choosing a milestone's working-branch name.
//
// Separate from milestone-branch-registry.ts because validation needs
// git-service.ts, and git-service.ts imports the registry.

import { QUICK_BRANCH_RE, SLICE_BRANCH_RE, WORKFLOW_BRANCH_RE } from "./branch-patterns.js";
import { gitCapture } from "./git-exec.js";
import { readIntegrationBranch, VALID_BRANCH_NAME } from "./git-service.js";
import {
  defaultMilestoneBranch,
  milestoneIdForBranch,
  milestoneIdFromDefaultBranch,
  readMilestoneBranchRecord,
  writeMilestoneBranchRecord,
} from "./milestone-branch-registry.js";
import { nativeBranchExists, nativeBranchList } from "./native-git-bridge.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";

export function setMilestoneBranch(
  basePath: string,
  milestoneId: string,
  requestedBranch: string,
): { ok: true; branch: string } | { ok: false; reason: string } {
  const projectRoot = resolveWorktreeProjectRoot(basePath);
  const branch = requestedBranch.trim();
  const defaultBranch = defaultMilestoneBranch(milestoneId);

  const liveBranch = [readMilestoneBranchRecord(projectRoot, milestoneId), defaultBranch]
    .find((candidate): candidate is string => !!candidate && nativeBranchExists(projectRoot, candidate));
  if (liveBranch && liveBranch !== branch) {
    return {
      ok: false,
      reason: `${milestoneId} already works on branch ${liveBranch}. The name is fixed once the branch exists.`,
    };
  }

  if (!liveBranch) {
    const problem = nameProblem(projectRoot, milestoneId, branch, defaultBranch);
    if (problem) return { ok: false, reason: problem };
  }

  writeMilestoneBranchRecord(projectRoot, milestoneId, branch);
  return { ok: true, branch };
}

function nameProblem(projectRoot: string, milestoneId: string, branch: string, defaultBranch: string): string | null {
  if (!isValidBranchName(branch)) return `"${branch}" is not a valid git branch name.`;
  if (milestoneIdFromDefaultBranch(branch) !== null && branch !== defaultBranch) {
    return `Names under milestone/ are reserved. Use ${defaultBranch} or a name outside milestone/.`;
  }
  if (SLICE_BRANCH_RE.test(branch) || QUICK_BRANCH_RE.test(branch) || WORKFLOW_BRANCH_RE.test(branch)) {
    return `"${branch}" matches a pattern that gsd reserves for slice, quick-task, or workflow branches.`;
  }
  const owner = milestoneIdForBranch(projectRoot, branch);
  if (owner !== null && owner !== milestoneId) return `Milestone ${owner} already uses "${branch}".`;
  if (branch === readIntegrationBranch(projectRoot, milestoneId)) {
    return `"${branch}" is the integration branch that ${milestoneId} merges into.`;
  }
  const clash = clashingBranch(projectRoot, branch);
  if (clash === branch) return `A branch named "${branch}" already exists.`;
  if (clash) return `"${branch}" clashes with the existing branch "${clash}".`;
  return null;
}

// Git accepts `refs/heads/x` and `-x` as literal branch names; neither is what
// a user who pastes them means.
function isValidBranchName(branch: string): boolean {
  if (!VALID_BRANCH_NAME.test(branch) || branch.startsWith("-") || branch.startsWith("refs/")) return false;
  try {
    gitCapture(undefined, ["check-ref-format", "--branch", branch]);
    return true;
  } catch {
    return false;
  }
}

// Git refuses to create a ref when another ref differs only in case on a
// case-insensitive file system, or when one name is a directory of the other
// (`feat` and `feat/x`). Catch both here instead of at milestone entry.
function clashingBranch(projectRoot: string, branch: string): string | null {
  const wanted = branch.toLowerCase();
  for (const existing of nativeBranchList(projectRoot)) {
    const have = existing.toLowerCase();
    if (have === wanted || have.startsWith(`${wanted}/`) || wanted.startsWith(`${have}/`)) return existing;
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-choice.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Type-check**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/resources/extensions/gsd/milestone-branch-choice.ts src/resources/extensions/gsd/tests/milestone-branch-choice.test.ts
git commit -m "feat(gsd): validate and record a user-chosen milestone branch name"
```

---

### Task 3: `git.milestone_branch_format` preference

**Files:**
- Modify: `src/resources/extensions/gsd/git-service.ts` (`GitPreferences`, after `pr_target_branch?: string;`)
- Modify: `src/resources/extensions/gsd/preferences-validation.ts` (after the `pr_target_branch` block, about line 1481)
- Modify: `src/resources/extensions/gsd/config-overlay.ts` (git rows, about line 138)
- Modify: `src/resources/extensions/gsd/docs/preferences-reference.md` (git keys list, after `pr_target_branch`)
- Modify: `docs/user-docs/configuration.md` (git YAML example and table, after `pr_target_branch`)
- Test: `src/resources/extensions/gsd/tests/preferences.test.ts`, `src/resources/extensions/gsd/tests/milestone-branch-prompt.test.ts` (new, overlay test only in this task)

**Interfaces:**
- Produces: `GitPreferences.milestone_branch_format?: string`

- [ ] **Step 1: Write the failing tests**

Append to `src/resources/extensions/gsd/tests/preferences.test.ts`, in the "Git preferences" section:

```ts
test("git.milestone_branch_format accepts a non-empty string and rejects other values", () => {
  const ok = validatePreferences({ git: { milestone_branch_format: "  <type>/<summary>  " } });
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.preferences.git?.milestone_branch_format, "<type>/<summary>");

  for (const bad of ["", "   ", 42]) {
    const { errors } = validatePreferences({ git: { milestone_branch_format: bad as any } });
    assert.ok(errors.includes("git.milestone_branch_format must be a non-empty string"), `rejects ${JSON.stringify(bad)}`);
  }
});
```

Create `src/resources/extensions/gsd/tests/milestone-branch-prompt.test.ts` (Task 4 adds more tests to this file):

```ts
// gsd-pi — Asking for a milestone branch name: config display, TUI prompt, discuss question.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatConfigText } from "../config-overlay.ts";
import { makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

function writeGitPrefs(repo: string, lines: string[]): void {
  writeFileSync(join(repo, ".gsd", "PREFERENCES.md"), ["---", "git:", ...lines.map((l) => `  ${l}`), "---", ""].join("\n"));
}

describe("milestone branch preference display", () => {
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

  test("the config overlay shows the milestone branch format", () => {
    writeGitPrefs(repo, ["milestone_branch_format: \"<change-type>/<short_snake_case_summary>\""]);
    const text = formatConfigText({ basePath: repo });
    assert.match(text, /Milestone branch format/);
    assert.match(text, /<change-type>\/<short_snake_case_summary>/);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/preferences.test.ts src/resources/extensions/gsd/tests/milestone-branch-prompt.test.ts`
Expected: FAIL. The validation test finds no error message, and the overlay text has no "Milestone branch format".

- [ ] **Step 3: Add the type, validation, and display**

In `git-service.ts`, inside `interface GitPreferences`, after `pr_target_branch?: string;`:

```ts
  /** Free-text naming convention for milestone branches, for example
   *  "<change-type>/<short_snake_case_summary>". gsd shows it when it asks
   *  the user for a milestone's branch name.
   */
  milestone_branch_format?: string;
```

In `preferences-validation.ts`, after the `g.pr_target_branch` block:

```ts
    if (g.milestone_branch_format !== undefined) {
      if (typeof g.milestone_branch_format === "string" && g.milestone_branch_format.trim()) {
        git.milestone_branch_format = g.milestone_branch_format.trim();
      } else {
        errors.push("git.milestone_branch_format must be a non-empty string");
      }
    }
```

In `config-overlay.ts`, in the git rows, after the `Remote` row:

```ts
    if (g.milestone_branch_format) gitRows.push({ label: "Milestone branch format", value: g.milestone_branch_format });
```

- [ ] **Step 4: Document the preference**

In `src/resources/extensions/gsd/docs/preferences-reference.md`, after the `pr_target_branch` bullet:

```markdown
  - `milestone_branch_format`: string — the team's naming convention for milestone branches, for example `"<change-type>/<short_snake_case_summary>"`. When `isolation` is `worktree` or `branch`, gsd asks for each milestone's branch name and suggests one that follows this format. Default: none (gsd suggests `milestone/<MID>`).
```

In `docs/user-docs/configuration.md`, in the git YAML example after the `pr_target_branch` line:

```yaml
  milestone_branch_format: "<change-type>/<short_snake_case_summary>"  # convention for suggested milestone branch names
```

In the same file's git table, after the `pr_target_branch` row:

```markdown
| `milestone_branch_format` | string | (none) | Naming convention that gsd follows when it suggests a milestone branch name. gsd asks for the name when `isolation` is `worktree` or `branch` |
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/preferences.test.ts src/resources/extensions/gsd/tests/milestone-branch-prompt.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/resources/extensions/gsd/git-service.ts src/resources/extensions/gsd/preferences-validation.ts src/resources/extensions/gsd/config-overlay.ts src/resources/extensions/gsd/docs/preferences-reference.md docs/user-docs/configuration.md src/resources/extensions/gsd/tests/preferences.test.ts src/resources/extensions/gsd/tests/milestone-branch-prompt.test.ts
git commit -m "feat(gsd): add the git.milestone_branch_format preference"
```

---

### Task 4: TUI prompt and discuss-question text

**Files:**
- Modify: `src/resources/extensions/gsd/milestone-branch-choice.ts`
- Test: `src/resources/extensions/gsd/tests/milestone-branch-prompt.test.ts`

**Interfaces:**
- Consumes: Task 1 (`defaultMilestoneBranch`, `hasMilestoneBranchRecord`), Task 2 (`setMilestoneBranch`), Task 3 (`milestone_branch_format`), `loadEffectiveGSDPreferences` (`preferences.ts`).
- Produces:
  - `ensureMilestoneBranchName(ctx: { hasUI: boolean; ui: { input(title: string, placeholder?: string): Promise<string | undefined>; notify(message: string, type?: "info" | "warning" | "error"): void } }, basePath: string, milestoneId: string, milestoneTitle: string | undefined): Promise<void>`
  - `renderMilestoneBranchQuestion(basePath: string): string`

- [ ] **Step 1: Write the failing tests**

Append to `src/resources/extensions/gsd/tests/milestone-branch-prompt.test.ts`. Add these imports at the top of the file:

```ts
import { ensureMilestoneBranchName, renderMilestoneBranchQuestion } from "../milestone-branch-choice.ts";
import { autoWorktreeBranch, hasMilestoneBranchRecord, writeMilestoneBranchRecord } from "../milestone-branch-registry.ts";
import { git } from "./milestone-branch-fixture.ts";
```

Merge the `git` import into the existing fixture import line. Then append:

```ts
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

describe("ensureMilestoneBranchName", () => {
  let repo: string;
  let gsdHome: string;
  let previousGsdHome: string | undefined;

  beforeEach(() => {
    repo = makeRepo("gsd-ms-branch-ensure-");
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
  let repo: string;
  let gsdHome: string;
  let previousGsdHome: string | undefined;

  beforeEach(() => {
    repo = makeRepo("gsd-ms-branch-question-");
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
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-prompt.test.ts`
Expected: FAIL with `does not provide an export named 'ensureMilestoneBranchName'`.

- [ ] **Step 3: Write the two functions**

In `milestone-branch-choice.ts`, add these imports:

```ts
import { defaultMilestoneBranch, hasMilestoneBranchRecord } from "./milestone-branch-registry.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
```

Merge `defaultMilestoneBranch` and `hasMilestoneBranchRecord` into the existing registry import instead of adding a second import line. Then append:

```ts
interface MilestoneBranchPromptCtx {
  hasUI: boolean;
  ui: {
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

/**
 * Asks just before auto-mode creates the branch. Callers skip it when git
 * isolation is "none". A headless session records nothing, so the milestone
 * keeps the `milestone/<MID>` default.
 */
export async function ensureMilestoneBranchName(
  ctx: MilestoneBranchPromptCtx,
  basePath: string,
  milestoneId: string,
  milestoneTitle: string | undefined,
): Promise<void> {
  if (!ctx.hasUI) return;
  const projectRoot = resolveWorktreeProjectRoot(basePath);
  if (hasMilestoneBranchRecord(projectRoot, milestoneId)) return;

  const defaultBranch = defaultMilestoneBranch(milestoneId);
  if (nativeBranchExists(projectRoot, defaultBranch)) {
    setMilestoneBranch(projectRoot, milestoneId, defaultBranch);
    return;
  }

  const format = loadEffectiveGSDPreferences(projectRoot)?.preferences?.git?.milestone_branch_format;
  const title = [
    `Branch name for ${milestoneId}${milestoneTitle ? ` (${milestoneTitle})` : ""}.`,
    format ? `Convention: ${format}.` : null,
    `Leave empty for ${defaultBranch}.`,
  ].filter((part): part is string => part !== null).join(" ");

  for (;;) {
    const answer = (await ctx.ui.input(title, defaultBranch))?.trim() ?? "";
    const result = setMilestoneBranch(projectRoot, milestoneId, answer || defaultBranch);
    if (result.ok) return;
    ctx.ui.notify(result.reason, "warning");
    if (!answer) return;
  }
}

/** Empty when git isolation is off, because then gsd creates no milestone branch. */
export function renderMilestoneBranchQuestion(basePath: string): string {
  const git = loadEffectiveGSDPreferences(basePath)?.preferences?.git;
  if (git?.isolation !== "worktree" && git?.isolation !== "branch") return "";
  const format = git.milestone_branch_format;
  const options = format
    ? [
        `a name built from the milestone title that follows the team convention \`${format}\`, labeled "(Recommended)"`,
        "`milestone/<ID>`",
        "\"Other — let me type it\"",
      ]
    : ["`milestone/<ID>`, labeled \"(Recommended)\"", "\"Other — let me type it\""];
  return [
    "## Milestone Branch Name",
    "",
    "gsd does each milestone's work on its own git branch. Ask the user what to call it.",
    "",
    "- Ask in the same `ask_user_questions` call as the milestone's depth verification question, as a second question with header \"Branch\" and id `milestone_branch_<ID>`. That id must not contain `depth_verification`.",
    `- Options: ${options.join("; ")}.`,
    "- If `ask_user_questions` is unavailable, ask the same question in plain text.",
    "- After the depth check passes and the milestone ID exists, call `gsd_milestone_set_branch` with `milestoneId` and the chosen `branch`, before you save that milestone's CONTEXT. For the default, pass `milestone/<ID>` with the real ID.",
    "- If the tool rejects the name, show the user its reason and ask again.",
  ].join("\n");
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/resources/extensions/gsd/milestone-branch-choice.ts src/resources/extensions/gsd/tests/milestone-branch-prompt.test.ts
git commit -m "feat(gsd): ask for a milestone branch name in the TUI and in discuss prompts"
```

---

### Task 5: Build every milestone branch name through the registry

**Files:**
- Modify: `auto-worktree-branch-lifecycle.ts:26-29,63`, `auto-worktree-creation.ts:87`, `auto-worktree-teardown.ts:51`, `auto-worktree-merge.ts:112`, `slice-cadence.ts:46-52,181`, `worktree-lifecycle.ts:532-538,795-797,881,1253,1753,1770,1791,1989`, `guidance.ts:179-185`, `parallel-orchestrator.ts:543`, `auto/orchestrator.ts:860`, `auto.ts:2451`, `unmerged-milestone-guard.ts:172`, `clean-root-preflight.ts:183`, `auto-start.ts:792-796,1487`, `orphan-milestone-discard.ts:133`, `milestone-actions.ts:155`, `doctor-git-checks.ts:545`, `src/resources/extensions/github-sync/sync.ts:399`
- Test: `src/resources/extensions/gsd/tests/milestone-branch-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 1 `autoWorktreeBranch(basePath, milestoneId)`.
- Produces: `auto-worktree-branch-lifecycle.ts` re-exports the registry's `autoWorktreeBranch`, so `auto-worktree.ts` and existing importers keep working with the new two-argument signature. `isolationDegradedFallbackGuidance(milestoneId: string, branch: string): string`.

- [ ] **Step 1: Write the failing tests**

Create `src/resources/extensions/gsd/tests/milestone-branch-lifecycle.test.ts`:

```ts
// gsd-pi — Milestone entry creates the branch under its recorded name.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enterBranchModeForMilestone } from "../auto-worktree-branch-lifecycle.ts";
import { createAutoWorktree } from "../auto-worktree-creation.ts";
import { writeMilestoneBranchRecord } from "../milestone-branch-registry.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { _resetServiceCache } from "../worktree.ts";
import { git, makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

describe("milestone entry with a recorded branch name", () => {
  let repo: string;
  let savedCwd: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    savedCwd = process.cwd();
    originalHome = process.env.HOME;
    fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-fake-home-")));
    process.env.HOME = fakeHome;
    _clearGsdRootCache();
    _resetServiceCache();
    repo = makeRepo("gsd-ms-branch-lifecycle-");
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");
  });

  afterEach(() => {
    process.chdir(savedCwd);
    process.env.HOME = originalHome;
    _clearGsdRootCache();
    _resetServiceCache();
    removeRepo(repo);
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test("branch mode checks out the recorded branch", () => {
    enterBranchModeForMilestone(repo, "M001");
    assert.equal(git(repo, "branch", "--show-current"), "feat/add_auth");
    assert.equal(git(repo, "branch", "--list", "milestone/M001"), "");
  });

  test("worktree mode creates the worktree on the recorded branch", () => {
    const wtPath = createAutoWorktree(repo, "M001");
    assert.equal(git(wtPath, "branch", "--show-current"), "feat/add_auth");
    assert.equal(git(repo, "branch", "--list", "milestone/M001"), "");
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-lifecycle.test.ts`
Expected: FAIL. Both tests find `milestone/M001` instead of `feat/add_auth`.

- [ ] **Step 3: Move `autoWorktreeBranch` into the registry**

In `auto-worktree-branch-lifecycle.ts`, delete the local `autoWorktreeBranch` function and its doc comment (lines 26-29). Add:

```ts
import { autoWorktreeBranch } from "./milestone-branch-registry.js";

export { autoWorktreeBranch };
```

In `enterBranchModeForMilestone`, change `const branch = autoWorktreeBranch(milestoneId);` to:

```ts
  const branch = autoWorktreeBranch(basePath, milestoneId);
```

Update the doc comment on `enterBranchModeForMilestone` from "Creates `milestone/<MID>`" to "Creates the milestone branch".

- [ ] **Step 4: Update the core lifecycle call sites**

`auto-worktree-creation.ts:87`:

```ts
  const branch = autoWorktreeBranch(basePath, milestoneId);
```

`auto-worktree-teardown.ts:51` (after `originalBasePath` is resolved on line 49):

```ts
  const branch = autoWorktreeBranch(originalBasePath, milestoneId);
```

`auto-worktree-merge.ts:112`:

```ts
  const milestoneBranch = autoWorktreeBranch(originalBasePath_, milestoneId);
```

`slice-cadence.ts`: delete the `milestoneBranchName` function and its comment (lines 46-52), add `import { autoWorktreeBranch } from "./milestone-branch-registry.js";`, and change line 181:

```ts
  const milestoneBranch = autoWorktreeBranch(projectRoot, milestoneId);
```

`parallel-orchestrator.ts:543`:

```ts
  const branch = autoWorktreeBranch(basePath, milestoneId);
```

Update its doc comment "Uses milestone/<MID> branch naming (same as auto-worktree.ts)." to "Uses the same milestone branch name as auto-worktree.ts."

`auto/orchestrator.ts:860`:

```ts
      mode !== "none" && milestoneId ? autoWorktreeBranch(this.s.canonicalProjectRoot, milestoneId) : null;
```

`auto.ts:2451`, inside `buildLoopDeps`, replace the bare `autoWorktreeBranch,` entry:

```ts
    autoWorktreeBranch: (milestoneId: string) => autoWorktreeBranch(s.canonicalProjectRoot, milestoneId),
```

- [ ] **Step 5: Update `worktree-lifecycle.ts` and `guidance.ts`**

Replace `lifecycleAutoWorktreeBranch` (lines 532-538) with:

```ts
function lifecycleAutoWorktreeBranch(
  deps: WorktreeLifecycleDeps,
  basePath: string,
  milestoneId: string,
): string {
  return primitiveOverrides(deps).autoWorktreeBranch?.(milestoneId) ??
    autoWorktreeBranch(basePath, milestoneId);
}

// Error messages must not throw a second time when the branch record itself
// is what failed to read.
function lifecycleMilestoneBranchLabel(
  deps: WorktreeLifecycleDeps,
  basePath: string,
  milestoneId: string,
): string {
  try {
    return lifecycleAutoWorktreeBranch(deps, basePath, milestoneId);
  } catch {
    return `the recorded branch for ${milestoneId}`;
  }
}
```

Line 1253 in `_mergeBranchModeImpl`:

```ts
    const milestoneBranch = lifecycleAutoWorktreeBranch(deps, mctx.originalBasePath, milestoneId);
```

Lines 1753, 1770, 1791: replace each `${lifecycleAutoWorktreeBranch(this.deps, milestoneId)}` with:

```ts
${lifecycleMilestoneBranchLabel(this.deps, this.s.originalBasePath || this.s.basePath, milestoneId)}
```

Lines 795-797 (inside the degraded block, `basePath` is in scope):

```ts
        const branch = lifecycleAutoWorktreeBranch(deps, basePath, milestoneId);
        if (mode === "worktree") {
          ctx.notify(isolationDegradedFallbackGuidance(milestoneId, branch), "warning");
        } else {
          ctx.notify(`Recovered branch isolation on ${branch}.`, "info");
        }
```

Line 881:

```ts
      ctx.notify(`Switched to branch ${lifecycleAutoWorktreeBranch(deps, basePath, milestoneId)}.`, "info");
```

Lines 1987-1990:

```ts
      ctx.notify(
        `Switched to branch ${lifecycleAutoWorktreeBranch(this.deps, basePath, milestoneId)} (isolation degraded).`,
        "info",
      );
```

In `guidance.ts`, change `isolationDegradedFallbackGuidance`:

```ts
export function isolationDegradedFallbackGuidance(milestoneId: string, branch: string): string {
  return [
    `Worktree isolation is degraded. Fell back to branch ${branch}.`,
    `Work continues safely on the milestone branch in the project root.`,
    restoreIsolationHint(milestoneId),
  ].join("\n");
}
```

- [ ] **Step 6: Update the remaining call sites that build the name**

Each file below gets `import { autoWorktreeBranch } from "./milestone-branch-registry.js";` (use `"../gsd/milestone-branch-registry.js"` in `github-sync/sync.ts`), unless it already imports `autoWorktreeBranch` from `auto-worktree-branch-lifecycle.js`, in which case only the call changes.

`unmerged-milestone-guard.ts:172`:

```ts
    const branch = autoWorktreeBranch(base, milestone.id);
```

`clean-root-preflight.ts:183`:

```ts
  const milestoneBranch = autoWorktreeBranch(basePath, milestoneId);
```

`auto-start.ts:792-796`:

```ts
      const branchName = autoWorktreeBranch(basePath, m.id);
      try {
        if (branchExists(basePath, branchName)) continue;
      } catch (err) {
        warnings.push(
          `Could not verify whether ${branchName} still exists; skipping branch-less worktree cleanup for safety: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
```

`auto-start.ts:1487`:

```ts
      const milestoneBranch = autoWorktreeBranch(base, survivorMilestoneId);
```

`orphan-milestone-discard.ts:133`:

```ts
    const branch = autoWorktreeBranch(basePath, snapshot.id);
```

`milestone-actions.ts:155`:

```ts
      branch: autoWorktreeBranch(basePath, milestoneId),
```

`doctor-git-checks.ts:545`:

```ts
          nativeIsCurrentUnbornBranch(basePath, autoWorktreeBranch(basePath, milestone.id));
```

`github-sync/sync.ts:399`:

```ts
  const milestoneBranch = autoWorktreeBranch(basePath, mid);
```

Leave `lifecycle-shadow-repair-domain-operation.ts:366` and `sync.ts:321,398` (`milestone/${mid}/${sid}` slice branches) unchanged. They are an idempotency key and slice branch names, not milestone branch names.

- [ ] **Step 7: Confirm no builder remains**

Run: `grep -rn --include='*.ts' -E 'milestone/\$\{' src/resources/extensions | grep -v '\.test\.'`
Expected: only `lifecycle-shadow-repair-domain-operation.ts:366` and the two `github-sync/sync.ts` slice-branch lines.

- [ ] **Step 8: Run the new tests and the affected existing tests**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-lifecycle.test.ts src/resources/extensions/gsd/tests/fast-forward-reused-milestone-branch.test.ts src/resources/extensions/gsd/tests/worktree-lifecycle.test.ts src/resources/extensions/gsd/tests/worktree-safety-phase.test.ts src/resources/extensions/gsd/tests/stale-worktree-cwd.test.ts src/resources/extensions/gsd/tests/unborn-branch.test.ts`
Expected: PASS.

- [ ] **Step 9: Type-check**

Run: `pnpm run typecheck:extensions`
Expected: exit 0. Remove any import the type check reports as unused.

- [ ] **Step 10: Commit**

```bash
git add -A src/resources/extensions/gsd src/resources/extensions/github-sync
git commit -m "feat(gsd): create milestone branches under their recorded names"
```

---

### Task 6: Detect, parse, and list milestone branches through the registry

**Files:**
- Modify: `git-service.ts:451,526,1155`, `auto-start.ts:140-148,513,532,549,742,855-887,912,928,1758`, `milestone-implementation-evidence.ts:60`, `auto-worktree-entry.ts:56`, `unit-closeout.ts:28,115`, `auto-worktree-session-registry.ts:65`, `doctor-git-checks.ts:220,227,342,350`, `worktree-manager.ts:705-709,754-758`, `commands-maintenance.ts:71-74`, `closeout-wizard.ts:70-79`
- Test: `src/resources/extensions/gsd/tests/milestone-branch-detection.test.ts`

**Interfaces:**
- Consumes: Task 1 `isMilestoneBranch`, `milestoneIdForBranch`, `milestoneIdFromDefaultBranch`, `listMilestoneBranches`, `listMergedMilestoneBranches`.
- Produces:
  - `resolveIsolationNoneBranchCheckout(currentBranch, integrationBranch, isolationMode, isRepo, isMilestone?: (branch: string) => boolean): string | null`
  - `_selectResumableMilestone(branchNames, mergedBranches, isComplete, commitsAhead, milestoneIdFor?: (branch: string) => string | null): string | null`

- [ ] **Step 1: Write the failing tests**

Create `src/resources/extensions/gsd/tests/milestone-branch-detection.test.ts`:

```ts
// gsd-pi — Code that recognizes milestone branches also recognizes recorded names.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { writeFileSync } from "node:fs";

import { _selectResumableMilestone, resolveIsolationNoneBranchCheckout } from "../auto-start.ts";
import {
  milestoneMetaPath,
  readIntegrationBranch,
  resolveMilestoneIntegrationBranch,
  writeIntegrationBranch,
} from "../git-service.ts";
import { milestoneIdFromDefaultBranch, writeMilestoneBranchRecord } from "../milestone-branch-registry.ts";
import { listWorktrees } from "../worktree-manager.ts";
import { git, makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

describe("milestone branch detection with recorded names", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo("gsd-ms-branch-detect-");
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");
  });

  afterEach(() => {
    removeRepo(repo);
  });

  test("writeIntegrationBranch refuses a recorded milestone branch", () => {
    writeIntegrationBranch(repo, "M002", "feat/add_auth");
    assert.equal(readIntegrationBranch(repo, "M002"), null);
    writeIntegrationBranch(repo, "M002", "main");
    assert.equal(readIntegrationBranch(repo, "M002"), "main");
  });

  test("a recorded milestone branch is never used as a merge target", () => {
    git(repo, "branch", "feat/add_auth");
    writeFileSync(milestoneMetaPath(repo, "M002"), JSON.stringify({ integrationBranch: "feat/add_auth" }));
    const resolution = resolveMilestoneIntegrationBranch(repo, "M002");
    assert.notEqual(resolution.status, "recorded");
    assert.notEqual(resolution.effectiveBranch, "feat/add_auth");
  });

  test("listWorktrees reports a recorded branch with no worktree as an orphan of its milestone", () => {
    git(repo, "branch", "feat/add_auth");
    const orphan = listWorktrees(repo).find((wt) => wt.branch === "feat/add_auth");
    assert.ok(orphan, "orphan entry for the recorded branch");
    assert.equal(orphan.name, "M001");
    assert.equal(orphan.orphan, true);
  });
});

describe("pure branch decisions accept a milestone lookup", () => {
  test("_selectResumableMilestone resolves recorded names through the lookup", () => {
    const picked = _selectResumableMilestone(
      ["feat/add_auth", "milestone/M001"],
      new Set(),
      () => true,
      () => 1,
      (branch) => (branch === "feat/add_auth" ? "M002" : milestoneIdFromDefaultBranch(branch)),
    );
    assert.equal(picked, "M002");
  });

  test("resolveIsolationNoneBranchCheckout leaves a recorded milestone branch", () => {
    const isMilestone = (branch: string) => branch === "feat/add_auth";
    assert.equal(resolveIsolationNoneBranchCheckout("feat/add_auth", "main", "none", true, isMilestone), "main");
    assert.equal(resolveIsolationNoneBranchCheckout("feat/other", "main", "none", true, isMilestone), null);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-detection.test.ts`
Expected: FAIL on all five tests (the recorded name is accepted as an integration branch, is missing from `listWorktrees`, and the pure functions ignore the extra argument).

- [ ] **Step 3: Update `git-service.ts`**

Add `import { isMilestoneBranch } from "./milestone-branch-registry.js";`.

Line 451:

```ts
  if (isMilestoneBranch(basePath, branch)) return;
```

Line 526:

```ts
  const isRecordedMilestoneBranch = isMilestoneBranch(basePath, normalizedRecordedBranch);
```

Lines 1152-1157, inside `getMainBranch`:

```ts
      // Auto-mode worktrees check out their milestone branch (wtName = milestone ID)
      const currentBranch = nativeGetCurrentBranch(this.basePath);

      if (isMilestoneBranch(this.basePath, currentBranch)) {
        return currentBranch;
      }
```

- [ ] **Step 4: Update `auto-start.ts`**

Add to the imports:

```ts
import {
  isMilestoneBranch,
  listMergedMilestoneBranches,
  listMilestoneBranches,
  milestoneIdForBranch,
  milestoneIdFromDefaultBranch,
} from "./milestone-branch-registry.js";
```

`resolveIsolationNoneBranchCheckout` (lines 140-148):

```ts
export function resolveIsolationNoneBranchCheckout(
  currentBranch: string,
  integrationBranch: string,
  isolationMode: string,
  isRepo: boolean,
  isMilestone: (branch: string) => boolean = (branch) => milestoneIdFromDefaultBranch(branch) !== null,
): string | null {
  if (!isRepo || isolationMode !== "none") return null;
  return isMilestone(currentBranch) ? integrationBranch : null;
}
```

Its caller at line 1758 passes the lookup:

```ts
        const branchToCheckout = resolveIsolationNoneBranchCheckout(
          currentBranch,
          integrationBranch,
          isolationMode,
          isRepo,
          (branch) => isMilestoneBranch(base, branch),
        );
```

In `auditOrphanedMilestoneBranches`, line 513:

```ts
    milestoneBranches = listMilestoneBranches(basePath, { branchList, branchExists });
```

Line 532:

```ts
    mergedBranches = new Set(listMergedMilestoneBranches(basePath, mainBranch));
```

Lines 548-549:

```ts
  for (const branch of milestoneBranches) {
    const milestoneId = milestoneIdForBranch(basePath, branch);
    if (!milestoneId) continue;
    const milestone = getMilestone(milestoneId);
```

Lines 741-743:

```ts
  const seenMilestoneIds = new Set(
    milestoneBranches
      .map((branch) => milestoneIdForBranch(basePath, branch))
      .filter((id): id is string => id !== null),
  );
```

`_selectResumableMilestone` (lines 866-887):

```ts
export function _selectResumableMilestone(
  branchNames: readonly string[],
  mergedBranches: ReadonlySet<string>,
  isComplete: (milestoneId: string) => boolean,
  commitsAhead: (branch: string) => number,
  milestoneIdFor: (branch: string) => string | null = milestoneIdFromDefaultBranch,
): string | null {
  const candidates: string[] = [];
  for (const branch of branchNames) {
    const milestoneId = milestoneIdFor(branch);
    if (!milestoneId) continue;
    if (mergedBranches.has(branch)) continue;
    if (!isComplete(milestoneId)) continue;
    let ahead = 0;
    try {
      ahead = commitsAhead(branch);
    } catch {
      continue;
    }
    if (ahead <= 0) continue;
    candidates.push(milestoneId);
  }
  if (candidates.length === 0) return null;
  candidates.sort();
  return candidates[candidates.length - 1];
}
```

In `findUnmergedCompletedMilestone`, line 912:

```ts
    milestoneBranches = listMilestoneBranches(basePath);
```

Lines 927-929:

```ts
    mergedBranches = new Set(listMergedMilestoneBranches(basePath, mainBranch));
```

And pass the lookup as the fifth argument of its `_selectResumableMilestone(...)` call:

```ts
    (branch) => milestoneIdForBranch(basePath, branch),
```

- [ ] **Step 5: Update the other detection sites**

`milestone-implementation-evidence.ts:60` (add `import { isMilestoneBranch } from "./milestone-branch-registry.js";`):

```ts
    if (recordedIntegrationBranch && isMilestoneBranch(basePath, recordedIntegrationBranch)) {
```

`auto-worktree-entry.ts:56` (same import):

```ts
    return isMilestoneBranch(projectRoot, branch);
```

`unit-closeout.ts`: replace the `MILESTONE_BRANCH_PREFIX` import on line 28 with `import { isMilestoneBranch } from "./milestone-branch-registry.js";`, and line 115:

```ts
      if (branch && isMilestoneBranch(request.basePath, branch)) {
```

Update the doc comment on line 43 from "closed on a `milestone/<MID>`" to "closed on the milestone's branch".

`auto-worktree-session-registry.ts:65` (same import):

```ts
  if (!isMilestoneBranch(originalBase, branch)) return null;
```

- [ ] **Step 6: Update the parse and list sites**

`doctor-git-checks.ts` (add `import { isMilestoneBranch, listMilestoneBranches, milestoneIdForBranch } from "./milestone-branch-registry.js";`):

Line 220:

```ts
    const milestoneWorktrees = worktrees.filter(wt => isMilestoneBranch(basePath, wt.branch) && !wt.orphan);
```

Lines 226-227 (delete the "milestone/M001 → M001" comment):

```ts
      const milestoneId = milestoneIdForBranch(basePath, wt.branch);
      if (!milestoneId) continue;
```

Line 342:

```ts
      const branches = listMilestoneBranches(basePath);
```

Line 350:

```ts
          const milestoneId = milestoneIdForBranch(basePath, branch);
          if (!milestoneId) continue;
```

`worktree-manager.ts` (add `import { listMilestoneBranches, milestoneIdForBranch } from "./milestone-branch-registry.js";`):

Lines 705-709:

```ts
    const branchWorktreeName = branch.startsWith("worktree/")
      ? branch.slice("worktree/".length)
      : milestoneIdForBranch(basePath, branch);
```

Lines 754-758:

```ts
  const orphanMilestoneBranches = listMilestoneBranches(basePath)
    .filter(branch => !registeredBranches.has(branch));

  for (const branch of orphanMilestoneBranches) {
    const name = milestoneIdForBranch(basePath, branch);
```

Keep the `if (!name || name.includes("/")) continue;` line that follows.

`commands-maintenance.ts:71-74` (add `import { listMilestoneBranches, milestoneIdForBranch } from "./milestone-branch-registry.js";`):

```ts
    const milestoneBranches = listMilestoneBranches(basePath);
    for (const branch of milestoneBranches) {
      if (attachedBranches.has(branch)) continue;
      const milestoneId = milestoneIdForBranch(basePath, branch);
      if (!milestoneId) continue;
```

`closeout-wizard.ts:70-79` (add `import { listMilestoneBranches, milestoneIdForBranch } from "./milestone-branch-registry.js";`):

```ts
function listMilestoneBranchIds(basePath: string): string[] {
  try {
    return listMilestoneBranches(basePath)
      .map((branch) => milestoneIdForBranch(basePath, branch))
      .filter((id): id is string => id !== null && MILESTONE_ID_RE.test(id))
      .sort();
  } catch {
    return [];
  }
}
```

- [ ] **Step 7: Confirm no prefix check remains**

Run: `grep -rn --include='*.ts' -E "startsWith\(['\"]milestone/|replace\(/\^milestone|slice\(['\"]milestone/|\"milestone/\*\"" src/resources/extensions | grep -v '\.test\.'`
Expected: no output.

- [ ] **Step 8: Run the new tests and the affected existing tests**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-detection.test.ts src/resources/extensions/gsd/tests/isolation-none-branch-guard.test.ts src/resources/extensions/gsd/tests/auto-unit-closeout.test.ts src/resources/extensions/gsd/tests/integration-branch-meta-location.test.ts src/resources/extensions/gsd/tests/merge-self-branch-guard.test.ts`
Expected: PASS.

Also run every existing test whose name contains `orphan`, `doctor-git`, `closeout-wizard`, or `resumable`:

Run: `ls src/resources/extensions/gsd/tests/*.test.ts | grep -E 'orphan|doctor-git|closeout-wizard|resumable' | xargs env GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test`
Expected: PASS.

- [ ] **Step 9: Type-check**

Run: `pnpm run typecheck:extensions`
Expected: exit 0. Remove any import the type check reports as unused (likely `nativeBranchList` or `nativeBranchListMerged` in the files above, and `MILESTONE_BRANCH_PREFIX` in `unit-closeout.ts`).

- [ ] **Step 10: Commit**

```bash
git add -A src/resources/extensions/gsd
git commit -m "feat(gsd): recognize recorded milestone branch names everywhere"
```

---

### Task 7: Clear a record when gsd deletes its branch

**Files:**
- Modify: `auto-worktree-teardown.ts` (after the removal block), `auto-worktree-merge-cleanup.ts:112-116`, `milestone-actions.ts:154-161`, `orphan-milestone-discard.ts` (success path of `discardOrphanMilestoneReservations`), `doctor-git-checks.ts:370`, `commands-maintenance.ts:82`, `auto-start.ts:644`
- Test: `src/resources/extensions/gsd/tests/milestone-branch-cleanup.test.ts`

**Interfaces:**
- Consumes: Task 1 `forgetMilestoneBranchIfDeleted`, `hasMilestoneBranchRecord`, `writeMilestoneBranchRecord`; Task 5 changes.

- [ ] **Step 1: Write the failing tests**

Create `src/resources/extensions/gsd/tests/milestone-branch-cleanup.test.ts`:

```ts
// gsd-pi — A branch record lives exactly as long as the branch gsd created.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAutoWorktree } from "../auto-worktree-creation.ts";
import { mergeMilestoneToMain } from "../auto-worktree-merge.ts";
import { teardownAutoWorktree } from "../auto-worktree-teardown.ts";
import { hasMilestoneBranchRecord, writeMilestoneBranchRecord } from "../milestone-branch-registry.ts";
import { discardMilestone } from "../milestone-actions.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { _resetServiceCache } from "../worktree.ts";
import { seedMergeReadyMilestone } from "./merge-ready-fixture.ts";
import { git, makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

describe("milestone branch record cleanup", () => {
  let savedCwd: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  const repos: string[] = [];

  beforeEach(() => {
    savedCwd = process.cwd();
    originalHome = process.env.HOME;
    fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "gsd-fake-home-")));
    process.env.HOME = fakeHome;
    _clearGsdRootCache();
    _resetServiceCache();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    process.env.HOME = originalHome;
    _clearGsdRootCache();
    _resetServiceCache();
    for (const repo of repos.splice(0)) removeRepo(repo);
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test("stopping with preserveBranch keeps the record, and a full teardown clears it", () => {
    const repo = makeRepo("gsd-ms-branch-teardown-");
    repos.push(repo);
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");

    createAutoWorktree(repo, "M001");
    teardownAutoWorktree(repo, "M001", { preserveBranch: true });
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), true);
    assert.equal(git(repo, "branch", "--list", "feat/add_auth"), "feat/add_auth");

    const resumed = createAutoWorktree(repo, "M001");
    assert.equal(git(resumed, "branch", "--show-current"), "feat/add_auth");
    teardownAutoWorktree(repo, "M001");
    assert.equal(git(repo, "branch", "--list", "feat/add_auth"), "");
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), false);
  });

  test("discarding a milestone deletes its branch and clears the record", () => {
    const repo = makeRepo("gsd-ms-branch-discard-");
    repos.push(repo);
    writeMilestoneBranchRecord(repo, "M001", "feat/add_auth");
    git(repo, "branch", "feat/add_auth");
    mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });

    assert.equal(discardMilestone(repo, "M001"), true);
    assert.equal(git(repo, "branch", "--list", "feat/add_auth"), "");
    assert.equal(hasMilestoneBranchRecord(repo, "M001"), false);
  });

  test("merging a milestone deletes its branch and clears the record", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-ms-branch-merge-")));
    repos.push(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "test");
    // Production ignores all of .gsd/; this repo tracks milestone docs like the
    // stale-worktree-cwd fixture, so only the record directory is ignored.
    appendFileSync(join(repo, ".git", "info", "exclude"), ".gsd/milestone-branches/\n");
    writeFileSync(join(repo, "README.md"), "# test\n");
    const msDir = join(repo, ".gsd", "milestones", "M050");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M050 Context\n");
    const roadmap = [
      "# M050: Test Milestone",
      "**Vision**: testing",
      "## Success Criteria",
      "- It works",
      "## Slices",
      "- [x] S01 — First slice",
    ].join("\n");
    writeFileSync(join(msDir, "ROADMAP.md"), roadmap);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    seedMergeReadyMilestone(repo, "M050");
    writeMilestoneBranchRecord(repo, "M050", "feat/test_milestone");

    const wtPath = createAutoWorktree(repo, "M050");
    assert.equal(git(wtPath, "branch", "--show-current"), "feat/test_milestone");
    writeFileSync(join(wtPath, "feature.txt"), "new feature\n");
    git(wtPath, "add", "feature.txt");
    git(wtPath, "commit", "-q", "-m", "feat: add feature");

    mergeMilestoneToMain(repo, "M050", roadmap);

    assert.ok(existsSync(join(repo, "feature.txt")), "merged content reached main");
    assert.equal(git(repo, "branch", "--list", "feat/test_milestone"), "");
    assert.equal(hasMilestoneBranchRecord(repo, "M050"), false);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-cleanup.test.ts`
Expected: FAIL. Each test finds the record still present after the branch is gone.

- [ ] **Step 3: Clear the record at each deletion site**

Add `forgetMilestoneBranchIfDeleted` to each file's import from `./milestone-branch-registry.js` (add the import where the file has none).

`auto-worktree-teardown.ts`: after the `if (!preserveWorktree) { … }` removal block and before the "Verify cleanup succeeded" comment:

```ts
    if (!preserveBranch) forgetMilestoneBranchIfDeleted(originalBasePath, milestoneId);
```

`auto-worktree-merge-cleanup.ts`, after the `deps.nativeBranchDelete(projectRoot, milestoneBranch)` try/catch:

```ts
  forgetMilestoneBranchIfDeleted(projectRoot, milestoneId);
```

`milestone-actions.ts`, inside `discardMilestone`, after the `removeWorktree` try/catch:

```ts
  forgetMilestoneBranchIfDeleted(basePath, milestoneId);
```

`orphan-milestone-discard.ts`, in `discardOrphanMilestoneReservations`, right after `invalidateAllCaches();` on the success path:

```ts
  for (const id of ids) forgetMilestoneBranchIfDeleted(projectRoot, id);
```

`doctor-git-checks.ts:370`, inside the stale-branch fix:

```ts
                nativeBranchDelete(basePath, branch, true);
                forgetMilestoneBranchIfDeleted(basePath, milestoneId);
                fixesApplied.push(`deleted stale branch ${branch}`);
```

`commands-maintenance.ts:82`:

```ts
        nativeBranchDelete(basePath, branch, true);
        forgetMilestoneBranchIfDeleted(basePath, milestoneId);
        deletedStaleMilestones++;
```

`auto-start.ts:644`, in the merged-branch cleanup:

```ts
        nativeBranchDelete(basePath, branch, true);
        forgetMilestoneBranchIfDeleted(basePath, milestoneId);
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-cleanup.test.ts src/resources/extensions/gsd/tests/auto-worktree-merge-cleanup.test.ts src/resources/extensions/gsd/tests/teardown-failure-clears-registry.test.ts src/resources/extensions/gsd/tests/teardown-chdir-failure-clears-registry.test.ts`
Expected: PASS.

If the merge test fails before the record assertion, compare its setup with `stale-worktree-cwd.test.ts`, which runs the same flow with a default branch name, and match that setup.

- [ ] **Step 5: Type-check**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A src/resources/extensions/gsd
git commit -m "feat(gsd): clear a milestone branch record when gsd deletes the branch"
```

---

### Task 8: The `gsd_milestone_set_branch` workflow tool

**Files:**
- Modify: `packages/contracts/src/workflow.ts` (after the `gsd_milestone_generate_id` entry, line 49)
- Modify: `src/resources/extensions/gsd/bootstrap/db-tools.ts` (after `registerWorkflowTool(pi, milestoneGenerateIdTool);`, line 938)
- Modify: `src/resources/extensions/gsd/unit-registry.ts` (`discuss-milestone` → `allowedGsdTools`, about line 161)
- Modify: `src/resources/extensions/gsd/constants.ts` (`DISCUSS_TOOLS_ALLOWLIST` and its doc comment)
- Modify: `src/resources/extensions/gsd/bootstrap/write-gate.ts` (`QUEUE_SAFE_TOOLS`)
- Modify: `packages/mcp-server/src/workflow-tools.ts` (params near line 2535, tool after the `gsd_generate_milestone_id` alias, about line 3200)
- Test: `src/resources/extensions/gsd/tests/milestone-set-branch-tool.test.ts`, `src/resources/extensions/gsd/tests/token-tool-gating.test.ts`, `src/resources/extensions/gsd/tests/discuss-tool-scoping.test.ts`, `packages/mcp-server/src/workflow-tools.test.ts`

**Interfaces:**
- Consumes: Task 2 `setMilestoneBranch`.
- Produces: workflow tool `gsd_milestone_set_branch` with parameters `{ milestoneId: string; branch: string }`. On rejection the native tool returns `isError: true` with text `Branch name rejected: <reason> Ask the user for another name.`, and the MCP tool throws an `Error` with the same text.

- [ ] **Step 1: Write the failing tests**

Create `src/resources/extensions/gsd/tests/milestone-set-branch-tool.test.ts`:

```ts
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
```

In `src/resources/extensions/gsd/tests/token-tool-gating.test.ts`, in the test "discuss-milestone dispatch keeps required headless milestone tools after two-stage scoping", add `"gsd_milestone_set_branch",` to the `activeTools` array after `"gsd_milestone_generate_id",`, and add after the matching assertion:

```ts
  assert.ok(activeTools.includes("gsd_milestone_set_branch"));
```

In `src/resources/extensions/gsd/tests/discuss-tool-scoping.test.ts`, add to `DISCUSS_REQUIRED_TOOLS`:

```ts
  "gsd_milestone_set_branch",  // discuss.md, guided-discuss-milestone.md, queue.md branch question
```

In `packages/mcp-server/src/workflow-tools.test.ts`, after the test "gsd_milestone_generate_id skips DB-only queued milestone rows":

```ts
  it("gsd_milestone_set_branch records the branch and rejects a taken name", async () => {
    const base = makeTmpBase();
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: base });
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: base });
      execFileSync("git", ["branch", "feat/taken"], { cwd: base });
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_milestone_set_branch");
      assert.ok(tool, "set-branch tool should be registered");

      const ok = await tool!.handler({ projectDir: base, milestoneId: "M001", branch: "feat/add_auth" });
      assert.match((ok as any).content[0].text, /Recorded branch feat\/add_auth for M001/);
      assert.ok(existsSync(join(base, ".gsd", "milestone-branches", "M001.json")));

      await assert.rejects(
        tool!.handler({ projectDir: base, milestoneId: "M002", branch: "feat/taken" }),
        /Branch name rejected: .*already exists/,
      );
    } finally {
      cleanup(base);
    }
  });
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-set-branch-tool.test.ts src/resources/extensions/gsd/tests/token-tool-gating.test.ts src/resources/extensions/gsd/tests/discuss-tool-scoping.test.ts`
Expected: FAIL with "gsd_milestone_set_branch is registered" and the allowlist assertions.

- [ ] **Step 3: Add the contract**

In `packages/contracts/src/workflow.ts`, after the `gsd_milestone_generate_id` entry:

```ts
	{
		canonicalName: "gsd_milestone_set_branch",
		aliases: [],
		schemaId: "workflow.milestone.set_branch",
		executorId: "executeMilestoneSetBranch",
		writePolicy: "write",
		auditEvent: "workflow.milestone.set_branch",
	},
```

Run: `pnpm run build:contracts`
Expected: exit 0. The extension type check reads the contract types from `packages/contracts/dist`.

- [ ] **Step 4: Register the native tool**

In `bootstrap/db-tools.ts`, after `registerWorkflowTool(pi, milestoneGenerateIdTool);`:

```ts
	// ─── gsd_milestone_set_branch ──────────────────────────────────────────

	const milestoneSetBranchExecute = async (
		_toolCallId: string,
		params: { milestoneId: string; branch: string },
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const operation = "set_milestone_branch";
		try {
			const basePath = resolveCtxCwd(_ctx);
			const { setMilestoneBranch } = await import("../milestone-branch-choice.js");
			const result = setMilestoneBranch(basePath, params.milestoneId, params.branch);
			if (!result.ok) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Branch name rejected: ${result.reason} Ask the user for another name.`,
						},
					],
					details: { operation, milestoneId: params.milestoneId, error: result.reason } as any,
					isError: true,
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Recorded branch ${result.branch} for ${params.milestoneId}.`,
					},
				],
				details: { operation, milestoneId: params.milestoneId, branch: result.branch } as any,
			};
		} catch (err) {
			const msg = getErrorMessage(err);
			return {
				content: [{ type: "text" as const, text: `Error recording milestone branch: ${msg}` }],
				details: { operation, error: msg } as any,
				isError: true,
			};
		}
	};

	const milestoneSetBranchTool = {
		name: "gsd_milestone_set_branch",
		label: "Set Milestone Branch",
		description:
			"Record the git branch name the user chose for a milestone. gsd creates the milestone's working branch under this name. " +
			"Returns an error with the reason when the name is not allowed.",
		promptSnippet: "Record the user's chosen git branch name for a milestone",
		promptGuidelines: [
			"Call gsd_milestone_set_branch only with a name the user chose or accepted in this conversation.",
			"Call gsd_milestone_set_branch after the milestone ID exists and before saving the milestone CONTEXT.",
			"If gsd_milestone_set_branch returns an error, show the reason to the user and ask for another name.",
		],
		parameters: Type.Object({
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			branch: Type.String({ description: "Git branch name the user chose, e.g. feat/add_auth" }),
		}),
		execute: milestoneSetBranchExecute,
		renderCall(args: any, theme: any) {
			return new Text(
				theme.fg("toolTitle", theme.bold(`milestone_set_branch ${args?.milestoneId ?? ""}`)),
				0,
				0,
			);
		},
		renderResult(result: any, _options: any, theme: any) {
			const d = readDetails(result);
			if (result.isError || d?.error) {
				return new Text(theme.fg("error", formatToolErrorText(result, d)), 0, 0);
			}
			return new Text(theme.fg("success", `Branch ${d?.branch ?? ""}`), 0, 0);
		},
	};

	registerWorkflowTool(pi, milestoneSetBranchTool);
```

- [ ] **Step 5: Allow the tool in discuss and queue flows**

`unit-registry.ts`, `discuss-milestone` → `toolContract.allowedGsdTools`: add `"gsd_milestone_set_branch",` after `"gsd_milestone_generate_id",`. Do not add it to `requiredWorkflowTools`.

`constants.ts`: add to `DISCUSS_TOOLS_ALLOWLIST` after `"gsd_milestone_generate_id",`:

```ts
  // Milestone branch name chosen by the user
  "gsd_milestone_set_branch",
```

and add to the doc comment's list:

```ts
 *   - gsd_milestone_set_branch: records the milestone branch name (discuss and queue prompts)
```

`bootstrap/write-gate.ts`, `QUEUE_SAFE_TOOLS`: add `"gsd_milestone_set_branch",` after `"gsd_milestone_generate_id",`.

- [ ] **Step 6: Register the MCP tool**

In `packages/mcp-server/src/workflow-tools.ts`, after `milestoneGenerateIdSchema`:

```ts
const milestoneSetBranchParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  branch: nonEmptyString("branch").describe("Git branch name the user chose, e.g. feat/add_auth"),
};
const milestoneSetBranchSchema = z.object(milestoneSetBranchParams);
```

After the `gsd_generate_milestone_id` alias registration:

```ts
  server.tool(
    "gsd_milestone_set_branch",
    "Record the git branch name the user chose for a milestone. Returns an error with the reason when the name is not allowed.",
    milestoneSetBranchParams,
    async (args: Record<string, unknown>) => {
      const { projectDir, milestoneId, branch } = parseWorkflowArgs(milestoneSetBranchSchema, args);
      await enforceWorkflowWriteGate("gsd_milestone_set_branch", projectDir, milestoneId);
      const { setMilestoneBranch } = await importWorkflowRuntimeModule<{
        setMilestoneBranch: (
          basePath: string,
          milestoneId: string,
          branch: string,
        ) => { ok: true; branch: string } | { ok: false; reason: string };
      }>("../../../src/resources/extensions/gsd/milestone-branch-choice.js");
      const result = setMilestoneBranch(projectDir, milestoneId, branch);
      if (!result.ok) {
        throw new Error(`Branch name rejected: ${result.reason} Ask the user for another name.`);
      }
      return { content: [{ type: "text" as const, text: `Recorded branch ${result.branch} for ${milestoneId}.` }] };
    },
  );
```

- [ ] **Step 7: Run the tests to make sure they pass**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-set-branch-tool.test.ts src/resources/extensions/gsd/tests/token-tool-gating.test.ts src/resources/extensions/gsd/tests/discuss-tool-scoping.test.ts src/resources/extensions/gsd/tests/tool-naming.test.ts src/resources/extensions/gsd/tests/workflow-phase-contract-matrix.test.ts src/resources/extensions/gsd/tests/claude-tool-schema-golden.test.ts`
Expected: PASS.

Run the MCP test through the package gate, which is the only runner that includes `workflow-tools.test.ts`:

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config pnpm run test:packages 2>&1 | tail -40`
Expected: the new MCP test and "registers the full headless-safe workflow tool surface" pass. The 5 failures listed below existed before this change and do not count against it: 2 in `workflow-tools-parity.test.js` and 3 in `workflow-tools.test.js`, all "artifact file must exist" assertions on `.gsd/**` summary files. Compare failure names, not counts.

- [ ] **Step 8: Type-check**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/workflow.ts packages/mcp-server/src/workflow-tools.ts packages/mcp-server/src/workflow-tools.test.ts src/resources/extensions/gsd/bootstrap/db-tools.ts src/resources/extensions/gsd/bootstrap/write-gate.ts src/resources/extensions/gsd/unit-registry.ts src/resources/extensions/gsd/constants.ts src/resources/extensions/gsd/tests/milestone-set-branch-tool.test.ts src/resources/extensions/gsd/tests/token-tool-gating.test.ts src/resources/extensions/gsd/tests/discuss-tool-scoping.test.ts
git commit -m "feat(gsd): add the gsd_milestone_set_branch workflow tool"
```

---

### Task 9: Ask for the branch name during milestone discussion

**Files:**
- Modify: `prompts/discuss.md` (after the "Depth Verification" section, after line 172)
- Modify: `prompts/guided-discuss-milestone.md` (after the "CRITICAL — Non-bypassable gate" paragraph, before `---`, about line 108)
- Modify: `prompts/queue.md` (after the "CRITICAL — Non-bypassable gate" line at the end of "Step 2", before `## Output Phase`, about line 100)
- Modify: `guided-flow.ts:906-916`, `guided-flow-queue.ts:218-223`, `auto-prompts.ts:1808-1816`
- Modify tests: `tests/guided-discuss-milestone-prompt-rendering.test.ts`, `tests/prompt-loader.test.ts`, `tests/queue-prompt-rendering.test.ts`
- Test: `src/resources/extensions/gsd/tests/milestone-branch-prompt-rendering.test.ts`

**Interfaces:**
- Consumes: Task 4 `renderMilestoneBranchQuestion(basePath)`; Task 8 tool name.
- Produces: templates `discuss`, `guided-discuss-milestone`, and `queue` declare `{{milestoneBranchQuestion}}`.

- [ ] **Step 1: Write the failing tests**

Create `src/resources/extensions/gsd/tests/milestone-branch-prompt-rendering.test.ts`:

```ts
// gsd-pi — The three milestone-discussion prompts carry the branch question.

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPrompt } from "../prompt-loader.ts";

const SENTINEL = "## Milestone Branch Name\nBRANCH-QUESTION-SENTINEL";

const cases: Array<[string, Record<string, string>]> = [
  [
    "discuss",
    {
      milestoneId: "M001",
      preamble: "Preamble.",
      preparationContext: "",
      structuredQuestionsAvailable: "true",
      contextPath: ".gsd/milestones/M001/M001-CONTEXT.md",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedTemplates: "## Templates",
      commitInstruction: "Do not commit.",
      multiMilestoneCommitInstruction: "Do not commit.",
    },
  ],
  [
    "guided-discuss-milestone",
    {
      workingDirectory: process.cwd(),
      milestoneId: "M001",
      milestoneTitle: "Auth",
      structuredQuestionsAvailable: "true",
      fastPathInstruction: "No fast path.",
      inlinedTemplates: "## Context",
      commitInstruction: "Do not commit.",
    },
  ],
  [
    "queue",
    {
      preamble: "Queue preamble.",
      existingMilestonesContext: "No existing milestones.",
      inlinedTemplates: "## Context Template",
      commitInstruction: "Do not commit.",
    },
  ],
];

for (const [name, vars] of cases) {
  test(`${name} renders the branch question block`, () => {
    const prompt = loadPrompt(name, { ...vars, milestoneBranchQuestion: SENTINEL });
    assert.ok(prompt.includes("BRANCH-QUESTION-SENTINEL"), `${name} includes {{milestoneBranchQuestion}}`);
    assert.doesNotMatch(prompt, /\{\{milestoneBranchQuestion\}\}/);
  });

  test(`${name} renders cleanly when the branch question is empty`, () => {
    const prompt = loadPrompt(name, { ...vars, milestoneBranchQuestion: "" });
    assert.doesNotMatch(prompt, /Milestone Branch Name/);
  });
}
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-prompt-rendering.test.ts`
Expected: FAIL on the three "renders the branch question block" tests. If a template reports another missing variable, add that variable to its `cases` entry with a short placeholder value and re-run.

- [ ] **Step 3: Add the placeholder to the templates**

`prompts/discuss.md`: after the paragraph that ends "unless there is still material ambiguity." in the "Depth Verification" section, add a blank line and then:

```markdown
{{milestoneBranchQuestion}}
```

`prompts/guided-discuss-milestone.md`: after the paragraph that starts "**CRITICAL — Non-bypassable gate:** The system blocks CONTEXT.md writes" and before the `---` line, add a blank line and `{{milestoneBranchQuestion}}`.

`prompts/queue.md`: after the line "**CRITICAL — Non-bypassable gate:** CONTEXT.md writes are blocked until the user selects \"(Recommended)\". If they decline, cancel, or the tool fails, re-ask." and before `## Output Phase`, add a blank line and `{{milestoneBranchQuestion}}`.

- [ ] **Step 4: Pass the variable from the builders**

Each builder imports `renderMilestoneBranchQuestion` from `./milestone-branch-choice.js`.

`guided-flow.ts`, in `buildDiscussPrompt`'s `loadPrompt("discuss", { … })` object:

```ts
    milestoneBranchQuestion: renderMilestoneBranchQuestion(basePath),
```

`guided-flow-queue.ts`, in `loadPrompt("queue", { … })`:

```ts
    milestoneBranchQuestion: renderMilestoneBranchQuestion(basePath),
```

`auto-prompts.ts`, in `loadPrompt("guided-discuss-milestone", { … })`:

```ts
    milestoneBranchQuestion: renderMilestoneBranchQuestion(base),
```

- [ ] **Step 5: Give the existing direct-render tests the new variable**

Add `milestoneBranchQuestion: "",` to the `loadPrompt(…)` variable object in:

- `tests/guided-discuss-milestone-prompt-rendering.test.ts` (the `loadPrompt("guided-discuss-milestone", …)` call)
- `tests/prompt-loader.test.ts` (the call that omits only `workingDirectory`, so the error still names only `{{workingDirectory}}`)
- `tests/queue-prompt-rendering.test.ts` (the `loadPrompt("queue", …)` call)

- [ ] **Step 6: Run the tests to make sure they pass**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-prompt-rendering.test.ts src/resources/extensions/gsd/tests/guided-discuss-milestone-prompt-rendering.test.ts src/resources/extensions/gsd/tests/prompt-loader.test.ts src/resources/extensions/gsd/tests/queue-prompt-rendering.test.ts src/resources/extensions/gsd/tests/discuss-prompt.test.ts src/resources/extensions/gsd/tests/prompt-contracts.test.ts src/resources/extensions/gsd/tests/guided-flow.test.ts src/resources/extensions/gsd/tests/new-milestone-discuss-routing.test.ts src/resources/extensions/gsd/tests/queued-discuss-fast-path.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/resources/extensions/gsd/prompts/discuss.md src/resources/extensions/gsd/prompts/guided-discuss-milestone.md src/resources/extensions/gsd/prompts/queue.md src/resources/extensions/gsd/guided-flow.ts src/resources/extensions/gsd/guided-flow-queue.ts src/resources/extensions/gsd/auto-prompts.ts src/resources/extensions/gsd/tests/milestone-branch-prompt-rendering.test.ts src/resources/extensions/gsd/tests/guided-discuss-milestone-prompt-rendering.test.ts src/resources/extensions/gsd/tests/prompt-loader.test.ts src/resources/extensions/gsd/tests/queue-prompt-rendering.test.ts
git commit -m "feat(gsd): ask for the milestone branch name during milestone discussion"
```

---

### Task 10: TUI backstop before milestone entry

**Files:**
- Modify: `src/resources/extensions/gsd/auto-start.ts` ("Capture integration branch" block, lines 1741-1747)
- Modify: `src/resources/extensions/gsd/auto/pre-dispatch.ts` (milestone transition, lines 442-446)
- Modify: `docs/user-docs/git-strategy.md` (new "Branch names" section after the isolation-mode table)
- Test: `src/resources/extensions/gsd/tests/milestone-branch-transition-prompt.test.ts`

**Interfaces:**
- Consumes: Task 4 `ensureMilestoneBranchName`; Task 1 `autoWorktreeBranch`, `hasMilestoneBranchRecord`.

- [ ] **Step 1: Write the failing tests**

Create `src/resources/extensions/gsd/tests/milestone-branch-transition-prompt.test.ts`:

```ts
// gsd-pi — Auto-mode asks for the next milestone's branch name before entering it.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { AutoSession } from "../auto/session.ts";
import { runPreDispatch } from "../auto/pre-dispatch.ts";
import { autoWorktreeBranch, hasMilestoneBranchRecord } from "../milestone-branch-registry.ts";
import { makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

async function transitionToM002(repo: string, isolation: "none" | "branch", calls: string[]) {
  const s = new AutoSession();
  s.basePath = repo;
  s.originalBasePath = repo;
  s.currentMilestoneId = "M001";

  const state = {
    phase: "planning",
    activeMilestone: { id: "M002", title: "Billing" },
    activeSlice: null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "Plan M002",
    registry: [
      { id: "M001", title: "Done", status: "complete" },
      { id: "M002", title: "Billing", status: "active" },
    ],
  };

  return runPreDispatch({
    ctx: {
      hasUI: true,
      ui: {
        notify() {},
        input: async (title: string) => {
          calls.push(`prompt:${title}`);
          return "feat/billing";
        },
      },
    },
    pi: {},
    s,
    prefs: undefined,
    iteration: 1,
    flowId: "test-flow",
    nextSeq: () => 1,
    deps: {
      checkResourcesStale: () => null,
      invalidateAllCaches: () => {},
      preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
      syncProjectRootToWorktree: () => {},
      deriveState: async () => state,
      preflightCleanRoot: () => ({ ok: true, stashPushed: false }),
      postflightPopStash: () => ({ ok: true, needsManualRecovery: false }),
      resolver: { mergeAndExit: () => {} },
      lifecycle: {
        enterMilestone: (mid: string) => {
          calls.push(`enter:${mid}`);
          return { ok: true, mode: "branch", path: repo };
        },
        exitMilestone: (_mid: string, opts: { merge: boolean }) => ({ ok: true, merged: opts.merge, codeFilesChanged: false }),
      },
      sendDesktopNotification: () => {},
      getIsolationMode: () => isolation,
      captureIntegrationBranch: () => {},
      pruneQueueOrder: () => {},
      rebuildState: async () => {},
      setActiveMilestoneId: () => {},
      reconcileMergeState: () => "clean",
      emitJournalEvent: () => {},
      stopAuto: async () => {},
      pauseAuto: async () => {},
      closeoutUnit: async () => {},
      buildSnapshotOpts: () => ({}),
    },
  } as any, {
    consecutiveFinalizeTimeouts: 0,
  });
}

describe("milestone transition branch prompt", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo("gsd-ms-branch-transition-");
  });

  afterEach(() => {
    removeRepo(repo);
  });

  test("asks for the next milestone's branch name before entering it", async () => {
    const calls: string[] = [];
    await transitionToM002(repo, "branch", calls);
    assert.equal(autoWorktreeBranch(repo, "M002"), "feat/billing");
    const promptIndex = calls.findIndex((call) => call.startsWith("prompt:Branch name for M002 (Billing)"));
    assert.notEqual(promptIndex, -1, `prompt shown, calls: ${calls.join(" > ")}`);
    assert.ok(promptIndex < calls.indexOf("enter:M002"), `prompt before entry, calls: ${calls.join(" > ")}`);
  });

  test("does not ask when git isolation is none", async () => {
    const calls: string[] = [];
    await transitionToM002(repo, "none", calls);
    assert.equal(calls.some((call) => call.startsWith("prompt:")), false);
    assert.equal(hasMilestoneBranchRecord(repo, "M002"), false);
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-transition-prompt.test.ts`
Expected: the first test FAILS with "prompt shown". The second test passes already.

If either test fails with `ctx.ui.<method> is not a function`, pre-dispatch calls a UI method the fake lacks because `hasUI` is true. Add a no-op `<method>() {}` to the fake `ui` object and run again.

- [ ] **Step 3: Prompt during the milestone transition**

In `auto/pre-dispatch.ts`, add `import { ensureMilestoneBranchName } from "../milestone-branch-choice.js";` and change lines 442-444:

```ts
    if (mid) {
      if (deps.getIsolationMode(s.basePath) !== "none") {
        deps.captureIntegrationBranch(s.basePath, mid);
        await ensureMilestoneBranchName(ctx, s.canonicalProjectRoot, mid, midTitle);
      }
      const enterResult = deps.lifecycle.enterMilestone(mid, ctx.ui);
```

- [ ] **Step 4: Prompt when auto-mode starts**

In `auto-start.ts`, add `import { ensureMilestoneBranchName } from "./milestone-branch-choice.js";` and change the "Capture integration branch" block (lines 1741-1747):

```ts
    if (s.currentMilestoneId) {
      if (getIsolationMode(base) !== "none" || strandedRecoveryAction) {
        captureIntegrationBranch(base, s.currentMilestoneId);
      }
      if (getIsolationMode(base) !== "none" && !strandedRecoveryAction) {
        const milestoneTitle = state.registry.find((m) => m.id === s.currentMilestoneId)?.title;
        await ensureMilestoneBranchName(ctx, base, s.currentMilestoneId, milestoneTitle);
      }
      setActiveMilestoneId(base, s.currentMilestoneId);
```

Stranded recovery is skipped because it adopts a branch that already exists, so its name is already fixed.

- [ ] **Step 5: Document branch names**

In `docs/user-docs/git-strategy.md`, after the isolation-mode table (after line 13), add:

```markdown
### Branch names

When `isolation` is `worktree` or `branch`, gsd asks what to call each milestone's branch. It asks during milestone discussion, and again before auto-mode enters a milestone that has no name yet. If you set `git.milestone_branch_format`, gsd suggests a name that follows it. The default is `milestone/<MID>`.

gsd stores the name in `.gsd/milestone-branches/<MID>.json`. The name is fixed once the branch exists. Headless runs never ask and use `milestone/<MID>`.
```

In the same file, change the two table cells that read `` `milestone/<MID>` `` (lines 12-13) to `` `milestone/<MID>` or your chosen name ``.

- [ ] **Step 6: Run the tests to make sure they pass**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-branch-transition-prompt.test.ts src/resources/extensions/gsd/tests/milestone-transition-state-rebuild.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/resources/extensions/gsd/auto-start.ts src/resources/extensions/gsd/auto/pre-dispatch.ts docs/user-docs/git-strategy.md src/resources/extensions/gsd/tests/milestone-branch-transition-prompt.test.ts
git commit -m "feat(gsd): ask for a milestone branch name before auto-mode enters the milestone"
```

---

### Task 11: Full verification

**Files:** none changed unless a gate fails.

- [ ] **Step 1: Build**

Run: `pnpm run build:core`
Expected: exit 0.

- [ ] **Step 2: Type-check the extensions**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

- [ ] **Step 3: Run the unit suite**

`pnpm run test:unit` gets OOM-killed at default concurrency in this repo, and pnpm appends extra flags only to its last sub-script. Run the two parts by hand:

```bash
pnpm run test:compile
```

```bash
GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config node scripts/with-test-concurrency.mjs --test-concurrency=8 --import ./scripts/dist-test-resolve.mjs --experimental-test-isolation=process --test-reporter=./scripts/test-reporter-compact.mjs --test "dist-test/src/tests/*.test.js" "dist-test/src/resources/extensions/gsd/tests/*.test.js" "dist-test/src/resources/extensions/gsd/tests/*.test.mjs" "dist-test/src/resources/extensions/shared/tests/*.test.js" "dist-test/src/resources/extensions/github-sync/tests/*.test.js"
```

Expected: 0 failed. About 23 failures named `handle.setMutationBoundaryFaultForTest is not a function` mean the native addon needs `node native/scripts/build.js --dev --test-fault-injection`, not a code fix. If only `workflow authority baseline` tests fail, re-run that single file standalone before treating it as a regression.

- [ ] **Step 4: Run the package suite**

Run: `GIT_CONFIG_GLOBAL=/tmp/gsd-test-git/config pnpm run test:packages`
Expected: only the 5 known `@opengsd/mcp-server` failures ("artifact file must exist" in `workflow-tools-parity.test.js` and `workflow-tools.test.js`). Compare failure names, not counts.

- [ ] **Step 5: Run the fast CI gates**

Run: `pnpm run verify:fast`
Expected: exit 0.

- [ ] **Step 6: Run the dead-code gate**

```bash
mv dist-test /tmp/gsd-dist-test-parked
NODE_OPTIONS=--max-old-space-size=8192 pnpm run lint:dead-code
mv /tmp/gsd-dist-test-parked dist-test
```

Expected: exit 0. A finding under `dist/` or `dist-test/` is stale build output, not a real finding. An unused new export is a real finding: remove the export or its `export` keyword.

- [ ] **Step 7: Commit any gate fixes**

If Steps 1-6 required changes:

```bash
git add -A src packages docs
git commit -m "fix(gsd): address verification findings for milestone branch names"
```
