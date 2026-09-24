# Custom milestone branch names

Date: 2026-09-24

## Problem

gsd names every milestone working branch `milestone/<MID>`. Teams push these
branches (`git.push_branches`, on by default in team mode) and open PRs from
them (`git.auto_pr`). A team with a branch naming convention, for example
`feat/add_auth`, cannot make gsd follow it.

The name is not only a label. About 45 non-test sites build it, detect it,
parse the milestone ID out of it, or list branches by its prefix:

| Use | Sites | Example |
|---|---|---|
| Build the name | 18 | `autoWorktreeBranch(mid)`, `` `milestone/${mid}` `` |
| Detect a milestone branch | 8 | `branch.startsWith("milestone/")` |
| Parse the ID from the name | 9 | `branch.replace(/^milestone\//, "")` |
| List milestone branches | 8 | `nativeBranchList(basePath, "milestone/*")` |
| User messages | 4 | `` `Switched to branch milestone/${milestoneId}.` `` |

A custom name therefore needs a stored record per milestone and one resolver
that every site uses.

## Goals

- gsd asks the user for the branch name of each milestone and suggests a name
  that follows the team convention.
- The local branch, the pushed branch, and the PR all use the chosen name.
- Existing projects keep working with no migration.

## Non-goals

- Renaming a milestone branch that already exists.
- Slice branch names in `github-sync` (`milestone/<MID>/<SID>`).
- A preferences wizard page for the new preference.
- Doing milestone work on a branch that already exists.

## Design

### Storage

Each milestone that has a recorded name gets one file:
`.gsd/milestone-branches/<MID>.json`, with the content `{ "branch": "<name>" }`.

The directory sits at the project root, in the same place as
`.gsd/<MID>-META.json`. A call with a worktree path and a call with the project
root read the same directory.

The record is durable. `<MID>-META.json` is not a candidate, because
`clearProjectRootStateFiles` deletes it on every teardown. That includes
`exitMilestone` with `preserveBranch: true`, which runs when the user stops
auto-mode during a milestone. A name stored there would be lost on stop and
resume, and gsd would then create a second branch.

One file per milestone, not one shared file, because the parallel orchestrator
runs several milestones at once. Each milestone writes and removes only its own
file, so no two writers touch the same file.

Writes go to a temporary file first and then use a rename, so a crash cannot
leave a partial record.

A recorded value means that someone already asked the user. If the user accepts
the default, gsd records `milestone/<MID>`, and nothing asks a second time.

### Resolver module

A new leaf module, `src/resources/extensions/gsd/milestone-branch-registry.ts`,
owns the record and the naming rules. It depends only on the file system, the
`.gsd` path helpers, and `native-git-bridge.ts`. It must not import
`auto-worktree*.ts`, so `slice-cadence.ts` can use it without a cyclic import.

```ts
export function autoWorktreeBranch(basePath: string, milestoneId: string): string;
export function milestoneIdForBranch(basePath: string, branch: string): string | null;
export function listMilestoneBranches(basePath: string): string[];
export function hasMilestoneBranchRecord(basePath: string, milestoneId: string): boolean;
export function setMilestoneBranch(
  basePath: string,
  milestoneId: string,
  branch: string,
): { ok: true } | { ok: false; reason: string };
export function removeMilestoneBranchRecord(basePath: string, milestoneId: string): void;
```

`autoWorktreeBranch` returns the recorded name, or `milestone/<MID>` when there
is no record. It moves out of `auto-worktree-branch-lifecycle.ts`, which
re-exports it for existing importers. The duplicate `milestoneBranchName` in
`slice-cadence.ts` goes away.

`milestoneIdForBranch` returns an ID in two cases. The branch is
`milestone/<MID>` and `<MID>` matches `MILESTONE_ID_RE`. Or the branch equals a
recorded name. In all other cases it returns `null`.

`listMilestoneBranches` returns the branches that match `milestone/*`, plus
each recorded name that exists as a local branch.

### Validation

`setMilestoneBranch` rejects a name in these cases, and the reason names the
rule:

1. A branch already exists for the milestone, under the recorded name or under
   `milestone/<MID>`. The name is fixed after the branch exists.
2. `git check-ref-format --branch <name>` fails, or the name fails
   `VALID_BRANCH_NAME`.
3. The name is an existing local branch.
4. Another milestone has a record with the same name.
5. The name equals the recorded integration branch of the milestone.
6. The name starts with `milestone/` but is not exactly `milestone/<MID>`. The
   default-pattern parser would read a wrong ID from it.
7. The name matches `SLICE_BRANCH_RE`, `QUICK_BRANCH_RE`, or
   `WORKFLOW_BRANCH_RE`.

### Record lifecycle

Two places write a record: the `gsd_milestone_set_branch` tool and
`ensureMilestoneBranchName`. Both call `setMilestoneBranch`.

Three places remove a record, and each one does so only on the path that
deletes the branch:

- `teardownAutoWorktree` without `preserveBranch`, after a successful merge.
- `discardMilestone` in `milestone-actions.ts`.
- `orphan-milestone-discard.ts`, when it deletes the branch.

`clearProjectRootStateFiles` never removes a record. Teardown and merge cleanup
resolve the name before any cleanup runs.

A completed milestone has no record, so it falls back to `milestone/<MID>`.
That is the same behavior as today, because its branch no longer exists.

### Call-site migration

| Use | Replacement | Files |
|---|---|---|
| Build | `autoWorktreeBranch(basePath, mid)` | `auto-worktree-creation.ts`, `auto-worktree-teardown.ts`, `auto-worktree-merge.ts`, `auto-worktree-branch-lifecycle.ts`, `worktree-lifecycle.ts`, `slice-cadence.ts`, `unmerged-milestone-guard.ts`, `parallel-orchestrator.ts`, `auto/orchestrator.ts`, `auto/worktree-safety-phase.ts`, `auto/loop-deps.ts`, `auto.ts`, `clean-root-preflight.ts`, `auto-start.ts` (792, 1487), `orphan-milestone-discard.ts`, `milestone-actions.ts`, `doctor-git-checks.ts` (545), `github-sync/sync.ts` (399) |
| Detect | `milestoneIdForBranch(basePath, branch) !== null` | `git-service.ts` (451, 526, 1155), `auto-start.ts` (147), `milestone-implementation-evidence.ts`, `auto-worktree-entry.ts`, `unit-closeout.ts`, `doctor-git-checks.ts` (220) |
| Parse | `milestoneIdForBranch(basePath, branch)` | `doctor-git-checks.ts` (227, 350), `worktree-manager.ts` (707, 758), `auto-start.ts` (549, 742, 874), `commands-maintenance.ts`, `closeout-wizard.ts`, `auto-worktree-session-registry.ts`, `src/worktree-status-banner.ts` |
| List | `listMilestoneBranches(basePath)` | `closeout-wizard.ts`, `doctor-git-checks.ts` (342), `worktree-manager.ts` (754), `commands-maintenance.ts`, `auto-start.ts` (513, 532, 912, 928) |
| Message | the resolved name | `guidance.ts` (181), `worktree-lifecycle.ts` (797, 881, 1989) |

For `nativeBranchListMerged(basePath, main, "milestone/*")`, the replacement
filters the merged list by `milestoneIdForBranch` and adds merged recorded
names.

Where a site has no `basePath` today, the caller passes it in. The
`autoWorktreeBranch` test override in `WorktreeLifecycleDeps` changes to the
new two-argument shape.

Two sites stay the same. The idempotency key in
`lifecycle-shadow-repair-domain-operation.ts` is a key, not a branch. The
`github-sync` slice branch default is outside this change.
`MILESTONE_BRANCH_PREFIX` stays, and only the resolver module uses it.

### Preference

A new optional preference, `git.milestone_branch_format`, holds a free-text
hint, for example `"<change-type>/<short_snake_case_summary>"`.

- `GitPreferences` in `git-service.ts` gets the field.
- `preferences-validation.ts` accepts a non-empty string and reports an error
  for any other value.
- `config-overlay.ts` shows it in the git rows.
- The discuss prompts receive it as `{{milestoneBranchFormat}}`. When it is
  not set, the value is empty.

### Tool: `gsd_milestone_set_branch`

Parameters: `{ milestoneId: string, branch: string }`. The tool calls
`setMilestoneBranch`. On rejection it returns the reason as an error result,
so the agent can ask the user again.

- Registered in `bootstrap/db-tools.ts`, next to `gsd_milestone_generate_id`.
- Added to `DISCUSS_TOOLS_ALLOWLIST` in `constants.ts`.
- Added to `QUEUE_SAFE_TOOLS` in `bootstrap/write-gate.ts`.
- Mirrored in `packages/mcp-server/src/workflow-tools.ts` for parity.

This is a separate tool and not a new field on `gsd_plan_milestone`, for two
reasons. The autonomous plan-milestone unit calls `gsd_plan_milestone` with no
person present. And milestones marked "draft" or "queue" in a multi-milestone
discussion get no plan call.

### Asking during discussion

Three prompts get the branch question: `discuss.md` (the single milestone, and
the primary milestone of a multi-milestone plan), `guided-discuss-milestone.md`,
and `queue.md` (each milestone).

The question goes into the same `ask_user_questions` call as the depth
verification question, with a question ID that contains `milestone_branch` and
the milestone ID. The options are:

1. A name that follows `{{milestoneBranchFormat}}`, derived from the milestone
   title, marked "(Recommended)". This option is present only when the hint is
   set.
2. `milestone/<MID>`. It is marked "(Recommended)" when there is no hint.
3. "Other — let me type it".

When `{{structuredQuestionsAvailable}}` is `false`, the agent asks in plain
text. The agent calls `gsd_milestone_set_branch` with the answer before it
writes the context. If the tool rejects the name, the agent shows the reason
and asks again.

Milestones marked "draft" or "queue" need no question at that point. Auto-mode
already pauses and runs a full discussion for them before they run.
`discuss-headless.md` does not ask.

### TUI backstop

A new module, `src/resources/extensions/gsd/milestone-branch-prompt.ts`,
exports:

```ts
export interface MilestoneBranchPromptCtx {
  hasUI: boolean;
  ui: {
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
}

export async function ensureMilestoneBranchName(
  ctx: MilestoneBranchPromptCtx,
  basePath: string,
  milestoneId: string,
  milestoneTitle: string | undefined,
): Promise<void>;
```

The narrow context type accepts both the command context in `auto-start.ts`
and the loop context in `auto/pre-dispatch.ts`, and a test can pass a fake.

It runs before `enterMilestone` at `auto-start.ts:1801` and at
`auto/pre-dispatch.ts:446`. The first call covers `/gsd auto` and `/gsd next`.
The second call covers the transition to the next milestone during a run.

It returns without any action in these cases:

- The isolation mode is `none`.
- `hasMilestoneBranchRecord` is true.
- `ctx.hasUI` is false. Headless runs use `milestone/<MID>` and record nothing.

If the branch `milestone/<MID>` already exists, which is a legacy milestone that
resumes, it records that name without a prompt.

In all other cases it calls
`ctx.ui.input("Branch name for <MID>: <title>", "milestone/<MID>")`. The title
also shows the format hint when one is set. An empty answer or Esc records
`milestone/<MID>`. A rejected name shows the reason with `ctx.ui.notify`, and
the prompt appears again.

## Failure handling

- An unreadable or unparsable record: `autoWorktreeBranch`,
  `setMilestoneBranch`, and milestone entry stop with a `GSDError` that names
  the file. gsd does not fall back to `milestone/<MID>`, because that would
  split the milestone work across two branches.
- The banner and the doctor listing only report state. For an unreadable
  record, they log a warning and skip it.
- A record exists, but the user deleted the branch by hand: milestone entry
  creates the branch again under the recorded name, from the integration
  branch. This matches what gsd does today when `milestone/<MID>` is missing.
- A deleted record for a live custom branch: gsd treats the branch as an
  ordinary user branch. It never deletes it or merges it automatically.

## Testing

Tests come first, in `src/resources/extensions/gsd/tests/`. Git fixtures set
`core.excludesFile` explicitly, because a global gitignore that lists `.gsd`
breaks them.

- `milestone-branch-registry.test.ts`: the default name, a recorded name, both
  cases of `milestoneIdForBranch`, `listMilestoneBranches` with and without
  records, each validation rule, the fixed name after the branch exists,
  removal, and the unreadable-record error.
- `milestone-branch-prompt.test.ts`, with a fake `ctx.ui`: no UI, an existing
  record, isolation `none`, a legacy `milestone/<MID>` branch, an empty answer,
  Esc, and a rejected name followed by a valid name.
- Teardown: stop with `preserveBranch` keeps the record. A successful merge
  removes it. Discard removes it.
- Integration: create, enter, and merge a milestone with a custom name in
  worktree mode and in branch mode, following
  `fast-forward-reused-milestone-branch.test.ts`.
- `discuss-prompt.test.ts`: the new question and `{{milestoneBranchFormat}}`.
- Preference validation for `git.milestone_branch_format`.
- The `gsd_milestone_set_branch` tool, the discuss allowlist, and MCP parity.
- The existing suite, with no records present, passes unchanged. That shows
  backward compatibility.
