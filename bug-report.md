# Bug Report — gsd-pi

Deep semantic review, one subagent per file, max 10 concurrent. Every Critical below was
independently re-verified by me against the source before inclusion.

## Scan Summary

| | |
|---|---|
| **Mode** | Full scan (`git_ref=all`), Tier 1 + grep-hot subset |
| **Codebase** | 1,442 source `.ts` files / 478k LOC (tests, fixtures, examples, `dist`, `pkg`, `node_modules`, `.d.ts` excluded) |
| **Review set agreed** | 150 files / 106k LOC |
| **Files reviewed** | **195** — the agreed 150-file review set is **complete**, plus ~45 targeted follow-ups |
| **Still unreviewed** | **0** |
| **Findings** | **~407** — 32 Critical, 219 High, 174 Medium |
| **Clean files** | 25 reviewed with zero findings (listed at the end) |
| **Failures** | None |

**Coverage: complete.** An earlier revision of this report carried a caveat that the agreed 150
files had not been finished — roughly a third of the initial budget went into follow-up dispatches
at root causes instead. That caveat no longer applies: the remaining 41 files were subsequently
reviewed and are folded in below.

The remaining-file list was rebuilt from ground truth rather than from the running ledger, which had
drifted. I extracted the assigned file from each of the 205 agent transcripts (160 distinct files)
and diffed that against the review set, which put the true remainder at 41 — not the ~55 the earlier
caveat estimated, and not the 121 the stale ledger claimed.

**The caveat's substantive warning was borne out.** It said grep signal did not predict severity and
the remainder should be treated as unknown rather than low-risk. Those 41 lowest-signal files
produced **three Criticals** (C32, C33, C34) and 11 Highs — including the single most damaging
finding in the report, C34, in which the `edit` tool silently rewrites the whole file and hides it
from the diff preview.

### Deviations from the packaged skill

1. The skill is C#-only (`.cs`, `src/Api`). Checklist was adapted to TS/Node idioms.
2. The skill excludes files >2000 lines. Those were **kept** — they produced two Criticals.

No `known-issues.md` exists, so nothing was suppressed.

---

## Corrections and retractions

Four claims were walked back after I checked them. They are listed first because a report
that only shows confirmations is not trustworthy.

| Claim | Outcome |
|---|---|
| **FSM validator never enforced on update** (2 reviewers, Critical) | **RETRACTED.** `trg_workflow_lifecycle_transition` is a `BEFORE UPDATE` trigger enforcing the full transition allow-list, `state_version = OLD+1`, advancing revision, and changed `updated_at`. App-level covers INSERT, the trigger covers UPDATE. |
| **Milestone can be closed out with open work** (Critical) | **Downgraded to High — with a caveat found later.** `requireTerminalState` (per milestone, per slice, per task) plus `requireNoActiveAttempts` do block the DB *completion write*, so the original claim was wrong. **But** the same completeness gap has a separate destructive exit: `isCompletedMilestoneTerminal` (`milestone-closeout.ts:59-89`) has two early `return true` paths that never inspect slices or tasks, and its fallback checks only `slice.status`, never `getSliceTasks`. It gates `doctor-git-checks.ts:316` → `nativeBranchDelete(basePath, branch, true)`, so **`doctor --fix` force-deletes the branch of a milestone with open tasks.** Filed as a fourth destructive `doctor --fix` defect (with C20/C21/C22), not as a re-elevation of C29. |
| **`atob` on base64url breaks login ~100% of the time** (Critical) | **Downgraded to Medium.** `atob` does reject `-`/`_`, but ASCII JSON cannot produce them except via `?`/DEL at a triplet boundary: 0/2000 plain payloads affected, 2000/2000 query-string-bearing ones. Real but latent. |
| **`gsd_execute` escapes the MCP sandbox** (Critical) | **Qualified.** `validateProjectDir` returns early with no containment unless `GSD_WORKFLOW_PROJECT_ROOT` is set. There is no sandbox by default; the bypass matters only in a hardened deployment. |

**Methodological note.** Two independent reviewers converged on the retracted FSM Critical.
Earlier in the scan I treated independent convergence as a confidence signal — it is not,
when both agents share a blind spot. Both reasoned from TypeScript alone and never read the
schema. **Any remaining "missing validation" finding in a DB writer should be checked against
the schema before action.** DB-level enforcement is confirmed present for
`workflow_item_lifecycles` and `workflow_recovery_actions`.

Three of six "copy this pattern" references also failed verification and are **not** cited as
templates: `writeMilestoneValidation` (unrecognised verdict falls through as pass),
`commands-ship.ts` (the id-validation convention a comment credits it with does not exist),
`doctor-state-checks.ts` (has the same flat-phase bug it is credited with guarding).

**Verified-sound references, safe to copy:** `commands-eval-review.ts` — **but only for the two
things cited here** (`SLICE_ID_PATTERN` validate-before-access, and its genuinely token-level arg
parser). Both re-verified and both sound. Copy those two patterns; do *not* treat the file as clean.
A later review found a real bug in it: `detectEvalReviewState:227` can never return `no-slice-dir`
under the default flat-phase layout, because `resolveSlicePath` hands back an
always-existing milestone directory (see the shared-layer root cause in the late batch), so a
nonexistent slice ID is reported to the user as "no summary yet" rather than "no such slice."
Other verified-sound references: `isInsideWorktreesDir` and its 5 call sites, `guided-flow.ts`
`dispatchWorkflow`, `pi-ai/.../oauth/anthropic.ts`.

---

## ⚠️ Fix first — silent worktree data loss (C16)

**`reconcileWorktreeDb` has three silent-success returns; all four call sites discard the
return value; the worktree is then deleted.** `.gsd/gsd.db*` is gitignored, so no other copy
exists.

```
db/writers/reconcile.ts
  :111  worktree DB path contains ' " ; or NUL   → return zero
  :117  cannot open main DB                      → return zero
  :732  any non-divergence error mid-merge       → return { ...zero, conflicts }

call sites — none inspect the result:
  auto-worktree-merge-db-ready.ts:94
  auto-worktree-teardown.ts:93
  worktree-state-projection.ts:421   ← also pushes "gsd.db (pre-upgrade reconcile)" onto `synced`
  worktree-command.ts:57
```

The first guard fires on an ordinary path (verified):

```
ok                          /Users/me/code/myproject/.gsd/gsd.db
TRIPS GUARD → silent no-op  /Users/me/Client's App/.gsd/gsd.db
```

**Any user whose project path contains an apostrophe silently loses every worktree-local
decision, requirement, task and artifact on each merge, while logs report success.** Even on
the success path, detected `decision <id>: modified in both` conflicts are appended to
`conflicts` and then discarded by teardown before the branch is deleted.

**Fix:** make `reconcileWorktreeDb` throw instead of returning a zero-shaped result; gate
teardown on success; surface `conflicts`.

## ⚠️ Also fix first — only the first milestone of a run ever merges (C30)

`milestoneMergedInPhases` is a **session-wide boolean with no milestone identity**, and nothing
clears it when the auto loop moves to the next milestone.

```
set true:  auto/closeout.ts:200 , auto/orchestrator.ts:749
reset:     auto/session.ts:446 — inside reset(), reachable only via stopAuto
milestone transition, pre-dispatch.ts:422-425:
             s.unitDispatchCount.clear();
             s.unitRecoveryCount.clear();
             s.unitLifetimeDispatches.clear();     ← the trio is cleared
                                                   ← milestoneMergedInPhases is NOT
           :429  …then immediately runs the next milestone's merge
consumers: closeout.ts:309  `if (ic.s.milestoneMergedInPhases) return null;`
           auto.ts:1704 (settlement input) , :1778 , :2169 (`return "none"`)
```

M001 completes and merges → flag set. M002 completes in the same session → every guard reads
the stale `true`, concludes "already merged", and skips the merge and the closeout-proof pause.
**M002's completed work is stranded, unmerged, on its worktree branch while the run reports
success.** Combined with the teardown holes above, that branch is then a deletion candidate.

**Fix:** replace the boolean with `milestoneMergedInPhasesFor: string | null` and compare
against `s.currentMilestoneId`, so the guard expires naturally on milestone change.

---

### The whole merge path is unprotected

Seven layers, each with a hole, all on the same path:

| Layer | Defect |
|---|---|
| preflight stash | drops `.gsd/` edits without applying them (C24) |
| dirty check | `""` from a failed `git status` reads as clean |
| pre-teardown guard | **three** independent fail-open paths in 30 lines (C25, C26) |
| DB reconcile | silent no-op, all callers ignore (C16) |
| merge conflict | deletes worktree + branch *before* reporting the conflict (C9) |
| teardown | gated on nothing; conflicts discarded |
| `doctor --fix` | deletes rescue branches (C20); mass-deletes worktrees (C22) |

`removeWorktree` defaults **`force: true`** (`worktree-manager.ts:858`).

> ### ⛔ CORRECTION — do NOT apply the `force: false` stopgap this report previously recommended
>
> An earlier revision of this report told you to flip that default to `force: false`, calling it a
> two-character edit that converts silent data loss into a loud git error. **That was wrong, and
> applying it would remove a safety net rather than add one.** Retracted in full.
>
> `force: true` is not a naked force-delete. It is the flag that *enables* the dirty-worktree
> quarantine, at `worktree-manager.ts:1004`:
>
> ```ts
> if (force && resolvedPathSafe && isLiveGitWorktreeCheckout(resolvedWtPath)) {
>   const dirtyState = inspectUncommittedWorktreeState(resolvedWtPath);   // fails CLOSED (:244)
>   if (dirtyState.dirty) {
>     const quarantinePath = quarantineDirtyWorktree(...);                // preserves the work
>     if (!quarantinePath) return false;
> ```
>
> With `force: false` that whole block is skipped. I verified the gate directly. I had inferred the
> behaviour from the defaults line at `:858` without reading to `:1004`, which is exactly the
> mistake this report elsewhere warns about — and it is the second time in this scan that a
> plausible-shaped claim survived until someone read the enforcement site (see the C13 retraction).

**What the real defect turned out to be.** The data *is* preserved — it gets quarantined — but
callers are never told. `removeWorktree` signals quarantine by returning `false`, not by throwing,
and three of the four call sites in `commands-worktree.ts` discard the return and print success:

| Call site | Return checked? | What the user is told |
|---|---|---|
| `handleMerge` :166 | ✗ | `"Removed empty worktree …"` |
| `handleMerge` :224 | ✗ | full `"Merged … → main"` success block |
| `handleClean` :251 | ✗ | listed under `Removed:` in the summary |
| `handleRemove` :317 | **✓** | correctly warns that state was quarantined |

The correct version already exists, 90 lines from the broken ones, in the same file. **Actual
stopgap: make the three call sites match `handleRemove`.**

Compounding it, `commands-worktree.ts:56-61` fails *open* on the same question the layer beneath
fails *closed* on:

```ts
let uncommitted = false;
try   { uncommitted = existsSync(wtPath) && nativeHasChanges(wtPath); }
catch { /* native check failure → treat as clean for display purposes */ }
```

The comment says "for display purposes," but `status.uncommitted` also decides whether
`handleMerge` runs `autoCommitCurrentBranch` at `:180`. So if `nativeHasChanges` throws — a
concurrent agent holding `.git/index.lock` is the realistic trigger — the worktree is treated as
clean, the auto-commit is skipped, and the squash-merge silently omits the uncommitted work while
reporting success. One layer down, `inspectUncommittedWorktreeState:244` handles the identical
failure with an explicit `// Fail closed: unknown state must quarantine rather than force-remove`.

---

## ⚠️ Fix second — git operations can target the wrong repository (C23)

`git-constants.ts` strips `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` because they *"can
silently redirect every operation to a different repo or index … (Issue #4980 NEW-1)"*.

`native-git-bridge.ts` has **18** `execFileSync("git", …)` fallbacks. **15 pass the overlay.
3 do not:**

| Line | Command | Consequence when env is leaked |
|---|---|---|
| 408 | `rev-parse --git-dir` | misreports repo status |
| **1070** | `git checkout <branch>` | swaps a **different** repo's working tree |
| **1237** | `git reset --hard HEAD` | **irreversibly discards uncommitted changes in an unrelated repo** |

Line 1079 (`checkout -b`) passes it; line 1070 (`checkout`), the adjacent function, does not.
**Fix: three added lines.**

### Related root cause — failure indistinguishable from "nothing found"

~17 read helpers call `gitExec(..., allowFailure=true)`, collapsing "git failed" into the same
falsy value as "found nothing". Most callers fail closed. These fail **open**, into
data-loss guards:

- `nativeWorktreeList` → `[]` → `doctor-git-checks.ts` `rmSync`s every worktree (**C22**)
- `nativeWorkingTreeStatus` → `""` → the documented *"final data-loss check before deleting a
  merged milestone worktree"* reads it as clean
- `nativeHasChanges` → `false`, **cached 10 s** → `GitService.autoCommit` returns early and the
  completed unit's work is never committed
- `nativeBranchExists` → `false` → defeats the TOCTOU guard (#4980 HIGH-3) before
  `nativeBranchForceReset`, orphaning concurrent commits

---

## Cross-cutting patterns

Each has one root fix, not N patches.

| # | Pattern | Sites | Verified reference |
|---|---|---|---|
| P1 | **No GSD identifier is format-validated anywhere.** `isNonEmptyString` is the only gate; ids flow into `join()` across **8 sinks** covering read, write and delete | 8 | `commands-eval-review.ts` `SLICE_ID_PATTERN` |
| P2 | Tool error returns omit `isError: true`; the `tool_result` hook then calls `clearToolInvocationError()` on a failure | 12 in `db-tools.ts` + `journal-tools.ts` + MCP read tools | `memory-tools.ts` |
| P3 | State mutated inside a speculative `match()` before dispatch is confirmed | 4 in `auto-dispatch.ts` | — |
| P4 | `computeEditsDiff` unhandled rejection — `resolveToCwd` sits outside the `try` at `edit-diff.ts:417` | 2 callers, 1 root | — |
| P5 | Racy deferred `node:` imports | 2 of 3 OAuth providers | `oauth/anthropic.ts` |
| P6 | Session transitions skip `settleCurrentTurnForSessionTransition()` + `disconnectFromAgent()`; no caller guards `isStreaming` | `fork()`, `navigateTree()` | `newSession()`, `switchSession()` |
| P7 | Ignored veto/boolean result — success reported for a cancelled or no-op action | `/clear`, `/logout`, `removeWorktree`, `discardMilestone` | `interactive-extension-widgets.ts:38` |
| P8 | Unawaited async around scoped state — `finally` restores before the turn runs | 2 in `commands-handlers.ts` | `guided-flow.ts` `dispatchWorkflow` |
| P9 | Non-atomic writes where an in-repo atomic helper exists | `edit.ts:80`, `write.ts:33`, `session-manager.ts:246`, `artifact-manager.ts:90`, `auth-storage.ts`, `.env` | `gsd/atomic-write.ts` (temp→fsync→rename) |
| P10 | Bare `catch` conflating "missing" with "unreadable", destroying or fabricating state | `post-execution-checks`, `db-writer`, `visual-diff`, `state-persistence`, `.env` | — |
| P11 | `Record<string, any>` options bag hiding caller/callee key mismatch | 3 in `browser-tools/core.ts` (bounded — 17 other sites legitimately dynamic) | — |
| P12 | **`executionMode: "sequential"` is declared nowhere in production** — only in an example extension; agent defaults to parallel | repo-wide | `file-mutation-queue` (the only real serializer, and it has 2 High of its own) |
| P13 | `process.kill(pid, 0)` treated as *identity* | 18 files — **audit direction**: fail-safe (locks) vs fail-unsafe (`crash-recovery`, `db/auto-workers`) | heartbeat already exists in `auto-workers.ts`, unused |
| P14 | `doctor` mutates without the consent gate | 3 modules; the git one is **destructive** | `shouldFix()` in `doctor.ts:221` |
| P15 | Timer callbacks re-check presence, not **identity**, after an `await` | 3 in `auto-timers.ts` (bounded — `auto-liveness-backstop` does it correctly) | — |
| P16 | 6 of 8 workflow tools discard the `stale` signal their 2 siblings propagate | 6 | `reopen-slice.ts`, `reopen-milestone.ts` |

### The single highest-leverage fix

A four-file compound chain collapses to **one change**:

```
recycled PID → isWorkerProcessAlive() misjudges liveness
            → milestone lease granted while the original worker is still running
            → settleStaleActiveDispatchForUnit cancels its RUNNING dispatch
            → markCompleted's WHERE status IN ('claimed','running') no-ops
            → outcome silently dropped, work duplicated
```

`canReclaimLease` already fails closed and has no identity signal available, so the fix cannot
live there. `db/auto-workers.ts` maintains `last_heartbeat_at`, defines
`HEARTBEAT_TTL_SECONDS = 60`, and already uses the TTL in a query 40 lines away — but
`isWorkerProcessAlive` is typed `Pick<AutoWorkerRow, "host" | "pid">`, so it structurally
cannot see it. **Widen the `Pick` and short-circuit on a lapsed TTL.** A recycled PID cannot
fake a fresh heartbeat.

---

## Critical findings

Full detail for each, including the verification I ran.

**C16** — worktree reconcile silent data loss. *See "Fix first" above.*
**C23** — `git reset --hard` / `checkout` without env scrubbing. *See "Fix second" above.*

**C1 · `bootstrap/db-tools.ts`** — All 20 `resolveWorkflowToolBasePath(_ctx, params)` sites pass
camelCase `milestoneId`; the helper reads `scope?.milestone_id` (`dynamic-tools.ts:70`). Auto-worktree
routing never activates; writes land in the main project's `.gsd` DB. `scope` is optional so TS
cannot catch it. The existing test exercises the helper directly with a snake_case object.

**C2 · `bg-shell/bg-shell-lifecycle.ts:59,405`** — Both `session_shutdown` handlers ignore
`event.reason` and call `cleanupAll()`, which SIGKILLs everything with no `persistAcrossSessions`
check. `reason` is `quit|reload|new|resume|fork`. The correct filter already exists at
`process-manager.ts:442`; the contract is advertised to the model at `bg-shell-tool.ts:60`.

**C3 · `tools/exec-tool.ts:206-297`** — `executeUatExec` never calls `normalizeRuntime`; it applies
six **bash-shaped** regexes and passes params through. A `python`/`node` script bypasses the entire
UAT policy. Also `rm -fr`, `rm --recursive --force`, and `cat ./.env` / `less .env` all bypass.

**C4 · `pi-agent-core/agent-loop.ts:1112`** — `raceToolExecutionAgainstAbort` early-returns on
`signal.aborted` *before* attaching the `.then(onFulfilled, onRejected)` guard, so an already-queued
tool that rejects produces an unhandled rejection. Fatal under Node's default.

**C5 · `mcp-server/workflow-tools.ts:640,762`** — Unsanitized `milestoneId` `join()`ed into a
worktree path with no containment check; the result replaces the validated `projectDir` with no
re-validation. *Qualified: containment only exists when `GSD_WORKFLOW_PROJECT_ROOT` is set.*

**C6 · `mcp-server/server.ts:1152` + `session-manager.ts:123`** — `gsd_execute`, the one tool that
spawns an autonomous shell-capable agent, skips `validateProjectDir` that 11 sibling tools call.
*Qualified as above.*

**C7 · `tools/workflow-tool-executors.ts:679`** — `task_id` interpolated into a filename by
`buildFlatTaskFileName`; verified `join("/proj/.gsd/M001", "S01-../../../../../../tmp/pwned-SUMMARY.md")`
→ `/tmp/pwned-SUMMARY.md`. No containment check in the builder, `targetTaskFile`, or the projection writer.

**C8 · `worktree-manager.ts:892` + `milestone-actions.ts:144`** — `removeWorktree` computes
`resolvedPathSafe` but enforces it only for the tail steps; the nested-`.git` `rmSync` and
`git add -A && commit` run unconditionally. `/gsd discard <arg>` passes the raw slash-command
argument through with no validation.

**C9 · `worktree-manager.ts:1268`** — On a real merge conflict the worktree and branch are
force-deleted **before** `GSD_MERGE_CONFLICT` is thrown, while both the CLI and the LLM-guided
handler tell the user to resolve conflicts against a worktree that no longer exists.

**C10 · `exec-sandbox.ts:317-337`** — `redactSecrets()` is applied to the persisted files but the
agent-facing digest is built from the **raw** `stdoutBuf` (line 327) and returned to the model at
`exec-tool.ts:337`. Secrets scrubbed on disk, sent verbatim to the provider.

**C11 · `custom-workflow-engine.ts:169`** — The "ReDoS guard" checks elapsed time *between* loop
iterations, so it cannot interrupt a single catastrophically-backtracking `exec()`. Author-supplied
patterns are validated only for syntax.

**C12 · `commands-maintenance.ts:561` + `db-workspace.ts:852`** — `handleRecover` checks only
`isDbAvailable()` with no project scoping, so `/gsd recover` run from project B reports and can
mutate project A. `handleDbRestoreBackup` in the same file has the guard
(`currentProjectId !== verified.projectId`); `deriveState` has `isSameOpenDatabase`.

**C14 · `subagent/index.ts:1450` + `:557`** — Single-agent isolated mode merges a **failed**
subagent's diff into the live repo (`if (isolation)` — the parallel/background paths at 1151/1354
correctly gate on `exitCode === 0`). Compounding: `proc.on("close", (code) => resolve(code ?? 0))`
drops the signal arg, so a SIGKILLed subagent reports exit 0 — **adding the guard alone does not fix it.**

**C15 · `slice-parallel-orchestrator.ts:153`** — `rmSync(wtPath, {recursive:true, force:true})` on a
path built from unvalidated ids, before any validation, with no containment check. The repo
*documents* this exact requirement at `commands-eval-review.ts:14` and exports `isInsideWorktreesDir`,
used correctly at five other destructive sites.

**C17 · `doctor-git-checks.ts:177`** — Conflict auto-resolve gated only on `!dryRun`, not
`shouldFix`. `headless.ts:480` and `forensics.ts:420` call `runGSDDoctor` with no fix flag, so a
read-only diagnostic **aborts an in-progress merge/rebase** and auto-stages resolutions. 12
`shouldFix()` calls elsewhere in the same file.

**C20 · `doctor-git-checks.ts:431`** — The `gsd/*/*` glob matches
`gsd/submodule-rescue/<name>-<ts>` — the branches `worktree-manager.ts:941` creates specifically to
rescue uncommitted submodule work — and force-deletes them.

**C21 · `doctor-git-checks.ts:260`** — `orphaned_auto_worktree` force-removes on roadmap status
alone (including `cancelled`/`skipped`) with no dirty check, while the sibling
`worktree_branch_merged` at line 652 correctly gates on `health.safeToRemove`.

**C22 · `doctor-git-checks.ts:514`** — `nativeWorktreeList` returns `[]` on transient failure →
every on-disk worktree looks unregistered → `rmSync` on all of them, including dirty and unpushed.

**C24 · `clean-root-preflight.ts:487`** — When every stashed path is `.gsd/`-owned, the stash is
**dropped without `git stash apply`**, with no content check and no verification the merge touched
those paths — then returns `restored: true, needsManualRecovery: false`. The sibling drop at line 271
compares content first (`readFileSync` at 236). The comment at 484 even calls apply "the safe default".

**C25 / C26 · `auto-worktree-merge-pre-teardown.ts:64-92`** — The documented *"final data-loss check"*
has three fail-open paths in 30 lines: branch-detect throws → `null !== branch` → dirty check skipped;
`""` from failed `git status` → "clean"; and `deps.chdir(previousCwd)` throwing inside the `try`
means the `GSDError` is never constructed and the non-GSDError is swallowed by its own handler —
**the abort is lost after uncommitted changes were already detected.**

**C27 · `get-secrets-from-user.ts:558`** — Model-supplied `envFilePath` passed to `resolve()` with no
containment. Verified `resolve("/proj","/Users/victim/.ssh/authorized_keys")` returns the absolute
path unchanged. Arbitrary `KEY=value` file write. Same file: `isSafeEnvVarKey` guards the
vercel/convex branch (line 370) but **not** the dotenv branch (354), so a newline in a key injects a
second pair; and `.env` is written with no `mode`, landing at 0644.

**C28 · `mcp-server/pid-registry.ts:528`** — `signalAutoLockPid` uses inline `pid <= 0`, permitting
**PID 1**, while the shared `isSafePid` (line 237) is `pid > 1` and is used by `killPid`. It also has
no `getProcessCommand` check at all, where `killPid` requires `isMcpServerCommand` (line 456).
Reachable from user-initiated `cancelSessionByDir`.

---

## High and Medium findings

~300 further findings across 138 files. Grouped by subsystem, most severe first within each.

**Credential storage — 6 findings, all silent loss with a success message**
`auth.json` non-atomic write (kill mid-write wipes *all* providers) · write failures swallowed into
`AuthStorage.drainErrors()`, which has **zero callers** (verified) · OAuth refresh drops a
co-located API key · `keys add` silently replaces stored OAuth · `keys remove` with 3+ keys keeps
only the last (`set()` is `this.data[p] = c`, no array API exists) · `keys rotate`'s "Preserve any
OAuth credentials" loop is provably overwritten by the next line.

**Verification and safety nets that cannot fire**
`safety_harness.auto_rollback` tests `unitResult.status === "error"`, a value assigned **nowhere**
(14 assignments, all `cancelled`/`completed`) — and the `else` branch *deletes* the checkpoint ·
cost-spike guard includes the outlier in its own baseline, so it can never fire on the first unit ·
ghost-completion guard measures from a `requestDispatchedAt` never refreshed across wakeups ·
`verify-after-write` accepts a stale `quality_gates` row · `artifact-verification.ts` has two
fail-open catches (errored check → `return true`) beside three correct fail-closed siblings ·
`pre-execution-checks.ts` compares task status to `"completed"` while the DB writes `'complete'` —
**and the regression test uses the same wrong literal** · required-verification-class check is
presence-only: text asserting *every class FAILED* satisfies it (verified) · `missing_slice_dir` in
`doctor-state-checks.ts` is unreachable · read-only-reconnaissance classifier passes
`find … -delete`, `git branch -D`, `git remote remove` (verified).

**Agent file-mutation path**
`edit.ts` re-encodes the whole file as UTF-8, corrupting non-UTF-8 bytes outside the edited region
(verified `0x92` → `ef bf bd`) · both `edit` and `write` truncate in place, no temp+rename ·
`throwIfAborted()` *after* a committed write reports success as aborted · `file-mutation-queue` —
the only serializer — has a global chokepoint and a key that differs pre/post file creation under a
symlinked ancestor (verified `os.tmpdir()` ≠ its realpath here) · `bash.ts` treats
`exitCode === null` as success, so SIGKILL/segfault/OOM reads as clean (verified).

**Session persistence**
`_persist()` has no try/catch and leaves `flushed = true` after a throw — the entry is **permanently
dropped** while live in memory · `_rewriteFile()` non-atomic over the whole file, runs on every
version migration · `getBranch()` has no cycle guard though `getTree()` does · `wasInterrupted()` is
`return false` (verified), so its resume warning is unreachable.

**Worker/dispatch lease chain** — see "highest-leverage fix" above. Plus: a crashed worker with no
dispatch is attributed **the most recently updated in-flight unit project-wide**, which can be a
*live* worker's, and a synthetic `unit-end` is injected into its open stream.

**MCP server** · `parseInt` turns `"3 people said no…"` into a silent selection of option 3 ·
per-call Telegram cursor confirms past other sessions' updates · `ghAddToProject` can never succeed
(two `--jq` filters emit a bare string while the other four wrap in an object; verified
`JSON.parse('"PVT_…"').id === undefined`) · GraphQL injection via a `repo` validated only by
`.includes("/")` · graph reader writes at any caller-supplied path.

**browser-tools** · `summarizeBrowserSession`/`buildFailureHypothesis`/`formatTimelineEntries` read
key names **no caller passes**, so the debug surface always reports zero actions and "no failure
signals" (verified) · `CSS.escape` called from Node — always throws, silently caught, so the `name`
resolution strategy has never worked (verified `typeof CSS === "undefined"`) · plaintext passwords
echoed into tool output · caller-supplied `action` overrides the intended verb via spread order
(verified) · saved cookies written 0644 · localStorage restored into the wrong origin · no launch
mutex · no URL scheme allowlist · dead connection served from the pool forever.

**subagent isolation** · symlinked untracked files dereferenced and committed into the sandbox ·
predictable `os.tmpdir()` patch path with default flags · failed baseline commit folds the parent's
dirty state into the delta · chain mode silently ignores `isolated: true`.

**Slash commands** · `/gsd park <id> <reason>` assigns the whole string to `targetId`, so it never
resolves and `reason` is always `""` (verified) · `args.includes("--force")` matches
`--force-with-lease`, bypassing a confirmation gate · `--name` swallows the next flag ·
`/gsd workflow uninstall` deletes with no confirm.

**github-sync** · failed per-task issue creation still marks the slice synced, so it is never
retried and its completion is silently skipped forever · `ghMergePR`'s result discarded, so a
PR blocked by branch protection is recorded `"closed"`.

*(Per-file detail for every High and Medium is preserved in the scan transcript; the entries above
are grouped by root cause because fixing them individually would leave the failure mode intact.)*

---

## Continuation sweep — the previously-unreviewed files

Completing the 41 files left unreviewed when the report was first written. Findings below are in
addition to C31 and the `commands-worktree.ts` findings, which are written up in their own sections
above because they changed existing conclusions.

**`pi-coding-agent/src/core/exec.ts:104` — a signal-killed process reports SUCCESS.** *High,
verified.* This is the report's central theme reaching the layer everything else runs on.
```
child-process.ts:46   waitForChildProcess(child): Promise<number | null>   ← signature can't carry a signal
child-process.ts:99   const onExit = (code: number | null) => {            ← drops Node's 2nd arg
exec.ts:104           code: code ?? (killed ? 1 : 0)                       ← `killed` set ONLY by our killProcess()
```
A child killed by an *external* signal — OOM killer, `kill -9`, SIGSEGV — yields `code === null`
with `killed === false`, so the expression resolves to **`0`**. An OOM-killed `git commit` is
reported to the agent loop as having succeeded. Fix: surface `signal` from `waitForChildProcess`
and treat a non-null signal as failure. Same file, also High: `stdout`/`stderr` accumulate into
unbounded strings with no cap and no mandatory timeout, so a model-supplied `cat /dev/zero`
exhausts the host CLI's memory. Two Mediums: no kill on host-process exit (orphaned children
holding `.git/index.lock`), and a spawn `ENOENT` discarded so "git is not installed" is
indistinguishable from "git exited 1".

**`db-provider.ts:99-113` — `close()` leaks both SQLite handles.** *High, verified.*
```ts
try { readOnlyGuard.prepare("PRAGMA schema_version").get(); }
catch (error) {
  const journalMode = writable.prepare("PRAGMA journal_mode").get()?.["journal_mode"];
  if (journalMode !== "delete") throw error;   // ← before BOTH closeHandle() calls below
}
closeHandle(writable);     // never reached
...
closeHandle(readOnlyGuard); // never reached
```
The runtime journal mode is WAL (restored by `db/engine.ts`), so the `!== "delete"` branch is the
normal case. Both handles are closure-private, so no caller can close them afterwards — repeated
occurrences march toward `EMFILE` in a long-running agent. The `PRAGMA journal_mode` probe inside
the catch is itself unguarded and can replace the original error. Plus one Medium: in `openRaw`,
a throwing `readOnlyGuard.close()` during cleanup masks the real open failure.

**`agent-session-runtime.ts:314-320` — `fork()` mutates live session state before shutdown fires.**
*High.* For in-memory sessions, `fork()` calls `newSession()`/`createBranchedSession()` on the
**shared** `SessionManager` and only then calls `teardownCurrent("fork", …)`, so `session_shutdown`
handlers read an emptied or truncated conversation instead of the one that is ending. The shipped
`auto-commit-on-exit.ts` example does exactly that read. The two adjacent persisted-session
branches (`:280-292`, `:296-311`) build a *new* `SessionManager` and are unaffected — the sibling
asymmetry again. Plus one Medium: `importFromJsonl` overwrites an existing session file with a
colliding basename, with no existence check.

**`slice-lifecycle-domain-operation.ts` — actor identity required on one entry point, not its
siblings.** *Medium.* `cancelSlice:142-146` rejects a `user`-attributed call with no `actorId`;
`reopenSlice` and `completeSlice` take the same invocation shape and have no such check, so a
user-attributed reopen or completion commits with `actor_id = NULL`. Current tool wiring only
calls these as `agent`, so it is latent — but the exported functions place no constraint on
callers, and both are as consequential as the one that *is* guarded.

**`db-migration-steps.ts:384-391`** · *Medium.* A failed FTS backfill is caught and logged, then
schema version 19 is recorded as fully applied, with no retry path — pre-existing memories are
permanently missing from search. Worth noting the reviewer also *rejected* a candidate here after
confirming `engine.ts:513-806` wraps all migrations in a transaction with rollback-and-rethrow.

**`tools/memory-tools.ts:205-224`** · *Medium.* With `include_superseded: true`, the ranked and
capped candidate list is discarded and replaced by an unordered, unlimited `SELECT * FROM memories`,
so `.slice(0, k)` returns the first k rows in storage order rather than the top k by score — and
scans the whole table on every call. No path-traversal sink here; that hint did not apply.

### ⚠️ C32 — `secure_env_collect`: the AI never sees the secret, but chooses where it is written

`packages/mcp-server/src/env-writer.ts` + `server.ts:1004-1014,1383`. **Critical, verified.**

The tool elicits secrets from a human with this promise on screen:

> *"Values are written directly to the project and never shown to the AI."*

The value half of that is true. The **destination** half is not — and both halves of the
destination are model-supplied:

```ts
server.ts:1383  envFilePath: z.string().optional()
                  .describe('Path to .env file (dotenv only). Defaults to .env in projectDir.')
                                        // ↑ "dotenv only" is enforced NOWHERE — description text only
server.ts:1013  const resolvedProjectDir = validateProjectDir(projectDir);
                  // ↑ confirmed earlier in this scan: NO containment unless
                  //   GSD_WORKFLOW_PROJECT_ROOT is set. Default = returns caller's path unchanged.
server.ts:1014  const resolvedEnvPath = resolveProjectEnvFilePath(resolvedProjectDir, envFilePath ?? '.env');
```

`resolveProjectEnvFilePath:175-194` is, on its own, careful work — it checks the candidate, the
candidate's realpath, *and* the parent's realpath against the root. But every one of those checks
is anchored to `projectRoot`, which is whatever the caller passed. A well-built containment check
around an attacker-chosen anchor contains nothing.

**Net effect:** the model picks `projectDir` and the filename, so a human-entered production secret
can be written to `.envrc` (executed by `direnv` on `cd`), to `~/.bashrc`, or into a git-tracked
file that is then committed. The user's consent was to "store my secret in this project," not
"store it wherever the agent names." **Fix at the boundary:** constrain `envFilePath` to
`/(^|\/)\.env(\..+)?$/` in the zod schema, and anchor containment to a root this module verifies
itself rather than to the caller's `projectDir`.

**Related, High — values are written unquoted.** `env-writer.ts:88-89` escapes only `\`, `\n`, `\r`:
```ts
const escaped = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "");
const line = `${key}=${escaped}`;
```
*The reviewer filed this as Critical RCE via `$(…)`; I am recording it as High instead.* The value
is human-typed, so the injection version requires the user to type a payload into their own secret
prompt — a footgun, not an attack. The version that will actually bite is mundane: a strong
generated password containing `$` or a backtick, written unquoted, is **silently misparsed** by any
`set -a; source .env` consumer — the app receives a corrupted credential and fails to authenticate
with no indication why. Fix: emit `KEY="…"` with `$`, `` ` ``, `"` and `\` escaped.

**Also High — raw subprocess stderr is returned to the AI** (`:272-278`). On a failed
`vercel env add`, `errors.push(\`${key}: ${result.stderr.slice(0, 200)}\`)` sends the provider's
stderr straight into the MCP tool response, the one channel the AI reads. If the provider echoes
the rejected value (length/charset validation being the obvious case), the secret the tool promised
to hide is disclosed. Confidence Medium — it depends on provider behaviour — but the fix is free:
report the exit code, not the stderr.

Three Mediums in the same file, all worth noting because two are the report's signature pattern
*within a single file*:
- `:19-25` vs `:82-86` — `writeEnvKey` correctly rethrows any non-`ENOENT` read error;
  `checkExistingEnvKeys` swallows **all** read errors and proceeds as if the file were empty, so an
  `EACCES` makes every already-configured key look unset and re-prompts the user for it.
- `:122-133` vs `:175-194` — `resolveProjectEnvFilePath` deliberately *permits* a symlink whose
  target stays in-root; `assertWritableEnvFileTarget` then refuses **every** symlink. A project with
  `.env -> config/.env.local` can never have a secret written. Fails in the safe direction, but the
  tool reports an error for every key.
- `:90` — the update regex uses the `m` flag but not `g`, so with a duplicated key only the *first*
  line is rewritten. dotenv and `source` both take the **last** definition, so the write is reported
  as applied while the operative value stays stale.

**`core/tools/find.ts:285-291` — a partial file listing is returned as a complete one.** *High,
verified.* The two sibling search tools disagree about what a non-zero exit means:
```ts
// grep.ts:303 — rejects on any unexpected exit code, unconditionally
if (!killedDueToLimit && code !== 0 && code !== 1) { settle(() => reject(new Error(errorMsg))); return; }

// find.ts:285 — builds the error, then throws it away when output is non-empty
if (code !== 0) {
  const errorMsg = stderr.trim() || `fd exited with code ${code}`;
  if (!output) { settle(() => reject(new Error(errorMsg))); return; }
}   // ← falls through, errorMsg discarded, partial listing resolved as success
```
`find.ts` *constructs* the error message and then drops it. An unreadable subtree, or an
OOM-killed `fd` partway through traversal, yields a truncated listing with no notice — and an
agent that concludes a file does not exist. Fix: keep the reject, or attach a partial-result notice.

Four Mediums across the pair. `find.ts:185-188,307-312` relativizes with
`p.slice(searchPath.length + 1)` behind a bare `startsWith`, so `find(path: "src/foo.ts")` (where
the path *is* the match) slices past the end and returns an empty line — losing the only result;
`path.relative` alone handles it. Both files' `stopChild` send `SIGTERM` with no `SIGKILL`
escalation, so a hung `rg`/`fd` leaks per aborted call — while `exec.ts:killProcess` in the same
package already implements the escalation correctly. And `grep.ts` registers its abort listener
only *after* `ensureTool("rg")` and `isDirectory()` resolve, so cancellation during a first-run
ripgrep download is ignored — where `find.ts` registers before any await and rechecks after each
one. Every one of these four is the same pair of files disagreeing with each other.

### `browser-tools/refs.ts` — a guard whose input is collected and never read

*High, verified.* The sharpest instance of this report's pattern found anywhere in the codebase.
The snapshot captures which frame a ref came from, explicitly for staleness checking:

```ts
// tools/refs.ts:85-96
const activeFrame = getActiveFrame();
const frameCtx = activeFrame ? (activeFrame.name() || activeFrame.url()) : undefined;
setRefMetadata({ url: p.url(), ..., frameContext: frameCtx, mode });
```

`frameContext` occurs **exactly twice in the entire non-test codebase** — its type declaration at
`state.ts:88` and the write above. It is never read. The check it exists to enable was never
written.

The stale-ref guard compares ref version and top-level page URL, neither of which changes when the
active frame changes. So: select an iframe → snapshot ref `e1` → switch back to the main frame →
`browser_click_ref("@v1:e1")`. Version matches, URL matches, both guards pass, and the ref
resolves against the *wrong frame's* DOM — the core resolver's fallback tiers only verify tag name,
so it can return a plausible-looking selector for an unrelated element and report a successful
click. Same gap repeated in `browser_hover_ref` (`:359-366`) and `browser_fill_ref` (`:463-470`).
The fix is a three-line comparison using data the code already has.

### `browser-tools/action-cache.ts` — cache key cannot distinguish page, frame, or record

*High, verified — and broader than first reported.* Two independent collapses:

```ts
function buildCacheKey(url: string, domHash: string, intent: string): string   // :182 — no page/frame id
  normalized = `${u.origin}${u.pathname}`;                                     // :187 — query params stripped
...
const entries = [...tags.entries()].sort((a, b) => a[0].localeCompare(b[0]));  // :204 — order-insensitive
```

1. **No page or frame identity.** Two tabs on the same route produce the same key.
2. **Query params deliberately stripped** ("for broader matching," per the comment) — so
   `/orders?id=1` and `/orders?id=2` share a key. A selector cached against one record is served
   for another. This is the part the reviewer did not flag, and it is the likeliest to fire in
   practice: it needs no second tab and no re-render, just two records on one route.
3. **The DOM hash is a sorted tag histogram**, so it is order-insensitive by construction.
   Re-rendering `[Delete, Save]` where `[Save, Delete]` was leaves the hash byte-identical.

The only staleness check on a hit is `isVisible()`, which the *wrong* element satisfies just as
well. Net: `browser_action_cache get` can return a validated `hit` whose selector now points at a
different control — `button:nth-of-type(1)` resolving to Delete where Save was cached. Fix: put
page id, frame key, and the full URL in the key, and make the structural hash order-sensitive.

Three Mediums in the same batch: `pages.ts:273-287` range-checks `browser_select_frame`'s `index`
without an integer check, so `1.5` passes the bounds test, indexes to `undefined`, and surfaces a
`TypeError` instead of a validation error; `inspection.ts:329-340` passes `limit` unclamped to
`slice(0, limit)`, so `limit: -1` returns all-but-one result instead of capping; and
`refs.ts:483-489` hardcodes `Control+A` to select-all before a slow fill, which on macOS moves the
caret to line start instead — leaving the old value concatenated with the new one, with the tool
still reporting the fill as completed.

### ⚠️ C33 — `browser_emulate_device` can brick the browser session (Critical, verified)

`browser-tools/tools/device.ts:103-133`. It re-implements `ensureBrowser()` by hand, and gets two
things wrong that the original gets right.

**Critical — shared state is committed before the operation that can fail:**
```ts
resetAllState();                       // :120
setBrowser(browser);                   // :121
setContext(context);                   // :122
setSessionStartedAt(Date.now());       // :123
const page = await context.newPage();  // :125  ← if this throws, state is already committed
```
The registry is populated *after* this line. If `newPage()` throws — a transient crash right after
launch, the classic CI/sandbox flake — `getBrowser()` and `getContext()` are now non-null while
`pageRegistry` is empty. `ensureBrowser()`'s fast path is
`if (existingBrowser && existingContext) return { page: getActivePage() }`, so **every subsequent
browser tool call for the rest of the session** throws `registryGetActive: no active page`. The
`catch` (verified: no `close(` anywhere in it) also never closes the browser, so the Chromium
process leaks. Fix: build everything first, commit to shared state only after `newPage()` succeeds,
and `await browser?.close()` in the catch.

**High — new tabs become permanently invisible.** `context.on("page", …)` occurs at exactly one
place in the entire subsystem, `lifecycle.ts:220`. `device.ts` creates its own context and never
registers it. So after any device-emulation call, a `target="_blank"` link or `window.open` produces
a page that never enters `pageRegistry`: `browser_list_pages` can't see it, `browser_switch_page`
can't reach it, and no console/network listeners are attached — which means
`no_console_errors` and `no_failed_requests` assertions return **clean for a page nobody is
watching**. Two independent copies of setup logic drifted; the fix is to extract the shared helper.

### `browser_assert` passes when it verified nothing

*High, verified.* `assertions.ts:38-49`, and the same path via `browser_batch` at `:268-272`.

```ts
checks: Type.Array(Type.Object({ … }))          // no minItems
...
const failed = results.filter((r) => !r.passed);
const verified = failed.length === 0;            // [] → true
```

`browser_assert({ checks: [] })` — or a `browser_batch` step `{ action: "assert" }` with no
`checks` field, which defaults to `step.checks ?? []` — returns `isError: false` and the text
`"PASS (0/0 checks)"`. A verification tool reporting success for having verified nothing is the
purest form of the defect this report keeps finding. Fix: `minItems: 1` on the schema plus an
explicit guard.

Three more Mediums here: `browser_diff` silently substitutes the most-recent state as baseline when
`sinceActionId` has been evicted from the 60-entry timeline, so the response looks like a normal
diff over a window that was never used; `pdf.ts:42-57` matches page formats case-sensitively, so
`format: "letter"` silently renders A4 while the response echoes back `"letter"`; and
`browser_save_pdf` overwrites an existing artifact of the same name with no check, discarding the
earlier PDF. Worth noting the reviewer explicitly *cleared* two suspicions here — `page.pdf()`
buffers fully before writing (no partial-write risk) and `sanitizeArtifactName` strips separators
(not path-traversable).

**`copilot-catalog-session-refresh.ts:270` — a module that documents its invariant and then breaks
it.** *Medium, verified.* Line 17 states *"At most one in-flight refresh per basePath."* Line 270:
```ts
const runPromise = withTimeout(runCopilotCatalogRefresh(options), timeoutMs, timedOutResult)
  .finally(() => { inFlightRefreshes.delete(basePath); });   // ← chained on the WRAPPER
```
`withTimeout` settles at the 10s deadline regardless of the inner promise, so the de-dup entry is
deleted while the real refresh is still running. The next caller sees an empty map (and
`lastRefreshedAtByBasePath` still unset, since the first attempt never got to write it) and starts
a second concurrent refresh; the two then race to write the snapshot, last-writer-wins, possibly
with staler inputs. Fix is to attach `.finally` to the work promise and register *that* in the map.
Same file, also Medium: `withTimeout`'s rejection handler collapses *any* rejection into the
`onTimeout` value, so a TypeError inside the refresh is reported to diagnostics as
`reason: "timeout"` — a crash disguised as a benign, expected condition.

**`pi-ai/.../oauth/kimi-coding.ts:120-142`** · *Medium.* `expires: Date.now() + expiresIn * 1000`
with no clock-skew margin, while both sibling providers — `anthropic.ts` (this report's verified-sound
OAuth reference) and `github-copilot.ts` — subtract a 5-minute buffer. Since `index.ts:153` gates
refresh on `Date.now() >= creds.expires`, a token fetched microseconds before expiry goes out on
the wire and 401s server-side instead of triggering a proactive refresh. The sibling asymmetry, in
the one place this report had previously held up as sound — the reference itself is still fine; the
provider next to it just never copied the buffer. `copilot-models.ts` reviewed clean: auth hashing,
`redactSensitive`, guarded `JSON.parse`, and commit-after-success ordering all check out.

**`agent-session-compaction.ts:38-39` — manual compaction loses the turn's last message.** *High,
verified.* The same two operations appear at three sites; two order them correctly and one does not:
```
navigation.ts:64,70    settle (awaits host.abort() at :42)  →  disconnectFromAgent()   ✓
navigation.ts:133,134  settle                               →  disconnectFromAgent()   ✓
compaction.ts:38,39    disconnectFromAgent()                →  await host.abort()      ✗
```
`handleAgentEvent` is the only thing that calls `sessionManager.appendMessage`. Disconnecting first
means the message the agent finalizes *during* the abort is never persisted. Compaction then
rebuilds from `getBranch()` — which lacks it — and assigns the result over
`host.agent.state.messages`, destroying the in-memory copy that still had it. Calling `compact()`
mid-turn therefore silently drops the closing assistant message from both the persisted session and
the live context. One-line fix: swap the two statements to match the navigation siblings.

Same file, Medium: `appendCompaction(...)` returns the new entry's unique id and the return value is
discarded; the code re-finds the entry with
`newEntries.find(e => e.type === "compaction" && e.summary === summary)`, which returns the
**oldest** match. An extension supplying structured compactions with a fixed template `summary`
(natural when the payload lives in `details`) makes every compaction after the first fire
`session_compact` with the stale entry — wrong id, timestamp, and details. Duplicated at `:379-387`.
`agent-session-prompt.ts` reviewed clean: retry/backoff bookkeeping, dual latency tracking, and the
ISO-vs-epoch timestamp comparisons all check out.

**`session-manager-list.ts:27-36` — two different projects can share one session directory.**
*High, verified empirically.*
```ts
const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
```
Separators become hyphens, so a hyphen already in a directory name is indistinguishable from a
nesting boundary. The mapping is not injective. Executed:
```
/Users/mike/foo-bar   →  --Users-mike-foo-bar--
/Users/mike/foo/bar   →  --Users-mike-foo-bar--     collide: true
/a/b-c/d              →  --a-b-c-d--
/a/b/c-d              →  --a-b-c-d--                collide: true
```
Both projects then read and write the same session directory: each other's sessions appear in the
picker, are resumable across projects, and can overwrite one another on colliding `.jsonl`
filenames. Kebab-case project names are the norm, so this is ordinary rather than exotic. Fix: append
a short hash of the resolved cwd to the readable suffix.

Three Mediums alongside it. `isValidSessionFile:65-78` calls `closeSync(fd)` only on the success
path, so a stray directory named `*.jsonl` makes `readSync` throw `EISDIR` and leaks the descriptor
on every session-list refresh — needs `finally`. `buildSessionInfo:149-166` accepts a header on
`type === "session"` alone, while the two sync validators in the same file also require
`typeof header.id === "string"`; the async path feeding the session picker therefore admits records
whose `id` is `undefined` despite the type declaring `id: string` — the sibling asymmetry once more.
And `/share` (`slash-command-handlers.ts:304-326`) registers `close` but no `error` handler on the
`gh gist create` spawn, so a spawn failure — where Node fires `error` and never `close` — leaves the
promise unsettled and the "Creating gist…" loader hanging forever; it also writes to a fixed
`<tmpdir>/session.html`, which collides between concurrent invocations and is symlink-attackable on
a shared machine. `tool-definition-wrapper.ts` reviewed clean, and the reviewer correctly declined
to report its `ctxFactory?.() as ExtensionContext` cast after confirming no current caller can reach
it with `undefined`.

### ⚠️ C34 — `edit` silently rewrites the whole file, and the diff preview hides it (Critical, verified)

`pi-coding-agent/src/core/tools/edit-diff.ts:209-212, 246, 259`. The most damaging finding of the
continuation sweep: a code-editing tool that corrupts untouched parts of the file and conceals it
from the review surface.

```ts
const initialMatches = normalizedEdits.map((e) => fuzzyFindText(normalizedContent, e.oldText));
const baseContent = initialMatches.some((match) => match.usedFuzzyMatch)
  ? normalizeForFuzzyMatch(normalizedContent)   // ← the ENTIRE file, not the matched region
  : normalizedContent;
...
let newContent = baseContent;                    // :246 — edits spliced into the normalized copy
return { baseContent, newContent };              // :259 — and the diff is base → new
```

If **any one** edit needs fuzzy matching — the model typed a straight quote where the file has a
curly one, or omitted trailing whitespace — the whole document is pushed through
`normalizeForFuzzyMatch`: trailing whitespace stripped from every line, every smart quote/dash/
special space flattened to ASCII, NFKC applied throughout. `edit.ts` then writes that content
to disk.

**The concealment is the worst part.** The diff is generated from `baseContent` → `newContent`, and
`baseContent` is *already* the normalized copy. So the preview shows only the intended edit. A
Markdown hard line break (two trailing spaces), an intentional em-dash in docs, a curly quote in a
localization string — all destroyed silently, in a diff that looks clean.

**Root cause is another dead guard field, the second one this sweep.** `FuzzyMatchResult` carries
`contentForReplacement`, documented at `:92` as the per-match replacement basis and populated at all
three return sites (`:105`, `:120`, `:132`) — and **never read anywhere in the codebase**. The
per-match scoping it exists to enable was never wired up, so the multi-edit path fell back to
normalizing the entire document. Exactly the shape of `frameContext` in `browser-tools/refs.ts`:
the data for the correct behaviour is collected and thrown away. Fix: map each fuzzy match's range
back to offsets in the real content and splice into that, never into a normalized whole-file copy.

Same file, Medium: `countOccurrences:141-145` counts with `split()`, which misses overlapping
matches — `"foofoofoo"` with `oldText: "foofoo"` counts 1, so the "must be unique" ambiguity check
passes on genuinely ambiguous input. Use `indexOf` advancing by 1.

### Reviewer disagreement, adjudicated: `ls.ts` path traversal is NOT a finding

Two reviewers in this sweep reached opposite conclusions about `resolveToCwd`. The `ls.ts` reviewer
filed absolute-path and `..` traversal as **Critical**; the `grep.ts`/`find.ts` reviewer explicitly
declined to report it, on the grounds that it is the consistently-applied design rather than a
divergent sink. **I checked, and the second reviewer is right.**

`getCwdRelativePath` — the containment helper the Critical proposes using — exists at
`utils/paths.ts:87` and is used as an actual containment check in exactly **one** place in the
repo: `utils/windows-self-update.ts:41`. No tool uses it. There is no containment design for the
coding-agent tools to have violated, and reading outside the cwd is intentional for a local coding
agent — editing `~/.config` or referencing a sibling repo are ordinary operations. The model here is
the user's own agent, not a remote attacker.

Recorded because the disagreement itself is informative: "unvalidated path" is only a finding
relative to a threat model, and this repo has two path-handling worlds — the GSD tools (where
identifiers *are* trusted input into a state store, and the 8 confirmed sinks stand) and the
coding-agent tools (where filesystem reach is the product). Do not "fix" the latter by copying the
former's rules.

Three Mediums remain in `ls.ts`: `"(empty directory)"` is returned when every entry failed `stat`
(a permission-denied or broken-symlink directory reads as empty) and also when `limit: 0` truncates
everything away — with the truncation notice suppressed on that path; `readdir` materializes and
locale-sorts every entry before the 500-cap is applied, so the cap bounds display but not cost; and
the abort listener rejects the promise without stopping the in-flight stat loop, which runs on
uncancelled.

**`ollama-tool.ts:103-139` — a failed model pull reports success.** *High, verified.* Ollama's
`/api/pull` signals failure **in-stream** with `{"error": "..."}` under HTTP 200, not via a rejected
promise. The progress handler has exactly two branches:
```ts
if (progress.total && progress.completed) { … }
else if (progress.status && progress.status !== lastStatus) { … }
// { error: "pull model manifest: file does not exist" } matches NEITHER — dropped silently
...
return { content: [{ type: "text", text: `Successfully pulled ${model}` }] };   // unconditional, no isError
```
`ollama_manage({action: "pull", model: "does-not-exist:latest"})` therefore tells the agent the
model was pulled, and it proceeds to use a model that isn't there. Same file, Medium: the `show`
action dereferences `info.details.family` on unvalidated external JSON, so a response without
`details` yields a raw `TypeError` instead of an actionable error.

**`shell-output.ts:68-72` — a stale async guard spawns orphaned temp files.** *High, verified, and
the correct pattern is four lines above it.*
```ts
const appendFullOutput = (text: string): void => {
  if (!fullOutputPath || captureError) return;
  const path = fullOutputPath;              // ← reads it synchronously. Correct.
  writeChain = writeChain.then(async …);
};
const ensureFullOutputFile = (initialContent: string): void => {
  if (fullOutputPath || captureError) return;      // ← guard
  writeChain = writeChain.then(async (previous) => {
    const tempFile = await env.createTempFile(…);
    fullOutputPath = tempFile.value;               // ← …only set AFTER the await
```
Every chunk arriving while `createTempFile` is in flight re-passes the guard and queues another
temp file. A verbose build crossing the 50KB threshold leaves N orphaned temp files on disk, and
which one wins is nondeterministic — under a heavy burst the winner can miss content already
evicted from the rolling buffer. Fix: set a `requested` flag synchronously. Same file, Medium: the
rolling buffer adds `text.length` (UTF-16 units) to a counter compared against a constant named and
documented in *bytes*, while `totalBytes` alongside it correctly uses `encoder.encode().byteLength`
— so CJK or emoji output overshoots the intended 100KB cap by 3-4×.

**`bg-shell/overlay.ts:121-135` — restart silently re-points the selection at another process.**
*High.* `restartProcess` deletes the old id from the `processes` Map and re-inserts under a new one;
JS Maps preserve insertion order, so the restarted entry moves to the end and everything after it
shifts down. `this.selected` is never re-anchored. Restart B in [A, B, C] → list becomes [A, C, B']
→ index 1 is now C, so the next `x`/`d` keypress kills an unrelated process. Same file, Medium:
`box()` calls `"─".repeat(width - 2)` with no floor, and `compositeOverlays` clamps width to a
minimum of **1**, so a very narrow pane throws `RangeError` out of every render path.

**`commands/handlers/onboarding.ts:94-104`** · *Medium.* One `try` wraps both the dynamic
`import()` and the `runProviderDoctor(ctx)` call, so a genuine failure inside the doctor is
swallowed and replaced with a generic `"info"` notice — indistinguishable from the feature simply
being unavailable, and any partial side effects go unreported.

**`async-jobs/await-tool.ts:98-105` — a race decided before it starts.** *High, verified.*
```ts
const abortPromise = new Promise((resolve) => {
  if (!signal || signal.aborted) { resolve(ABORT_SENTINEL); }   // ← runs SYNCHRONOUSLY
  else { abortListener = () => resolve(ABORT_SENTINEL); signal.addEventListener("abort", …); }
});
const raceResult = await Promise.race([ completion, timeoutPromise, abortPromise ]);
```
The executor body runs during construction, so when `signal` is `undefined` `abortPromise` is
**already settled before `Promise.race` is reached** and wins deterministically. `await_job`
returns `"Wait interrupted."` in about a millisecond no matter what `jobs` or `timeout` were
passed, including for jobs a second from finishing. The `!signal` test proves undefined was
anticipated — it is simply handled backwards: no signal means *nothing can ever abort*, so that
promise should stay pending forever and let completion or timeout decide. One-character class of
fix: `signal?.aborted`, with the listener branch gated on `signal`.

Same file, two Mediums: `await_job(["good_id", "stale_id"])` computes `notFound` and then drops it
whenever at least one id resolved, so the model is never told an id didn't exist and can re-poll a
phantom job indefinitely; and `timeout` has no upper bound, so `timeout: 3000000` produces a
`setTimeout` delay past Node's 32-bit `TIMEOUT_MAX`, which clamps to 1 ms and reports a timeout
instantly — the exact opposite of the request.

**`bootstrap/schedule-wakeup-tool.ts:19-33`** · *Medium.* The pending-wakeup map is keyed on base
path alone, so two sessions in the same directory clobber each other's timer via `clearTimeout` and
the first session's continuation silently never fires. The file's comment claims "concurrent
projects in one host process don't cancel each other" — true only across *different* directories.
`sessionManager.getSessionId()` exists for exactly this and is used by sibling code in `auto.ts`
and `guided-flow.ts`. The reviewer also confirmed what is *not* wrong here: `delaySeconds` bounds
are enforced pre-dispatch by the TypeBox validator, and the seconds→ms conversion is consistent
across both the interactive and auto-mode paths.

**`packages/mcp-server/src/cli.ts:14-19`** · *Medium.* `process.exit(1)` immediately after
`process.stderr.write(...)`. An MCP server runs with stderr piped, where Node's writes are async,
so under backpressure the fatal diagnostic is lost and the client sees a silent death. 19-line
file, no argv parsing — the sandbox concerns did not apply.

---

## ⚠️ C31 — legacy import silently drops milestone worktree evidence (NEW, Critical)

`legacy-import-preview-worktree.ts:476-497`. Verified end to end.

```ts
for (const file of files) {
  if (!isWorktreeSurface(file, capture)) continue;
  prepareFile(file);                                  // :485 — sets parserId FIRST
  const groupKey = topologyGroupKey(file, capture);   // :486 — returns a CONSTANT
  ...
}
for (const group of groups.values()) {
  if (contributeMigrationState(group, capture, candidates, diagnoses)) continue;
  if (contributeExternalState(group, capture, candidates)) continue;   // ← 3 args, siblings take 4
  if (contributeDuplicateIdentity(group, capture, candidates, diagnoses)) continue;
  if (contributeStaleCanonical(group, capture, candidates, diagnoses)) continue;
  contributeMarkerRoots(group, capture, candidates, diagnoses);        // ← never reached
}
```

Four independent things have to be true for this to lose data, and all four are:

1. **The group key is a constant.** `topologyGroupKey:37-46` returns the literal string
   `"project-topology"` for any file under `.gsd`, `.gsd-worktrees`, `.gsd.migrating`, or
   `$GSD_STATE_DIR`. The `M\d+` milestone id is not part of the key. Every milestone's worktree
   evidence for the entire project lands in **one** group.
2. **Dispatch is first-match-wins.** Each `continue` abandons the whole group. So one anomalous
   milestone claims the group and every other milestone's evidence is never examined.
3. **The safety net is disarmed before it can fire.** `prepareFile:58` sets
   `file.parserId = "gsd-worktree-topology"` as its first statement — before any candidate exists.
   The unclaimed-file guard (`legacy-import-preview-supplemental.ts:68-71`) only throws for files
   still carrying the `UNCLAIMED_PARSER_ID` sentinel, so it never fires for these.
4. **Nothing downstream notices.** A file left at its default `outcome: "mapped"` with zero
   candidates and zero diagnoses passes every check in the pipeline. Confirmed by a dedicated
   trace: every validation runs candidate→source (`composition.ts:243-250`, `:299-308`,
   `preview.ts:526-570`), and **no check anywhere runs source→candidate**. There is no "every
   captured source must be accounted for" invariant.

**Concrete loss:** a project with a healthy `M1` and an `M2` carrying a duplicate-identity alias.
`contributeDuplicateIdentity` claims the shared group for M2 and `continue`s;
`contributeMarkerRoots` — the only function that would have preserved M1's `git-marker.txt` —
never runs. M1 is dropped from the import with no candidate, no diagnosis, no warning, and no
non-zero count anywhere in the preview.

The repo's own test suite half-knows: `tests/legacy-import-preview-knowledge-root-worktree.test.ts:372`
asserts `files.every(f => f.outcome === "preserved")` with the comment *"no milestone marker may
default to mapped without a candidate."* That is exactly this invariant — asserted for one
scenario, never enforced in the library.

**Second defect, same five lines (High).** `contributeExternalState` is called with three
arguments while all four of its siblings get `diagnoses` as a fourth. It structurally cannot
report a problem, so a malformed *external* `git-marker.txt` is skipped silently — where the
identical malformation on the canonical/legacy path correctly produces a `"malformed-git-marker"`
warning via `diagnoseMalformedMarker`. The dominant pattern of this report, visible within a single
five-line block.

**Fix:** run all five contributors unconditionally and let each claim only the files it actually
handles (filter on `file.outcome === "mapped"` inside `contributeMarkerRoots`); pass `diagnoses` to
`contributeExternalState`; and add the missing source→candidate accounting assertion, which would
have caught this class at the seam rather than in a review.

### This qualifies — but does not overturn — the report's "legacy-import is the model" claim

That claim was based on `legacy-import-backup.ts` and `legacy-import-live-restore.ts`, which
reviewed clean and genuinely do verify-before-destroy. Those findings stand. C31 is in a
*different* layer of the same subsystem — preview/interpretation rather than backup/restore — and
it shows the discipline is not uniform across the subsystem. Read the earlier praise as scoped to
the backup/restore path, not to everything under the `legacy-import-*` prefix.

---

## Late batch (last five files, folded in after the sections above)

### ⚠️ New shared-layer root cause — `resolveSlicePath` discards the slice ID

*High, possibly Critical. Verified chain; one link's direction unresolved (stated below).*

This is the most consequential item in the late batch, and it is not a per-file slip — it is a
defect in a shared path helper with **11 call sites**.

```ts
// paths.ts:918-929
const dir = resolveDir(slicesDir, sliceId);
if (dir) return join(slicesDir, dir);   // legacy layout: real per-slice dir
return mDir;                            // flat-phase (DEFAULT): sliceId discarded, never validated
```

Under the flat-phase layout — the default — `resolveSlicePath` returns the **milestone** directory
for *any* slice ID, including one that does not exist. So `existsSync(resolveSlicePath(...))` is
not a slice-existence check; it only proves the milestone exists.

I checked all 11 callers. **`doctor-state-checks.ts` is the only one that knows**, and it
compensates inline with two explanatory comments (`:337`, `:403`) rather than the helper being
fixed. Every other caller null-checks the return (`if (!slicePath) …`), which fires only when the
milestone is unresolvable. The same "one sibling has the guard" pattern as the rest of this report,
now at the shared-helper level.

The worst downstream consequence is in **artifact verification**, a gate:

```
paths.ts:928           flat-phase → resolveSlicePath returns the MILESTONE dir for any sliceId
paths.ts:982-983       → resolveTasksDir joins <milestone>/tasks, absent in flat-phase → null
artifact-verification.ts:310  → the `?? slicePath` fallback therefore ALWAYS fires in flat-phase
                                 → tDir = the milestone directory
paths.ts:325-332       → resolveTaskFiles flat-scans that dir for T##-SUMMARY files
artifact-verification.ts:312  → return summaryFiles.length > 0
```

The question this code intends to ask is *"does this slice have task summaries?"* On the default
layout it cannot ask that, because the slice ID was thrown away four calls earlier.

**What I could not determine, stated plainly:** whether flat-phase projects actually place
`T##-SUMMARY` files in the milestone directory. `paths.ts:978` says flat-phase tasks are
"checkboxes inside plan files," which suggests they may not exist there at all. The two branches:

- If those files **are** present → the check scans milestone-wide and returns true on *another
  slice's* evidence. A verification gate passing on the wrong artifact. Critical.
- If they are **not** → `summaryFiles` is always empty and the check always returns false. A
  verification gate that never passes. Still a defect, opposite direction.

Both are wrong; the severity depends on which, and settling it needs a live flat-phase project.
I did not have one, so I am not going to assert the worse reading. **Fix the root cause either
way:** make `resolveSlicePath` return `null` for an unrecognized slice ID instead of silently
falling back to `mDir`, then fix whichever call sites that newly (and correctly) fail.

**Also note:** this is the third confirmed site of the flat-phase fallback problem, joining the
`doctor-state-checks.ts` entry already in this report. It should be read as a pattern, not three
coincidences.

### Other files in this batch

**`auto/run-unit.ts:254` — ghost-completion check disabled after any wakeup.** *High, verified.*
`const requestDispatchedAt = Date.now()` is captured once, immediately before the first prompt
send. The scheduled-wakeup loop at `:331-373` re-sends the prompt and re-awaits `agent_end` up to
`MAX_WAKEUPS_PER_UNIT` times, sleeping `wakeup.delayMs` each pass, and never refreshes the
timestamp — it is attached as-is to the result at `:394`. The consumer computes
`Date.now() - requestDispatchedAt` (`unit-phase.ts:561,570`) as the elapsed time feeding
`isSuspiciousGhostCompletion`. After a single 10-minute wakeup, a genuinely instant ghost
completion measures as 10 minutes elapsed and passes the check. **This is C30's shape again:** a
value that must reset at a phase boundary, and doesn't. Fix: reassign before each send inside the
wakeup loop, or thread a per-send timestamp through.

**`auto/task-execution-cutover.ts:625-626` — publication guard cannot tell approved from rejected.**
*High, reachability unconfirmed.*
```ts
const publicationReplayCandidate = attempt?.state === "settled" &&
  attempt.outcome === "succeeded" && attempt.nextStage === "settled" &&
  (deps.readTaskLifecycleStatus ?? readTaskLifecycleStatus)(task) !== "ready";   // ← cross-checks
const resolvedHumanReviewCandidate = attempt?.state === "settled" &&
  attempt.outcome === "succeeded" && attempt.nextStage === "route";              // ← cross-checks nothing
```
The sibling branch one line up consults external lifecycle state; this one accepts on attempt
stage alone. `VerifiedTaskPublicationDeps` exposes no way to read blocker status, so an open,
a `dismissed` (explicitly rejected), and an approved `subjective_uat` blocker are indistinguishable
here — all three publish the task complete. **Caveat, stated plainly:** I checked both in-repo call
sites (`loop.ts:1286`, `:2015`) and neither reaches this branch — the retry and manual-attention
paths `break`/`continue` first, so a same-turn call arrives at the `verify` stage and matches
`isTaskAttemptAwaitingVerification` instead. So I could not demonstrate a live path. The branch
exists because something needed it (resume/replay), and it is also reachable through the
`deps.taskPublicationBoundary` override. Treat as *weak guard, unproven reachability* — worth
tightening, not worth panicking over. This is the same judgement I applied to the retracted C13:
plausible shape is not proof.

**`auto/run-unit.ts` (2nd)** · *Medium.* Provider-readiness pre-check wraps
`registry.isProviderRequestReady()` in `catch { ready = false }` with no logging, so a programmer
error inside the readiness check is reported to the loop as a non-transient "login/token expired",
which takes the hard-pause branch and points the user at their credentials. Add a `debugLog` in
the catch.

**`interactive/components/session-selector.ts:912` — stale-read guard written for one scope, disabled
for the other.** *2 High, 4 Medium.*
```ts
private allLoadSeq = 0;                                          // :694 — no currentLoadSeq exists
const seq = scope === "all" ? ++this.allLoadSeq : undefined;     // :912
if (seq !== undefined && seq !== this.allLoadSeq) return;        // :919/:938/:955 — short-circuits
```
The sequence guard that discards stale async results is implemented for the `"all"` scope and
explicitly passed `undefined` for `"current"`, which makes all three checks no-ops on that path.
Back-to-back delete/rename issues concurrent `loadScope("current", …)` calls; a slower earlier read
can land after a faster later one and overwrite fresher state — reintroducing a just-deleted
session into the list. Second High: an unhandled promise rejection on the rename path. Fix is
three lines: add `currentLoadSeq` and pick the counter by scope.

**`db/writers/authority-recovery.ts` — clean.** Worth recording *why*, because it is a second
instance of the report's central claim. The reviewer traced CAS/authority fences against their
construction sites, confirmed every mutation applier asserts exactly one affected row (no silent
0-row success), confirmed every writer runs inside `executeDomainOperationCore`'s
`immediateTransaction` so any throw rolls the whole operation back, and manually replayed the
`[...plan.targets].reverse()` ordering against the instruction assembly order to confirm revert
really does restore parent-first and delete child-first. Nothing found. **This is what the worktree
subsystem is missing** — not knowledge, just application.

---

## Clean files

Reviewed thoroughly, zero findings — worth noting because they show the codebase's own good
patterns: `legacy-import-backup.ts` (3,267 lines), `legacy-import-live-restore.ts` (1 Medium only),
`auto-verification.ts`, `milestone-lifecycle.ts`, `plan-task.ts`, `task-settle.ts`,
`task-recovery.ts`, `progress-from-db.ts`, `commands/handlers/core.ts`,
`project-authority-cutover-domain-operation.ts`, `db-lifecycle-foundation-schema.ts`,
`db/writers/authority-recovery.ts`, `bg-shell/index.ts`, `commands/handlers/copilot-models.ts`,
`agent-session-prompt.ts`, `tool-definition-wrapper.ts`, and **all five DB schema files**
(`db-base-schema.ts`, `db-attempt-recovery-schema.ts`, `db-conversation-foundation-schema.ts`,
`db-projection-import-kernel-closeout-foundation-schema.ts`,
`db-recovery-evidence-foundation-schema.ts`).

### The SQL layer is rigorous. The TypeScript layer above it is where the bugs are.

This is the clearest structural conclusion of the whole scan, and it rests on three independent
results rather than an impression:

1. **The C13 retraction.** Two reviewers independently reported "lifecycle transitions are never
   validated" as Critical/High. Both were wrong: `trg_workflow_lifecycle_transition` enforces the
   full status allow-list *plus* `state_version = OLD+1`, strictly increasing
   `last_project_revision`, and a changed `updated_at`. The database was doing the job the
   TypeScript appeared to skip.
2. **`db/writers/authority-recovery.ts` — clean.** CAS/authority fences consistent with their
   construction sites, every mutation applier asserting exactly one affected row, every writer
   inside a rolling-back transaction.
3. **All five schema files — clean.** Every `CREATE` guarded with `IF NOT EXISTS`; ~20 composite
   `(operation_id, project_id, revision, epoch)` FKs checked for column-order correctness; every
   `OLD.x != NEW.x` comparison checked against nullability for `IS NOT` swallowing; trigger firing
   order verified to close an apparent bypass. Multiple leads chased and each one refuted by an
   existing constraint.

Every Critical in this report lives in TypeScript. Not one is in SQL. Two practical consequences:

- **When TS and SQL appear to disagree about an invariant, read the schema before believing the
  reviewer.** This is the specific mistake that produced the C13 false positive, and reviewer
  agreement did not catch it — both agents shared the blind spot.
- **The team already knows how to express invariants declaratively and does it well.** Several
  findings here — the unvalidated identifier sinks, the missing source→candidate accounting in
  C31, the actor-identity asymmetry in `slice-lifecycle-domain-operation.ts` — are invariants that
  could be pushed down into the layer that has a demonstrated track record of holding them.

---

**The legacy-import subsystem is the model.** Two thorough reviews, essentially zero findings:
verify-before-destroy, independent re-derivation on a fresh read-only connection, identity re-checks
around every read, consent bound into the intent hash. The worktree subsystem does equally
destructive things with none of it. This is not a codebase that lacks the right patterns — it
applies them rigorously in one place and barely at all next door.

---

## Process recommendation

No `noUnusedLocals`/`noUnusedParameters` in any of the 10 tsconfigs, and no lint step (only
`tsc --noEmit`). That is mechanically why a never-called guard function (`hasAdoptedMilestoneHistory`)
and two orphaned imports (`getSlice`, `getSliceTasks`) — the direct evidence of a dropped
verification — survived four commits of churn and code review. Enabling two compiler flags would
have caught both.
