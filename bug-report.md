# Bug Report — gsd-pi

Deep semantic review, one subagent per file, max 10 concurrent. Every Critical below was
independently re-verified by me against the source before inclusion.

> ## ⚑ Adversarial re-verification pass (second review)
>
> Every Critical and every load-bearing High in this report was subsequently re-checked against
> the source by eight independent adversarial verifiers whose instruction was to **refute** the
> claims, not confirm them. Results are folded in below, and each affected entry now carries a
> `[re-verified]`, `[qualified]` or `[REFUTED]` marker.
>
> **Headline outcomes:**
>
> | | |
> |---|---|
> | Criticals confirmed as written | 14 |
> | Criticals confirmed but narrowed | 11 |
> | Criticals materially wrong or overstated | 5 (C1, C3, C4, C10, C28) |
> | Highs refuted outright | 3 (`db-provider` handle leak, `await_job` abort race, `find.ts` empty-line slice) |
> | This report's own prior corrections that were themselves wrong | 2 (the `removeWorktree` "⛔ CORRECTION" block; "The single highest-leverage fix") |
> | New Criticals found that this report missed | 2 (both in `get-secrets-from-user.ts`) |
> | Open question resolved | flat-phase `resolveSlicePath` — resolved in the **Critical** direction |
>
> **Report-integrity problems found in this document itself:**
>
> - The Scan Summary claims **32 Critical**. Only **30** exist. C18 and C19 appear nowhere —
>   not as findings, not as retractions. C13 and C29 are properly accounted for; C18/C19 are an
>   unexplained numbering gap presented as if complete.
> - "**All five DB schema files — clean**" is a coverage claim over **5 of 24** schema files.
>   Worse, `db-milestone-completion-schema.ts` — not reviewed — does
>   `DROP TRIGGER IF EXISTS trg_workflow_lifecycle_transition` and **recreates it**. The C13
>   retraction, this report's headline methodological lesson, therefore quotes the *superseded*
>   definition. (The conclusion survives: the v43 replacement is stricter, requiring a matching
>   `milestone.complete` operation row, and `trg_workflow_lifecycle_causal_provenance` still owns
>   the revision-monotonicity case the v43 `WHEN` clause factors out. But the evidence cited is
>   the wrong trigger, which is exactly the error the retraction was written to warn about.)
> - "Coverage: complete / Still unreviewed: 0" cannot be squared with the above.
>
> **23 GitHub issues** were filed from the confirmed findings: eagle27272/gsd-pi#4 through #26.

## Scan Summary

| | |
|---|---|
| **Mode** | Full scan (`git_ref=all`), Tier 1 + grep-hot subset |
| **Codebase** | 1,442 source `.ts` files / 478k LOC (tests, fixtures, examples, `dist`, `pkg`, `node_modules`, `.d.ts` excluded) |
| **Review set agreed** | 150 files / 106k LOC |
| **Files reviewed** | **195** — the agreed 150-file review set is **complete**, plus ~45 targeted follow-ups |
| **Still unreviewed** | **0** |
| **Findings** | **~407** — ~~32~~ **30** Critical (C18/C19 do not exist), 219 High, 174 Medium. After re-verification: 2 Criticals refuted or reduced to non-findings (C3, C10), 3 materially overstated (C1, C4, C28), 2 new Criticals added (NEW-C35, and the flat-phase `resolveSlicePath` promotion) |
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
| **`atob` on base64url breaks login ~100% of the time** (Critical) | **Downgraded to Medium — and on re-verification, further to Low.** The mechanism was stated incompletely and the numbers do not reproduce. See the corrected entry below. |
| **`gsd_execute` escapes the MCP sandbox** (Critical) | **Qualified.** `validateProjectDir` returns early with no containment unless `GSD_WORKFLOW_PROJECT_ROOT` is set. There is no sandbox by default; the bypass matters only in a hardened deployment. |

### Corrected: the `atob` entry (re-verification)

Two things were wrong. **The trigger set is larger than stated:** for pure-ASCII input, base64url can
only emit `-`/`_` when a byte at position ≡ 2 (mod 3) is one of `>`, `?`, `~`, or DEL — the report
named only `?` and DEL. (Sextets 0–2 max out at 31, 55 and 61 respectively; only sextet 3, which is
`b2 & 63`, can reach 62/63.)

**The numbers do not reproduce.** The "2000/2000 query-string-bearing" figure is payload-dependent —
I measured 1010/2000 on a payload with one `?`, consistent with the 1-in-3 triplet-alignment odds.
More importantly, it was measured against the wrong shape. The real sinks are OpenAI Codex JWTs:

- `packages/pi-ai/src/utils/oauth/openai-codex.ts:85` — `decodeJwt`, wrapped in try/catch returning `null`
- `packages/pi-ai/src/providers/openai-codex-responses.ts:1321` — `extractAccountId`, throws a clear
  `"Failed to extract accountId from token"`

On 2000 realistic Codex-shaped payloads (URL-valued claims, account ids, plan type), **0/2000** contain
`-` or `_`. And `packages/pi-ai/src/utils/oauth/anthropic.ts:27` is **not a JWT sink at all** — it
decodes a hardcoded, obfuscated client ID, so it cannot fail on user data.

**Corrected severity: Low.** It fires only if a claim value contains `>`, `?`, `~` or DEL at a
triplet-aligned offset, and both sinks degrade gracefully rather than corrupting state.

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
teardown on success; surface `conflicts`. → eagle27272/gsd-pi#6

> **[re-verified — with two mitigations the write-up omits].** The guard is `/['";\x00]/` and the
> apostrophe case is confirmed; all four call sites are bare expression statements; no outer
> path-character guard exists anywhere.
>
> 1. **An error *is* logged.** `reconcile.ts:110` calls
>    `logError("db", "worktree DB reconciliation failed: path contains unsafe characters")`. It is the
>    *command surface* that reports success, not the DB log. "while logs report success" overstates it.
> 2. **One caller is backstopped.** `auto-worktree-merge-db-ready.ts` follows the reconcile with
>    `assertAdoptedMilestoneCompleted` (`:140`) and `assertCloseoutProof` (`:141`), so an un-merged
>    milestone normally fails the project-DB completion check and throws.
>
> **The genuinely unguarded loss is `auto-worktree-teardown.ts:93`**, which swallows the zero result
> and proceeds to "3. Remove the worktree" a few lines later.
>
> Adjacent: `reconcile.ts:113` does `if (!getDbOrNull()!)` — a non-null assertion on the value being
> tested for falsiness — and `:120` uses a double assertion `getDbOrNull()!!`. If the open at `:114`
> "succeeds" with a still-null handle, the next line throws a raw `TypeError` caught at `:729` and
> converted into *another* silent zero-count return.

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
→ eagle27272/gsd-pi#7

> **[re-verified — and the blast radius is larger than described].** Every anchor matches (the clear
> trio is `pre-dispatch.ts:423-425`, off by one from the write-up). `autoSession` is a module
> singleton (`auto-runtime-state.ts:26`), so the field survives the whole process, and no write of
> `false` exists outside tests. `pre-dispatch.ts:392-447` confirms >1 milestone per session is the
> normal path.
>
> **Every recovery path is suppressed too, not just the merge.** `milestone-settlement.ts:31` —
> `if (!input.milestoneId || input.milestoneMerged) return false;` — makes
> `evaluateAllCompleteSettlement` return `{ok: true, reason: "settled"}` on the stale flag, so the
> orchestrator's `mergePendingCompleteMilestone` fallback (`orchestrator.ts:1312-1313`) never fires;
> and `auto.ts:1778`'s stopAuto fallback merge is gated on `!s.milestoneMergedInPhases` as well. So
> milestone 2+ has **no in-session merge recovery at all**, and `emitAutoExit` (`auto.ts:1704`)
> reports `milestoneMerged: true` for the stranded milestone.

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
callers are never told.

> ### ⛔ SECOND CORRECTION — the boolean means the opposite of what this report said
>
> This report previously stated that `removeWorktree` "signals quarantine by returning `false`",
> and recommended making three call sites match `handleRemove`. **Both halves are wrong.**
> Re-verified at `worktree-manager.ts:1015-1021`:
>
> ```ts
> 1015      if (!quarantinePath) {
> 1016        return false;              // quarantine FAILED — original worktree preserved
> 1017      }
> 1018      deleteBranchAfterRemoval = false;
> 1019      if (!existsSync(resolvedWtPath)) {
> 1020        nativeWorktreePrune(basePath);
> 1021        return true;               // quarantine SUCCEEDED — reported as ordinary success
> ```
>
> `quarantineDirtyWorktree` (`:265-335`) returns the quarantine path on success and `null` only when
> both `renameSync` and `cpSync` fail. So `false` means the quarantine *failed*, and a **successful**
> quarantine returns `true` — indistinguishable from an ordinary removal.
>
> Consequently `handleRemove` is **not** the correct template. It checks the boolean, but that only
> catches the rare failure branch; on a successful quarantine it prints a plain
> `Removed worktree <name>.` with no mention that the tree was moved to
> `.gsd/quarantine/worktrees/<name>-<ts>/`. The user only learns via `logError` at `:329`.
> **Successful quarantine is invisible to all four call sites.**
>
> **Actual fix:** have `removeWorktree` return the quarantine path (or a result object), not a bare
> boolean, and surface it everywhere.

The four call sites in `commands-worktree.ts` (anchors corrected on re-verification):

| Call site | Return checked? | What the user is told |
|---|---|---|
| `handleMerge` :168 | ✗ | `"Removed empty worktree …"` |
| `handleMerge` :225 | ✗ | full `"Merged … → main"` success block |
| `handleClean` :258 | ✗ | listed under `Removed:` in the summary |
| `handleRemove` :318-330 | ✓ (failure branch only) | warns on quarantine *failure*; silent on success |

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
**Fix: three added lines.** → eagle27272/gsd-pi#8

> **[re-verified — and *more* severe than written].** The 18 call sites are
> `147, 178, 190, 205, 408, 418, 808, 955, 1070, 1079, 1115, 1167, 1237, 1246, 1260, 1491, 1509, 1528`;
> set-differencing against the 15 `env:` lines confirms exactly those three omissions, with no
> wrapper or shared options object supplying it.
>
> **But calling them "fallbacks" is wrong.** `native-git-bridge.ts:20` reads
> `const NATIVE_GSD_GIT_ENABLED = process.env.GSD_ENABLE_NATIVE_GSD_GIT === "1";` and `loadNative()`
> short-circuits at `:125` returning `null` unless that is set. Native git is **opt-in and off by
> default** (issue #453 deliberately keeps auto-mode bookkeeping on the CLI path). These three
> unscrubbed calls are what runs on *every* invocation.
>
> One nuance the "proof by adjacency" gets slightly wrong: `nativeCheckoutNewBranch` at `:1079` has
> no native branch at all, so it is the sole implementation rather than a peer fallback. The
> inconsistency it demonstrates still holds.

### Related root cause — failure indistinguishable from "nothing found"

Read helpers call `gitExec(..., allowFailure=true)`, collapsing "git failed" into the same
falsy value as "found nothing". Most callers fail closed. These fail **open**, into
data-loss guards:

- `nativeWorktreeList` → `[]` → `doctor-git-checks.ts` `rmSync`s every worktree (**C22**)
- `nativeWorkingTreeStatus` → `""` → the documented *"final data-loss check before deleting a
  merged milestone worktree"* reads it as clean
- `nativeHasChanges` → `false`, **cached 10 s** → `GitService.autoCommit` returns early and the
  completed unit's work is never committed
- `nativeBranchExists` → `false` → defeats the TOCTOU guard (#4980 HIGH-3) before
  `nativeBranchForceReset`, orphaning concurrent commits

> **[re-verified, two corrections].**
>
> **Count.** Not "~17 read helpers" — **40 `allowFailure` call sites across 33 distinct functions**,
> of which **~20 are read helpers**. The rest are intentional best-effort writes (`merge --abort`,
> `worktree prune`, `update-ref -d`).
>
> **`nativeHasChanges` is mitigated on the path that matters.** `auto-post-unit.ts:1420-1423` calls
> `_resetHasChangesCache()` immediately before auto-commit, with a comment naming this exact hazard
> (#1853), and `git-service.ts:1038-1040` invalidates again after a successful commit. The residual
> is narrower: the post-invalidation *fresh* probe at `git-service.ts:1011` still routes a genuine
> `git status --short` failure through `allowFailure` into `false`, and `autoCommit` returns `null`
> with no error. Callers `quick.ts:381/458` and `commands-workflow-templates.ts:465/638` do not reset
> the cache and can still see a stale `false`.
>
> **`nativeBranchExists` is a design gap, not a careless `true`.** The fallback is
> `gitExec(basePath, ["show-ref","--verify",…], true)` at `:287`, and `git show-ref --verify` exits
> non-zero for the ordinary "ref does not exist" case — so `allowFailure` is *required* for
> correctness here. Distinguishing absent (exit 1) from broken (exit 128) needs the exit code, not a
> boolean. The TOCTOU consequence at `auto-worktree-branch-lifecycle.ts:139` is exactly as described.
>
> **Missed, same shape:** `stageUntrackedExcludingDotGsd` (`native-git-bridge.ts:881`, site `:888`)
> derives its staging set from `gitFileExec(basePath, ["status","--porcelain=v1","-z"], true)`; a
> swallowed status failure yields an empty parse and stages nothing.

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

### ⛔ RETRACTED — "The single highest-leverage fix"

**This section was wrong in three places and is retracted.** It previously claimed a four-file
compound chain: recycled PID → `isWorkerProcessAlive()` misjudges liveness → milestone lease granted
while the original worker still runs → `settleStaleActiveDispatchForUnit` cancels its RUNNING dispatch
→ `markCompleted` no-ops → outcome silently dropped, work duplicated.

**1. The causal direction is inverted.** PID recycling produces a **false positive** — a dead worker
that looks alive. Every consumer in this codebase reads "alive" as *do not reclaim / do not recover*:
`canReclaimLease` returns `false` (`task-settle.ts:118`), `isDeadLocalAutoWorker` returns `false`
(`db/auto-workers.ts:286`), `findStaleWorkerForProject` returns `null` (`:317`, `:329`, `:345`).
All fail **closed**. The symptom is a stalled milestone awaiting TTL expiry, not a double grant. To
grant a lease while the original worker still runs you need the opposite error — a live process judged
dead — which `process.kill(pid, 0)` does not produce locally.

**2. The lease grant never consults `isWorkerProcessAlive`.** `claimMilestoneLease`
(`db/milestone-leases.ts:74-193`) gates takeover at `:141-152` on
`status IN ('expired','released') OR datetime(expires_at) < datetime('now')` or a re-entrant
same-host-same-pid row, all inside a `transaction()` with a `changes === 1` confirmation at `:160-165`.
`recordDispatchClaim` then re-reads the lease as `status = 'held'` with a matching fencing token
(`db/unit-dispatches.ts:180-191`) and returns `{ok: false, error: "stale_lease"}` otherwise — before
`settleStaleActiveDispatchForUnit` is reachable at all. The partial unique index
`idx_unit_dispatches_active_per_unit` (`db-coordination-schema.ts:102`) is a third, DB-level backstop.

**3. `markCompleted` does check its rowcount.** `db/unit-dispatches.ts:309-314` reads `changes` and
does `if (changes < 1) return false;`, and `settleDispatchCompleted`/`settleDispatchIfNeeded`
(`auto/workflow-dispatch-ledger.ts:38-48`, `:16-21`) thread that boolean back so an unsettled dispatch
is retried at `loop.ts:2033`. The silent-drop claim holds at exactly one call site —
`auto/orchestrator.ts:1689`, which discards the boolean while `recordCompletedCloseout` proceeds — and
because `markCompleted` returns before `insertAuditEvent` on a no-op, that path leaves no audit trace.

**4. The heartbeat is already consumed.** `isAutoWorkerLive` (`db/auto-workers.ts:255-261`) — the
function `canReclaimLease` actually calls — parses `last_heartbeat_at` and rejects on
`heartbeatAt < Date.now() - HEARTBEAT_TTL_SECONDS*1000` **before** delegating to
`isWorkerProcessAlive`. There is no `Pick` to widen at that site.

### What the real high-leverage fix is → eagle27272/gsd-pi#16

**`crash-recovery.ts:316-327` — `isLockProcessAlive` has no host check, and `LockData` carries no
`host` field at all.** A lock written by PID 1234 on host A, evaluated on host B, resolves purely
against host B's process table. *That* is the fail-open direction — a live remote holder judged dead —
and it feeds takeover at `auto.ts:1071/1110/1154`, `auto-start.ts:1063`, `doctor-proactive.ts:242`,
and `migrate/safety.ts:190`.

The contrast is instructive: `db/auto-workers.ts:243` has `if (candidate.host !== hostname()) return false;`
and its primary caller gates on heartbeat freshness first. `crash-recovery.ts` has neither guard.

**One place where the `Pick` argument *does* hold**, and which this report missed:
`findStaleWorkerForProject`'s first query (`db/auto-workers.ts:308-317`) selects on status scope alone
with **no heartbeat cutoff**, unlike the two queries below it, and relies entirely on
`!isWorkerProcessAlive(latestActiveRow)`. Widening the `Pick` there and short-circuiting on a lapsed
TTL is worthwhile — just not the load-bearing fix this section claimed.

---

## Critical findings

Full detail for each, including the verification I ran.

**C16** — worktree reconcile silent data loss. *See "Fix first" above.*
**C23** — `git reset --hard` / `checkout` without env scrubbing. *See "Fix second" above.*

**C1 · `bootstrap/db-tools.ts`** — `resolveWorkflowToolBasePath(_ctx, params)` sites pass
camelCase `milestoneId`; the helper reads `scope?.milestone_id` (`dynamic-tools.ts:70`). `scope` is
optional so TS cannot catch it. The existing test exercises the helper directly with a snake_case
object. → eagle27272/gsd-pi#22

> **[qualified — overstated].** It is **18 of 20**, not 20/20: `gsd_summary_save` (call `:586`,
> schema `:614`) declares snake_case `milestone_id` and routes correctly, and
> `gsd_answer_milestone_subjective_uat` (call `:2077`) has no milestone field at all. There is
> genuinely no normalization step anywhere.
>
> **"Routing never activates" is wrong.** For the 18 camelCase tools `scope?.milestone_id` is
> `undefined`, which falls into the `else` at `dynamic-tools.ts:74-77`, and `activeWorktrees()`
> returns the single live worktree when there is exactly one — the normal auto-worktree case. Real
> misrouting is confined to **≥2 concurrent milestone worktrees with the agent running from the
> project root**. Still a bug; not the blanket failure described. The test blind spot is confirmed
> (`tests/workflow-tool-base-path.test.ts:20-23`).

**C2 · `bg-shell/bg-shell-lifecycle.ts:59,405`** — Both `session_shutdown` handlers ignore
`event.reason` and call `cleanupAll()`, which SIGKILLs everything with no `persistAcrossSessions`
check. `reason` is `quit|reload|new|resume|fork` (`extension-upstream-types.ts:617`). The correct
filter already exists at `process-manager.ts:442`; the contract is advertised to the model at
`bg-shell-tool.ts:60`. **[re-verified verbatim]** → eagle27272/gsd-pi#19

> **Missed, same root cause:** the first handler's `cleanupAll()` ends with `processes.clear()`
> (`process-manager.ts:413`), and the second handler then calls `persistManifest` at `:409`, which
> maps over `processes.values()`. **The shutdown manifest is always written empty**, defeating
> restart/rediscovery.

**C3 · `tools/exec-tool.ts:206-297`** — UAT exec policy gaps. → eagle27272/gsd-pi#26

> **[largely REFUTED — downgraded from Critical to Low].** Three of the four sub-claims fail:
>
> - **`executeUatExec` *does* reach `normalizeRuntime`.** It spreads `...params` into
>   `executeGsdExec`, which normalizes at `:231`. The `python`/`node` bypass claim is wrong.
> - **`cat ./.env` and `less .env` are blocked** — along with `cat ../.env`, `head -20 .env` and
>   `grep KEY .env`. Not by the `cat \.env` rule (which does miss `./.env`) but incidentally by
>   `/\b(?:env|printenv)\b(?:\s|$)/i` at `:212`, since `.env` at end-of-token satisfies `\benv\b` + `$`.
>   That rule is also over-broad, blocking `docker run --env FOO` and `ls env`.
> - **Only the `rm` bypasses hold**: `rm -fr X`, `rm -f -r X`, `rm --recursive --force X`. Additional
>   confirmed bypasses: `npm --prefix . install`, `cat ./.env.production`, `cat "$(pwd)/.env"`,
>   `cat $HOME/.aws/credentials`.
>
> **And the framing was wrong.** This is a workflow-discipline guardrail, not a security boundary:
> `exec-tools.ts:80-126` registers an unrestricted `gsd_exec` with the identical sandbox, same
> extension, same agent, same privilege. Its stated purpose (`exec-tools.ts:38`) is to keep the UAT
> evidence trail clean. Worth fixing on those grounds; nothing here was holding back an adversary.

**C4 · `pi-agent-core/agent-loop.ts:1112`** — `raceToolExecutionAgainstAbort` early-returns on
`signal.aborted` *before* attaching the `.then(onFulfilled, onRejected)` guard, so an already-queued
tool that rejects produces an unhandled rejection. → eagle27272/gsd-pi#26

> **[qualified].** The window is real and reachable in the parallel path: `executeToolCallsParallel`
> pushes a deferred thunk at `:858` and only invokes it inside `Promise.all` at `:876-878`, awaiting
> `emit(...)` in between, so the signal can abort after `prepareToolCall`'s checks (`:1015`, `:1032`).
>
> **"Fatal under Node's default" is wrong.** `gsd-agent-modes/src/main.ts:411` and
> `bootstrap/register-extension.ts:127-134` both install `unhandledRejection` listeners, so
> `--unhandled-rejections=throw` never applies. The actual outcome is `_gsdRejectionGuard` writing a
> crash log and calling `process.exit(1)` — still a hard exit, but attributable to the repo's own guard.

**C5 · `mcp-server/workflow-tools.ts:650,762`** — Unsanitized `milestoneId` `join()`ed into a
worktree path; the result replaces the validated `projectDir` with no re-validation.
→ eagle27272/gsd-pi#21

> **[qualified].** The sink is `:650`, not `:640` (`:640-642` is the container list). Two gates at
> `:651-654` bound it: `if (!existsSync(wtPath)) continue; if (!existsSync(join(wtPath, ".git"))) continue;`.
> So `milestoneId = "../../../../etc"` yields nothing; `"../../../other-repo"` yields a live redirect
> of all subsequent workflow writes into another *existing git checkout*. Call it **cross-repo write
> redirection**, not arbitrary path traversal.

**C6 · `mcp-server/server.ts:1153-1178` + `session-manager.ts:123-131`** — `gsd_execute` skips the
`validateProjectDir` that 11 sibling tools call (`server.ts:395,1013,1250,1282,1311,1416,1436,1456,1476,1495,1545`).

> **[qualified to near-nothing].** `startSession` only rejects empty and calls `resolve(projectDir)` —
> no absolute-path check either, so a relative path resolves against the server cwd. But
> `validateProjectDir` (`workflow-tools.ts:559-590`) imposes **no containment by default**:
> `getAllowedProjectRoot()` (`:533-536`) returns `null` unless `GSD_WORKFLOW_PROJECT_ROOT` is set, and
> on `null` it returns the resolved path immediately (`:572`). So with no hardening the 11 siblings
> that *do* call it get exactly the same non-containment. Skipping it changes nothing by default.
> Transport is stdio-only, so the "attacker" is the local LLM client.

**C7 · `tools/workflow-tool-executors.ts:679`** — `task_id` interpolated into a filename by
`buildFlatTaskFileName`. **[re-verified with a working reproduction]** → eagle27272/gsd-pi#9

> `buildFlatTaskFileName("S01", "../../../../../../tmp/pwned", "SUMMARY")` →
> `"S01-../../../../../../tmp/pwned-SUMMARY.md"`, and
> `join("/proj/.gsd/M001", …)` → `/tmp/pwned-SUMMARY.md`. Schema is `task_id: z.string().optional()`
> (`workflow-tools.ts:2361`) with no pattern. Reachable via `gsd_summary_save` / `gsd_save_summary`,
> and **not** gated by `validateProjectDir` even in a hardened deployment.
>
> **The containment check is a known requirement this path skipped:** `db-writer.ts:852-855` and
> `:927-931` both reject `rel.startsWith('..')`. **Second unguarded sink:**
> `mirrorArtifactToActiveWorktreeProjection` (`workflow-tool-executors.ts:436-458`) does
> `join(contract.worktreeGsd, relativePath)` → `saveFile`, called at `:704` with the traversing path.

**C8 · `worktree-manager.ts:896`** — `removeWorktree` computes `resolvedPathSafe` but enforces it
only for the tail steps. → eagle27272/gsd-pi#12

> **[first half re-verified, second half REFUTED].** Confirmed: `resolvedPathSafe` is computed at
> `:896`; the `git add -A`/`commit` at `:944-950` and the nested-`.git` `rmSync` at `:983` are gated
> only on `existsSync(.gitmodules)` / `nestedGitDirs.length > 0`, never on `resolvedPathSafe`, while
> `:1004` and `:1027` do enforce it.
>
> **REFUTED: `/gsd discard <arg>` cannot traverse.** `discardMilestone` (`milestone-actions.ts:144-160`)
> returns `false` at `:149` unless the id resolves to a real phase dir or DB row, and
> `resolveMilestonePath` → `resolvePhaseDir` (`paths.ts:779`) runs the id through
> `canonicalPhaseDirName` (`layout-policy.ts:124-133`), which cannot emit `..`. The C8a hazard is
> reached via a symlinked or relocated worktree entry, not via the discard argument.

**C9 · `worktree-manager.ts:1268-1281`** — On a merge conflict the worktree and branch are
force-deleted **before** `GSD_MERGE_CONFLICT` is thrown, while both the CLI and the LLM-guided
handler tell the user to resolve conflicts against a worktree that no longer exists.
→ eagle27272/gsd-pi#12

> **[qualified — and the real defect is the inverse of what was described].** The main tree *is*
> restored first (`cleanupFailedSquashMergeState` at `:1272`) and the delete is conditional on
> `!dirtyWorkingTree && branch.startsWith("milestone/")`, so `worktree/*` branches from
> `/gsd worktree merge` are never deleted here.
>
> **But the safety is inverted.** A **dirty** worktree is quarantined with
> `deleteBranchAfterRemoval = false` (`:1018`) — branch preserved. A **clean** worktree, i.e. one
> where the user *committed* their milestone work, falls through to `:1080` `deleteBranchIfPresent`
> → `nativeBranchDelete(basePath, branch, true)`, making every committed milestone commit
> unreachable except via reflog while the conflict is still unresolved. **Committing your work makes
> the outcome worse.**

**C10 · `exec-sandbox.ts:317-337`** — `redactSecrets()` is applied to the persisted files but the
agent-facing digest is built from the raw `stdoutBuf` (`:327`) and returned to the model at
`exec-tool.ts:337`.

> **[REFUTED as a finding].** The buffer identification is exactly right, but the framing is not.
> `redact-secrets.ts:1-4` states the module's purpose is **disk hygiene for the secret scanner**
> (`.gsd/` is skipped by `.secretscanignore`), not provider egress — and `:321-323` documents the
> digest behaviour as intended. The digest *is* redacted on the one persistence path that matters
> (`activity-log.ts:133`). Since `bash`, `read` and `gsd_exec` all return unredacted output to the
> provider anyway, this is not a distinguished leak channel. **Not a bug: redaction scope is
> disk-only, deliberately.**

**C11 · `custom-workflow-engine.ts:169-180`** — The "ReDoS guard" checks elapsed time *between* loop
iterations, so it cannot interrupt a single catastrophically-backtracking `exec()`.
**[re-verified]** → eagle27272/gsd-pi#26

> **Downgrade to Medium: self-inflicted, not remote.** Patterns come from the user's own
> `<project>/.gsd/workflow-defs/*.yaml` (`run-manager.ts:131-132`), validated only for syntax +
> capture-group presence (`definition-loader.ts:177-187`). Also at `:173`: a valid pattern that can
> match empty (e.g. `(x?)`) never advances `regex.lastIndex`, so `items` grows unbounded for the
> full 5 seconds before the check fires.

**C12 · `commands-maintenance.ts:556-566` + `db-workspace.ts:853-877`** — `handleRecover` checks only
`isDbAvailable()` (`:564`) with no project scoping. **[re-verified]** → eagle27272/gsd-pi#21

> The unscoped load is `retainedRecoverApplicationId()` at `db-workspace.ts:853-877`, which builds its
> query from `_getAdapter()` with no project predicate (`:852` is blank). The headless twin
> `src/headless-recover.ts:199` explicitly calls `openWorkflowDatabase(basePath)` first, proving the
> guard is expected. Trigger is a cwd change within one extension process (`projectRoot()` is
> re-derived from `process.cwd()` per call, `commands/context.ts:38-58`) — which
> `doctor-git-checks.ts:283` can cause, since it `process.chdir`s and never restores.

**C14 · `subagent/index.ts:1450-1462` + `:557-561`** — Single-agent isolated mode merges a **failed**
subagent's diff into the live repo (`if (isolation)` — the parallel/background paths at `:1151`/`:1354`
correctly gate on `exitCode === 0`). Compounding: `proc.on("close", (code) => resolve(code ?? 0))`
drops the signal arg, so a SIGKILLed subagent reports exit 0 — **fixing either one alone does not
fix it.** **[re-verified verbatim]** → eagle27272/gsd-pi#14

> **Missed:** `:572-574`'s SIGKILL escalation is **dead code** —
> `setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000)`. Node sets `subprocess.killed`
> when a signal is *sent*, and the `proc.kill("SIGTERM")` above already set it. A subagent that
> ignores SIGTERM is never force-killed.
>
> **Same root cause elsewhere:** `waitForChildProcess` (`packages/pi-coding-agent/src/utils/child-process.ts:46`)
> is typed `Promise<number | null>` and `:100` drops Node's signal argument, so
> `core/exec.ts:104` (`code ?? (killed ? 1 : 0)`) and `core/tools/bash.ts:453`
> (`if (exitCode !== 0 && exitCode !== null) throw`) both treat an externally-killed child as success.
> Verified by `pkill -9`: `{code: 0, killed: false, stdout: "partial"}`.

**C15 · `slice-parallel-orchestrator.ts:158-160`** — `rmSync(wtPath, {recursive:true, force:true})` on
a path built from unvalidated ids, with no containment check. The repo *documents* this exact
requirement at `commands-eval-review.ts:14` and exports `isInsideWorktreesDir`, used correctly at five
other destructive sites (`auto-worktree-teardown.ts:142`, `worktree-manager.ts:880`, `:896`,
`auto-start.ts:674`, `:804`). **[re-verified]** → eagle27272/gsd-pi#21

> Line drift 6 (the report said `:153`, which is `createSliceWorktree`'s header). Verified:
> `join("/proj/.gsd-worktrees", "M001-../../../Users/me/docs")` → `/proj/Users/me/docs`.
>
> **"Before any validation" needs narrowing.** `isValidSliceWorktreePath()` *is* called on the same
> line — but it is a worktree-legitimacy test used in the negative, so it widens rather than narrows
> the delete and constrains nothing about location. `createWorktree`'s `/^[a-zA-Z0-9_-]+$/` name check
> (`worktree-manager.ts:557`) does run, but *after* the delete at `:162`. Reachability needs an id
> containing `../` to reach `startSliceParallel` from the planner DB; `isValidMilestoneId`
> (`worktree-lifecycle.ts:404`) exists but is not applied on this path.

**C17 · `doctor-git-checks.ts:185`** (report said `:177`) — Conflict auto-resolve gated only on
`!dryRun`, not `shouldFix`. `runGSDDoctor` defaults `fix = false, dryRun = false`; `headless.ts:480`
and `forensics.ts:420` pass neither, so both reach it. 12 `shouldFix()` calls elsewhere in the same
file. **[re-verified]** → eagle27272/gsd-pi#11

> **Narrowed:** the auto-stage (`checkout --theirs` + `git add`, `git-conflict-state.ts:175-197`) is
> unconditional on `shouldFix` for every path passing `isSafeToAutoResolve`, but `abortAndReset`
> (`git-self-heal.ts:50-114`) only fires when *every* unmerged path was safe-resolvable and merge
> markers remain. A mixed conflict set (`.gsd/STATE.md` + `src/app.js`) leaves the merge intact.
> Damning nonetheless: `doctor-git-checks-autoresolve.test.ts:100` asserts a non-fix run deletes
> `MERGE_HEAD`, and `headless.ts:470` comments *"Doctor: read-only health check"*.

**C20 · `doctor-git-checks.ts:432-433`, delete at `:448`** — The `gsd/*/*` glob matches
`gsd/submodule-rescue/<name>-<ts>` — the branches `worktree-manager.ts:941` creates specifically to
rescue uncommitted submodule work — and force-deletes them (`nativeBranchDelete(..., true)` = `git
branch -D`). The only exclusion is `gsd/quick/`. **[re-verified]** → eagle27272/gsd-pi#11

> **Understated: a second and larger false-positive family.** `commands-workflow-templates.ts:457`
> and `:631` create `gsd/${templateId}/${slug}` for **current, non-legacy** template runs. They match
> the same glob and are hard-deleted with no merged check. This hits every template workflow, not
> just the submodule edge case. No test covers `legacy_slice_branches`.

**C21 · `doctor-git-checks.ts:260-296`, remove at `:290`** — `orphaned_auto_worktree` force-removes on
roadmap status alone with no dirty check, while the sibling `worktree_branch_merged` at `:652`
correctly gates on `health.safeToRemove` (`worktree-health.ts:108` = `mergedIntoMain && !dirty`).
Cancelled/skipped do reach it: `from-db.ts:53` `isStatusDone = isClosedStatus` collapses them to
registry `status: 'complete'` at `:191-193`. **[re-verified]** → eagle27272/gsd-pi#11

> **Missed:** `:283` calls `process.chdir(basePath)` with no restore on the success path, silently
> relocating the process cwd for everything downstream including the `process.cwd()` read at `:635`.

**C22 · `doctor-git-checks.ts:524-556`, rmSync at `:548`** (report said `:514`, which is the enclosing
`try`; the `nativeWorktreeList` call is `:525`) — `[]` on transient failure → every on-disk worktree
looks unregistered → `rmSync` on all of them, dirty and unpushed included. No `registeredPaths.size === 0`
guard. **[re-verified]** → eagle27272/gsd-pi#11

> **Missed, same shape, same file:** `worktree_empty_with_project_content` (`:219`, fix at `:231-236`).
> `hasProjectContentOnDisk`'s git path returns `[]` when `git ls-files` exits non-zero (`:78`), and both
> it and the fallback exclude any `.gsd` segment (`isProjectContentPath`, `:70`) — so a worktree whose
> only content is uncommitted `.gsd/` work is force-removed and then `git reset --hard`.

**C24 · `clean-root-preflight.ts:485-511`, drop at `:490`** — When every stashed path is `.gsd/`-owned,
the stash is **dropped without `git stash apply`**, with no content check and no verification the merge
touched those paths — then returns `restored: true, needsManualRecovery: false`. The sibling drop at
`:265-291` compares content first (`readFileSync` at `:236`, comparison at `:232-242`). The comment at
`:484` even calls apply "the safe default". **[re-verified]** → eagle27272/gsd-pi#12

> `isGsdOwnedPath` (`:118`) is a bare `.gsd` prefix test — and `.gsd` holds user-authored ROADMAP /
> PLAN / SUMMARY artifacts, not just machine state.

**C25 / C26 · `auto-worktree-merge-pre-teardown.ts:64-92`** — The documented *"final data-loss check"*
(file header, `:3`) has three fail-open paths in 30 lines: branch-detect throws → `null !== branch` →
dirty check skipped (`:64-74`); `""` from a failed `git status` → "clean" (`:77-78`); and
`deps.chdir(previousCwd)` throwing inside the `try` means the `GSDError` is never constructed and the
non-GSDError is swallowed by its own handler (`:76-92`) — **the abort is lost after uncommitted changes
were already detected**, so `shouldCleanup = true` and `finalizeMilestoneCleanup()` runs in the
`finally` at `auto-worktree-merge.ts:390-400`. **[all three re-verified]** → eagle27272/gsd-pi#12

> **A fourth fail-open, missed:** the same `catch` at `:86-92` re-throws only `GSDError`, so *any*
> other throw from `nativeWorkingTreeStatus` is downgraded to a `debugLog` and teardown continues.
> This one does not depend on `allowFailure` at all.
>
> Note the `""` path (`:77-78`) has no `debugLog` whatsoever, and is distinct from the *tested* throw
> path at `tests/auto-worktree-merge-pre-teardown.test.ts:68`.

**C27 · `get-secrets-from-user.ts:558`** — Model-supplied `envFilePath` passed to `resolve()` with no
containment; arbitrary `KEY=value` file write. `isSafeEnvVarKey` guards the vercel/convex branch
(`:370`) but **not** the dotenv branch (`:351-361`), so a newline in a key injects a second pair
(verified: a key of `"KEY=v\nOTHER"` produces two lines); and `.env` is written with no `mode`
(`:88`), landing at 0644. Schema at `:519` is a bare string. **[all four re-verified]**
→ eagle27272/gsd-pi#10

> **⚠️ This is the smaller half of the problem — see NEW-C35 below.**

### ⚠️ NEW-C35 — two divergent `secure_env_collect` implementations, and the local one is unhardened

**Critical. Missed entirely by the first pass.** → eagle27272/gsd-pi#10

`src/resources/extensions/get-secrets-from-user.ts:490` registers `secure_env_collect` as a
first-class coding-agent tool, making the same on-screen promise as the MCP version. It is missing
*every* hardening `packages/mcp-server/src/env-writer.ts` has:

- **No `SECURITY_SENSITIVE_KEYS` blocklist.** The MCP side's own comment (`env-writer.ts:143-160`)
  calls setting `GSD_WORKFLOW_EXECUTORS_MODULE` / `NODE_OPTIONS` / `LD_PRELOAD` an **"RCE chain"** —
  and `get-secrets-from-user.ts:63-67`'s `hydrateProcessEnv` sets **any** key into the live
  `process.env` unconditionally and persists it to the env file.
- **Plaintext secrets on the process argument list.** `:375` builds
  `sh -c "printf %s '<secret>' | vercel env add …"` and `:381` calls
  `pi.exec("npx", ["convex","env","set", key, value])` — both visible in `ps`.
  `env-writer.ts:274-275` deliberately fixed exactly this by switching to `{ stdin: value }`; the
  extension copy was never updated.
- No `resolveProjectEnvFilePath` containment, no `O_NOFOLLOW`/symlink refusal, no 0600 temp-file +
  `rename`.

The first pass treated these two files as unrelated.

**C28 · `mcp-server/pid-registry.ts:521-528`** — `signalAutoLockPid` uses inline `pid <= 0` at `:528`,
permitting **PID 1**, while the shared `isSafePid` (`:236-238`) is `pid > 1` and is what `killPid`
uses. It also has no `getProcessCommand`/`isMcpServerCommand` check, where `killPid` requires one
(`:438`, `:455-456`). → eagle27272/gsd-pi#26

> **[qualified — downgraded from Critical to Low].** The divergence is real and PID 1 genuinely does
> pass (`getProcessStartTime(1)` returns boot time, never tripping the stale check at `:545-548`;
> `getProcessCwd(1)` returns `null` for a non-root reader, which `:551` explicitly tolerates).
>
> **But the signal is `SIGTERM`, which yields `EPERM` for a non-root process** — only exploitable as
> root or in a container. And two guards the finding omits *do* fire (`:545-548` start-time skew,
> `:550-558` cwd). The lock is written by the auto-mode process itself (`session-lock.ts:103`) and is
> gitignored (`gitignore.ts:41`), so forging it requires the same filesystem write the model already has.

---

## High and Medium findings

~300 further findings across 138 files. Grouped by subsystem, most severe first within each.

**Credential storage — 6 findings, all silent loss with a success message**
`auth.json` non-atomic write (kill mid-write wipes *all* providers) · write failures swallowed into
`AuthStorage.drainErrors()`, which has **zero callers** (verified) · OAuth refresh drops a
co-located API key · `keys add` silently replaces stored OAuth · `keys remove` with 3+ keys keeps
only the last (`set()` is `this.data[p] = c`, no array API exists) · `keys rotate`'s "Preserve any
OAuth credentials" loop is provably overwritten by the next line.

**Verification and safety nets that cannot fire** — **[all re-verified; four corrections below]**
→ eagle27272/gsd-pi#17

`safety_harness.auto_rollback` tests `unitResult.status === "error"`, a value assigned **nowhere**
(exactly 14 assignments — 12 × `cancelled` in `auto/run-unit.ts`, plus `auto/resolve.ts:84`
`completed` and `:136` `cancelled`; `rollbackToCheckpoint` has exactly one call site, inside the dead
branch) · cost-spike guard includes the outlier in its own baseline · ghost-completion guard measures
from a `requestDispatchedAt` never refreshed across wakeups · `verify-after-write` accepts a stale
`quality_gates` row (`auto-post-unit.ts:1180-1200` runs the `SELECT status` and then **discards
`status`**; no `evaluated_at` recency, no turn scoping) · `artifact-verification.ts` has two fail-open
catches (`:342-345`, `:532-534`) beside fail-closed siblings · `pre-execution-checks.ts` compares task
status to `"completed"` while the DB writes `'complete'` — **and the regression test uses the same
wrong literal** · required-verification-class check is presence-only · `missing_slice_dir` in
`doctor-state-checks.ts` is unreachable · read-only-reconnaissance classifier passes
`find … -delete`, `git branch -D`, `git remote remove`.

> **Corrections:**
>
> 1. **"the `else` branch *deletes* the checkpoint" is imprecise.** The `status === "cancelled"` block
>    at `unit-phase.ts:619-836` returns `{action: "break"}` before the checkpoint block at `:1004` is
>    reached, and every sub-branch returns. So on a genuine failure the checkpoint is **leaked**
>    (`s.checkpointSha` left non-null until the next unit start), not deleted. The
>    `else` → `cleanupCheckpoint` at `:1017-1019` does destroy it for a `completed`-but-`no-artifact`
>    unit — which is a failure in a different guise.
> 2. **The cost-spike guard is dead for the first *three* units, not the first.** Because
>    `rollingAvgUsd = totalCost/totalUnits` counts the outlier, firing requires `C·(N−3) ≥ 3·P`.
>    Simulated: `[100]`, `[1,100]`, `[1,1,100]` → no pause; `[1,1,1,100]` → pause.
> 3. **`artifact-verification.ts` has four fail-closed siblings, not three:** `:387-390`, `:398-401`,
>    `:409-412`, `:469-472`.
> 4. **The recon classifier is Low, not High — it is dead code.** Its only consumer,
>    `classifyTraceProgress` (`session-forensics.ts:92-100`), has **zero production callers**; it is
>    imported nowhere outside `tests/session-forensics-readonly-classification.test.ts`. The regex
>    holes are real and would be High if wired up.
>
> **On the `"completed"` / `'complete'` mismatch** — this is the sharpest of the set and deserves
> more than a clause. Source: `pre-execution-checks.ts:547, 774, 779, 811`. DB: `gsd-db.ts:715, 722`.
> `status-guards.ts:23-24, 35` defines `CANONICAL_STATUSES` / `RAW_CLOSED_STATUSES` containing
> `"complete"`; `"completed"` is not canonical, not closed, and not in `ALIAS_TO_CANONICAL`.
> `TaskRow.status` is typed `string` (`db-task-slice-rows.ts:33`), so no compile error. **The #4071 /
> #4572 completed-task exemptions are inert in production**, and
> `tests/pre-execution-checks.test.ts:1942, 2020` repeat the same wrong literal.
>
> **Missed, same class:** `milestone-closeout.ts:337-339` swallows any throw in the
> verification-class check and falls through to `return { action: "dispatch", … }` — a fail-open in
> the milestone-completion gate itself.

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
with `killed === false`, so the expression resolves to **`0`**. Verified by externally `pkill -9`-ing
a child: `{code: 0, killed: false, stdout: "partial"}`. Fix: surface `signal` from
`waitForChildProcess` and treat a non-null signal as failure. → eagle27272/gsd-pi#14

> **[re-verified; severity Medium, not High]** — the sole production consumer of `exec.ts` is the
> `pi.exec` extension API (`extensions/loader.ts:356`).
>
> **But the report missed the hotter instance of the same root cause:**
> `packages/pi-coding-agent/src/core/tools/bash.ts:453` does
> `if (exitCode !== 0 && exitCode !== null) throw …` — identical null-as-success semantics in the
> main agent bash path. Timeout/abort/force-kill are caught earlier as thrown errors, so the residual
> case (external signal, OOM killer) returns partial output as a successful command.
> **Fixing only `exec.ts` leaves this.**
>
> The three sub-findings are confirmed but all Low, not High/Medium: unbounded `stdout`/`stderr`
> (`:47-48, 87-93`) with an optional timeout (`:81`); no kill-on-host-exit registration (`:41-45`) —
> `bash.ts:104` does this correctly via `trackDetachedChildPid`/`killTrackedDetachedChildren`
> (`utils/shell.ts:217-229`); and a discarded spawn `ENOENT` message (`:106-113`).

**`db-provider.ts:99-113` — `close()` leaks both SQLite handles.** *~~High, verified.~~*

> ### ⛔ REFUTED — not a finding
>
> The `throw` is **not** on the normal path. It sits inside the `catch` of a probe
> (`readOnlyGuard.prepare("PRAGMA schema_version").get()`) that succeeds in ordinary operation, so
> neither the `PRAGMA journal_mode` read nor the `throw` executes and both `closeHandle()` calls are
> reached.
>
> `tests/db-provider.test.ts:120-128` exercises this against real `node:sqlite` with
> `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0`, closes, and reopens — **I ran the suite:
> 11/11 pass.** The retention-on-probe-failure behaviour is a deliberate, named contract
> (`"keeps both handles open when the close guard probe fails"`, `:172`) and is retryable:
> `writableClosed`/`guardClosed` stay false and a second `rawDb.close()` succeeds. There is no march
> toward `EMFILE`.
>
> The original text follows for the record.
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
*~~High~~ → Medium/Low.* For in-memory sessions, `fork()` calls `newSession()`/`createBranchedSession()`
on the **shared** `SessionManager` — `newSession()` does `this.fileEntries = [header]` on the same
instance (`session-manager.ts:209-213`) — and only then calls `teardownCurrent("fork", …)`, which
emits `session_shutdown` at `:161-168`. Handlers therefore read an emptied conversation. The shipped
`auto-commit-on-exit.ts` example does exactly that read. The two adjacent persisted-session branches
(`:281-283`, `:296-301`) build a *new* `SessionManager` and are unaffected — the sibling asymmetry
again. Plus one Medium: `importFromJsonl` overwrites an existing session file with a colliding
basename, with no existence check. → eagle27272/gsd-pi#23

> **[re-verified; downgraded].** Reachable only for `--no-session`
> (`gsd-agent-modes/src/main.ts:239-240`), and **no in-repo `session_shutdown` handler reads the
> conversation** — so the stated symptom is currently latent.
>
> **The second-order effect is worse and was missed.** `teardownCurrent` → `session.dispose()` →
> `cleanupSessionResources(this.host.sessionId)`, and `AgentSession.sessionId` is a live getter over
> `sessionManager.getSessionId()` (`agent-session.ts:235-237`). Because `newSession()` /
> `createBranchedSession()` already reassigned `this.sessionId` on the shared manager, teardown cleans
> the **new** session's resources and permanently leaks the old session's.

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
`find.ts` *constructs* the error message and then drops it. Fix: keep the reject, or attach a
partial-result notice. → eagle27272/gsd-pi#24

> **[qualified — Medium, and the trigger is narrower than "an unreadable subtree"].** Probing fd
> 10.5.0: it exits **0** for no-matches *and* for permission errors, and 1 only for hard errors that
> emit no output (which the `if (!output)` branch already rejects on). So the genuinely reachable
> case is **fd dying by signal mid-stream** (`code === null`) — an OOM-killed traversal returning a
> truncated listing as complete.

Four Mediums across the pair — **one of them refuted.**

> **⛔ REFUTED: the empty-line slice.** `find.ts:185-188, 306-314` relativizes with
> `p.slice(searchPath.length + 1)` behind a bare `startsWith`, but `find(path: "src/foo.ts")` never
> reaches it: `fd` refuses a file as a search root —
> `[fd error]: Search path … is not a directory` / exit 1 / no stdout — which lands in the
> `if (!output) { reject }` branch and is handled correctly. The slice is only reachable via a custom
> `FindOperations.glob` backend, and there is none in this repo.
>
> **A real off-by-one survives, though:** `find(path: "/")` gives `searchPath === "/"`, so
> `"/etc/x".slice(2) === "tc/x"` — the first character of every result is stripped. `path.relative`
> handles it.

The remaining three stand. Both files' `stopChild` (`find.ts:255-259`, `grep.ts:234-239`) call
`child.kill()` with no `SIGKILL` escalation, so a hung `rg`/`fd` is orphaned per aborted call — while
`exec.ts:62-67` in the same package implements the escalation correctly. And `grep.ts:244` registers
its abort listener only *after* `ensureTool("rg")` (`:170`) and `isDirectory()` (`:180`) resolve, so
cancellation during a first-run ripgrep download is lost entirely — where `find.ts:148` registers
before any await. Each is the same pair of files disagreeing with each other.

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

*~~High~~ → **Medium**. All three collapses re-verified verbatim, but see the reachability note below.*
→ eagle27272/gsd-pi#18

> **Downgrade reason: `browser_action_cache` has zero internal callers.** `grep -rn "browser_action_cache"`
> returns only the tool's own registration (`:24`, `:27`). The `cache` Map at `:19` is module-local
> with no exported accessor, so `browser_find_best` and `browser_act` **cannot** consult it — the
> docstring at `:6-7` ("Internal optimization that hooks into browser_find_best / browser_act") is
> aspirational. The stale-selector path only opens if an agent explicitly calls `put` then `get`.
>
> Also frame-blind in a fourth way the write-up misses: `computeDomHash(p)` at `:86` and `:126` uses
> the *page*, not `getActiveTarget()`.

Two independent collapses:

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
things wrong that the original gets right. **[both re-verified verbatim]** → eagle27272/gsd-pi#15

> **A third defect, missed:** `resetAllState()` at `:120` also resets `_harState` to
> `DEFAULT_HAR_STATE` (`state.ts:289-296`, `enabled: false`) and nulls `_sessionArtifactDir`.
> `device.ts`'s `newContext` (`:104-106`) passes no `recordHar` and never calls
> `setSessionArtifactDir` (destructured at `:115`, never invoked), and the `ensureBrowser` fast path
> never re-establishes them. **Every HAR export after a device-emulation call is dead for the rest of
> the session.**
>
> The Chromium leak is also wider than stated: if `chromium.launch`, `newContext` or `addInitScript`
> throws at `:103-110`, state is still null from `closeBrowser()` at `:92`, so nothing holds a
> reference and the process is unreclaimable.

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
`"PASS (0/0 checks)"` (`core.ts:612-618`). A verification tool reporting success for having verified
nothing is the purest form of the defect this report keeps finding. Fix: `minItems: 1` on the schema
plus an explicit guard. **[re-verified verbatim; severity Medium rather than High]**
→ eagle27272/gsd-pi#18

> **Two related misses in the same subsystem, both worse than the entries above:**
>
> - **`browser_batch`'s `click_ref`/`fill_ref` skip *every* staleness guard** —
>   `tools/assertions.ts:273-296` does `parseRef` → `getCurrentRefMap()[parsedRef.key]` →
>   `resolveRefTarget` with no version check, no URL check, and no unversioned-ref rejection. A
>   `@v1:e3` ref resolves against a v7 snapshot silently. Strictly worse than the `frameContext`
>   finding above.
> - **Every ref-tool "PASS" means "at least one heuristic fired"** — `browser-tools/utils.ts:272-283`
>   sets `const verified = passedChecks.length > 0`. This is what lets the `Control+A` concatenation
>   bug report success.

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
Disconnecting first means the message the agent finalizes *during* the abort is never persisted.
Compaction then rebuilds from `getBranch()` — which lacks it — and assigns the result over
`state.messages` at `:121`, destroying the in-memory copy that still had it. Calling `compact()`
mid-turn therefore silently drops the closing assistant message from both the persisted session and
the live context. One-line fix: swap the two statements to match the navigation siblings.
→ eagle27272/gsd-pi#23

> **[re-verified; Medium, not High. One premise corrected.]** `disconnectFromAgent` unsubscribes
> `handleAgentEvent` (`agent-session-events.ts:249-254, 258`) and `host.abort()` is `agent.abort()` +
> `waitForIdle()` (`agent-session-prompt.ts:479-482`), so the ordering defect is exactly as described.
>
> **But `handleAgentEvent` is *not* the only caller of `sessionManager.appendMessage`** —
> `agent-session-bash.ts:61` and `:85` also call it. For *agent-produced* messages
> `agent-session-events.ts:82` is the only path, so the conclusion survives; the premise as stated
> does not.

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
Both projects then read and write the same session directory. Kebab-case project names are the norm,
so this is ordinary rather than exotic. Fix: append a short hash of the resolved cwd to the readable
suffix. → eagle27272/gsd-pi#23

> **[qualified — Medium, not High].** The collision and cross-visibility hold, and `/Users/mike/foo:bar`
> collides too. But **"can overwrite one another" is wrong**: every write target is
> `join(dir, \`${fileTimestamp}_${newSessionId}.jsonl\`)` (`session-manager.ts:217, 651, 807`) with a
> fresh session id, so colliding projects interleave files rather than clobber them.
>
> The real damage is that `SessionManager.list` (`:837-840`) applies **no cwd filter**, so another
> project's sessions appear in the picker, and `continueRecent` picks the newest file regardless of
> cwd — resuming another project's transcript under this project's cwd.

Three Mediums alongside it. `isValidSessionFile:65-78` calls `closeSync(fd)` only on the success
path, so a stray directory named `*.jsonl` makes `readSync` throw `EISDIR` and leaks the descriptor
on every session-list refresh — needs `finally`. `buildSessionInfo:149-166` accepts a header on
`type === "session"` alone, while the two sync validators in the same file also require
`typeof header.id === "string"`; the async path feeding the session picker therefore admits records
whose `id` is `undefined` despite the type declaring `id: string` — the sibling asymmetry once more.
And `/share` (`slash-command-handlers.ts:312-325`) registers `close` but no `error` handler on the
`gh gist create` spawn; it also writes to a fixed `<tmpdir>/session.html` (`:276`), which collides
between concurrent invocations and is symlink-attackable on a shared machine.
→ eagle27272/gsd-pi#23

> **[qualified — it crashes, it does not hang].** Verified: on spawn `ENOENT` Node emits `error` and
> **never** `close`; with no listener the EventEmitter throws, and GSD's `_gsdEpipeGuard`
> (`bootstrap/register-extension.ts:114-125`) responds with
> `writeCrashLog(err, "uncaughtException"); process.exit(1)`. So a missing `gh` takes the whole app
> down rather than leaving the "Creating gist…" loader spinning. `tool-definition-wrapper.ts` reviewed clean, and the reviewer correctly declined
to report its `ctxFactory?.() as ExtensionContext` cast after confirming no current caller can reach
it with `undefined`.

### ⚠️ C34 — `edit` silently rewrites the whole file, and the diff preview hides it (Critical, verified)

`pi-coding-agent/src/core/tools/edit-diff.ts:209-212, 246, 259`. The most damaging finding of the
continuation sweep: a code-editing tool that corrupts untouched parts of the file and conceals it
from the review surface. → eagle27272/gsd-pi#4

> **[re-verified end to end with live reproductions — the strongest finding in the report].**
> All four links hold independently:
> (a) running `normalizeForFuzzyMatch` (`:34-55`) on
> `"const a = 1;   \n// note — an em dash\nconst s = ‘curly’;…ﬁ…"` yields
> `"const a = 1;\n// note - an em dash\nconst s = 'curly';…fi…"`;
> (b) `edit.ts:342-346` writes `newContent` with no re-splice against the original;
> (c) with only one edit needing fuzz, `baseContent !== original` **and**
> `normalizeForFuzzyMatch(original) === baseContent`, and the preview diff showed **1** changed line
> while the true `original → new` diff showed **5** corrupted lines;
> (d) a repo-wide grep for `contentForReplacement` (excluding `dist`/`node_modules`) returns only the
> declaration, its docstring and the three assignments — **zero reads**.
>
> One line correction: the declaration is at `:70`, not `:92` (`:92` is the docstring mention).
> The `countOccurrences` sub-finding is also confirmed: `"foofoofoo".split("foofoo").length - 1 === 1`,
> so `applyEditsToNormalizedContent("foofoofoo", [{oldText: "foofoo"}])` silently returns `"Xfoo"`
> with no ambiguity error.

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

**`async-jobs/await-tool.ts:98-105` — a race decided before it starts.** *~~High, verified.~~*

> ### ⛔ REFUTED — unreachable in production
>
> The code shape is exactly as described: the executor runs synchronously and `abortPromise` really is
> pre-settled when `signal` is `undefined`. **But no production path reaches that state.**
> `Agent.runWithLifecycle` (`pi-agent-core/src/agent.ts:470,482`) builds `new AbortController()` and
> calls `executor(abortController.signal)`; `AgentHarness` (`harness/agent-harness.ts:554,566`) does
> the same and threads it through `agent-loop.ts:1062-1065` →
> `executePreparedToolCall(prepared, signal, emit)` → `prepared.tool.execute(id, args, signal, …)`.
> `await_job` is registered only via `pi.registerTool(createAwaitTool(getManager))`
> (`async-jobs/index.ts:103`), i.e. through that same loop.
>
> **Defensive dead branch, not a live defect.** Downgrade to Low; still worth writing as
> `signal?.aborted` with the listener branch gated on `signal`.
>
> The two sub-findings stand: `notFound` is computed then dropped whenever ≥1 id resolved
> (`:44-58`), and `timeout` is unbounded — verified that `setTimeout(…, 3_000_000_000)` emits
> `TimeoutOverflowWarning` and fires in 2 ms, so `await_job` reports "Timed out after 3000000s"
> immediately.
>
> The original text follows for the record.
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

**[All four re-verified with live reproductions, but the root cause in item 1 is misdiagnosed — see
the correction under it.]** → eagle27272/gsd-pi#13

Four independent things have to be true for this to lose data, and all four are:

1. **The group key is a constant.** `topologyGroupKey:37-46` returns the literal string
   `"project-topology"` for any file under `.gsd`, `.gsd-worktrees`, `.gsd.migrating`, or
   `$GSD_STATE_DIR`. The `M\d+` milestone id is not part of the key. Every milestone's worktree
   evidence for the entire project lands in **one** group.

   > **⛔ Correction: the constant is not the root cause.** `topologyGroupKey:45` falls through to
   > `return file.entry.root_id;` for non-`.gsd` roots, and a repro on *that* branch
   > (`logical_path: "project"`, so key = `"arbitrary-root"`) triggered the bug just as well.
   > **Grouping is per-root under both branches, while every contributor is per-milestone.** The
   > constant only widens the blast radius by merging separate roots — proved separately in a repro
   > where `.gsd-worktrees` and `.gsd` merged and `.gsd/worktrees/M002/git-marker.txt` was dropped.
   > **Fixing only the constant would not fix this.** The group key must include the milestone id.
2. **Dispatch is first-match-wins.** Each `continue` abandons the whole group. So one anomalous
   milestone claims the group and every other milestone's evidence is never examined.
3. **The safety net is disarmed before it can fire.** `prepareFile:58` sets
   `file.parserId = "gsd-worktree-topology"` as its first statement — before any candidate exists.
   The unclaimed-file guard (`legacy-import-preview-supplemental.ts:68-71`) only throws for files
   still carrying the `UNCLAIMED_PARSER_ID` sentinel, so it never fires for these.
4. **Nothing downstream notices.** A file left at its default `outcome: "mapped"`
   (`legacy-import-preview-interpretation.ts:359`) with zero candidates and zero diagnoses passes
   every check in the pipeline (`composition.ts:243-260`, `:299-309`, `preview.ts:512-560`).

   > **Wording correction:** `composeSources` *is* bidirectional between the capture and the
   > interpreted sources (`SOURCE_UNCLAIMED` for captured-but-unowned, `SOURCE_UNKNOWN` for
   > owned-but-uncaptured). What is genuinely absent is any check that an owned source with
   > `outcome: "mapped"` actually **produced a candidate or a diagnosis**. The load-bearing part of
   > the claim holds; "no check anywhere runs source→candidate" was too broad.

   The contributors are **not** mutually exclusive by construction — a group can legitimately hold a
   stale-canonical M001 and a plain canonical M002, and the first claim aborts the rest. Verified.

   Reproductions: `.gsd-worktrees/M001/README.txt` + `.gsd/worktrees/M001/git-marker.txt` +
   `.gsd-worktrees/M002/git-marker.txt` → only `stale-canonical/M001/legacy` emitted, M002's marker
   produced no candidate. And `.gsd` symlink + malformed
   `state/projects/proj-abc/worktrees/M001/git-marker.txt` → **0 candidates, 0 diagnoses**, both files
   `outcome=mapped`.

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

**Fix:** **key groups per milestone rather than per root** (the necessary change, per the correction
above); run all five contributors unconditionally and let each claim only the files it actually
handles (filter on `file.outcome === "mapped"` inside `contributeMarkerRoots`); pass `diagnoses` to
`contributeExternalState`; and add the missing "every owned source must produce a candidate or a
diagnosis" assertion, which would have caught this class at the seam rather than in a review.

The test path is also mis-cited: it is
`src/resources/extensions/gsd/tests/legacy-import-preview-knowledge-root-worktree.test.ts:372-375`
(the report omitted the `src/resources/extensions/gsd/` prefix).

### This qualifies — but does not overturn — the report's "legacy-import is the model" claim

That claim was based on `legacy-import-backup.ts` and `legacy-import-live-restore.ts`, which
reviewed clean and genuinely do verify-before-destroy. Those findings stand. C31 is in a
*different* layer of the same subsystem — preview/interpretation rather than backup/restore — and
it shows the discipline is not uniform across the subsystem. Read the earlier praise as scoped to
the backup/restore path, not to everything under the `legacy-import-*` prefix.

---

## Late batch (last five files, folded in after the sections above)

### ⚠️ New shared-layer root cause — `resolveSlicePath` discards the slice ID

> **[RESOLVED on re-verification — promoted to Critical.]** The open question below is now settled in
> the worse direction, with a live reproduction. Jump to **"FLAT-PHASE ANSWER (resolved)"** at the end
> of this subsection. Two counts in the original write-up are also wrong: it is **31 call sites**, not
> 11, and **six** sites already compensate, not one. → eagle27272/gsd-pi#5

*Originally filed as High, possibly Critical. Verified chain; one link's direction unresolved
(stated below — now resolved).*

This is the most consequential item in the late batch, and it is not a per-file slip — it is a
defect in a shared path helper.

```ts
// paths.ts:918-929
const dir = resolveDir(slicesDir, sliceId);
if (dir) return join(slicesDir, dir);   // legacy layout: real per-slice dir
return mDir;                            // flat-phase (DEFAULT): sliceId discarded, never validated
```

Under the flat-phase layout — the default — `resolveSlicePath` returns the **milestone** directory
for *any* slice ID, including one that does not exist. So `existsSync(resolveSlicePath(...))` is
not a slice-existence check; it only proves the milestone exists.

~~I checked all 11 callers. `doctor-state-checks.ts` is the only one that knows~~ — **both counts are
wrong.** There are **31 invocations** (28 outside `paths.ts`), and **at least six** sites already
compensate for the flat-phase fallback inline rather than the helper being fixed:
`doctor-state-checks.ts:340` and `:403` (the report cited `:337`, drift 3), `escalation.ts:50`,
`tools/complete-task.ts:114`, `paths.ts:965` and `:1196`, `auto-verification.ts:133-140`.

The remaining callers null-check the return (`if (!slicePath) …`), which fires only when the
milestone is unresolvable. The "one sibling has the guard" framing is still directionally right —
six of 31 is not a design — but the helper is more widely known-broken than the report implied.

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

**What I could not determine at the time:** whether flat-phase projects actually place
`T##-SUMMARY` files in the milestone directory. `paths.ts:978` says flat-phase tasks are
"checkboxes inside plan files," which suggested they may not exist there at all. The two branches:

- If those files **are** present → the check scans milestone-wide and returns true on *another
  slice's* evidence. A verification gate passing on the wrong artifact. Critical.
- If they are **not** → `summaryFiles` is always empty and the check always returns false. A
  verification gate that never passes. Still a defect, opposite direction.

### FLAT-PHASE ANSWER (resolved)

**They are present. The gate passes on another slice's evidence. This is Critical.**

Four independent lines of evidence:

1. **Writers.** `markdown-renderer.ts:943-959` (`writeTaskSummaryProjection` → `targetTaskFile` →
   `paths.ts:1141-1163` → `join(milestoneDir, buildFlatTaskFileName(...))` → `<phaseDir>/S06-T03-SUMMARY.md`)
   and `tools/complete-task.ts:119-122` (`join(phaseDir, buildFlatTaskFileName(sliceId, taskId, "SUMMARY"))`).
2. **The reader is not slice-aware.** `paths.ts:253-258` matches `^S\d+-(T\d+)-SUMMARY\.md$` — the
   `S\d+` is **not** anchored to the requested slice — plus a legacy unqualified
   `^(T\d+)(?:-.*)?-SUMMARY\.md$`. `resolveTaskFiles` (`:325-336`) applies only that filter to the
   whole directory listing.
3. **A committed fixture builds exactly this layout.** `tests/auto-recovery.test.ts:2506-2540` creates
   `.gsd/phases/01-test/` with `01-01-PLAN.md`, `01-02-PLAN.md` and `S01-T03-SUMMARY.md`, with S01/S02
   sharing task id `T03`. Its comment at `:2530`: *"S02 never wrote S02-T03-SUMMARY.md; the sibling
   S01-T03-SUMMARY.md must not change S02/T03's canonical state."* That is issue **#1343** —
   **already fixed, but only inside `writeReactiveExecuteBlocker`, not in `artifact-verification.ts`.**
   `tests/gsd-recover.test.ts:831` independently writes `phases/09-team/S01-T01-SUMMARY.md`.
4. **Live reproduction.** With only `S01-T03-SUMMARY.md` on disk under `.gsd/phases/01-test`:

   ```
   sid=S01            resolveTasksDir=null  resolveTaskFiles(SUMMARY)=["S01-T03-SUMMARY.md"]
   sid=S02            resolveTasksDir=null  resolveTaskFiles(SUMMARY)=["S01-T03-SUMMARY.md"]
   sid=S99            …same…
   sid=TOTAL-GARBAGE  …same…
   ```

   So `artifact-verification.ts:312` returns `true` for S02, for a nonexistent S99, and for a
   syntactically invalid slice ID.

**The `paths.ts:978` comment does not contradict this.** "Tasks live as checkboxes inside plan files"
is about task **PLAN** artifacts only — `resolveTaskFile:999` short-circuits `suffix !== "PLAN"` to the
flat `S##-T##-SUFFIX.md` path, and `relTaskFile:1200-1205` does the same. SUMMARY / UAT / ESCALATION /
REOPEN are real separate files in the phase dir.

**Scope.** Only the non-batch branch (`artifact-verification.ts:309-313`) is affected; the batch branch
(`:315-322`) uses the slice-qualified `resolveTaskFile`. That branch's own fallback at `paths.ts:1002`
(`buildTaskFileName` → unqualified `T##-SUMMARY.md`) reopens the same collision for legacy-named files.

**Fix the root cause:** make `resolveSlicePath` return `null` for an unrecognized slice ID instead of
silently falling back to `mDir`, then fix whichever call sites newly (and correctly) fail.

**Two more sites in the same family, missed by the first pass:**

- `escalation.ts:56` — `join(sliceDir, \`${taskId}-ESCALATION.json\`)` into the shared phase dir. Two
  slices reusing task id `T03` overwrite each other's escalation.
- `reopen-reason.ts:44` — same for `${taskId}-REOPEN.json`. `writeReopenReason` clobbers a sibling
  slice's reopen reason and `readReopenReason` surfaces the wrong one at dispatch.

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

> ### ⚠️ Coverage caveat on point 3 — and on point 1
>
> **There are 24 schema files, not five.** The five reviewed are a 21% sample, and the phrase "all
> five DB schema files" reads as completeness in a report that also claims "Still unreviewed: 0".
>
> **This matters concretely for point 1.** `db-milestone-completion-schema.ts` — *not* among the five —
> does `DROP TRIGGER IF EXISTS trg_workflow_lifecycle_transition` at `:27` and recreates it at `:29`.
> So the C13 retraction quotes `db-lifecycle-foundation-schema.ts:76`, a definition that is
> **superseded at v43**.
>
> The conclusion happens to survive, and re-reading the actual v43 trigger strengthens it: the
> replacement additionally requires a matching `milestone.complete` row in `workflow_operations` for
> any milestone `ready`/`in_progress` → `completed` transition, and adds a slice `ready` → `completed`
> path. It factors the revision-monotonicity condition out of its `WHEN` clause, but
> `trg_workflow_lifecycle_causal_provenance` (still present, not dropped) owns that case and aborts on
> it independently.
>
> So the *finding* stands. But the retraction's own lesson — "read the enforcement site" — was applied
> one file short of the enforcement site.

Every Critical in this report lives in TypeScript. Not one is in SQL. That conclusion is unchanged by
the caveat above, and was independently reinforced: `db/writers/authority-recovery.ts` re-reviewed
clean. Two practical consequences:

- **When TS and SQL appear to disagree about an invariant, read the schema before believing the
  reviewer.** This is the specific mistake that produced the C13 false positive, and reviewer
  agreement did not catch it — both agents shared the blind spot.
- **The team already knows how to express invariants declaratively and does it well.** Several
  findings here — the unvalidated identifier sinks, the missing source→candidate accounting in
  C31, the actor-identity asymmetry in `slice-lifecycle-domain-operation.ts` — are invariants that
  could be pushed down into the layer that has a demonstrated track record of holding them.

---

## Filed issues

23 issues were opened on `eagle27272/gsd-pi` from the re-verified findings.

| # | Title |
|---|---|
| [#4](https://github.com/eagle27272/gsd-pi/issues/4) | `edit` rewrites the whole file on any fuzzy match; diff preview conceals it (C34) |
| [#5](https://github.com/eagle27272/gsd-pi/issues/5) | Flat-phase `resolveSlicePath` — verification gate passes on another slice's summaries |
| [#6](https://github.com/eagle27272/gsd-pi/issues/6) | `reconcileWorktreeDb` silent zero-counts; all 4 callers ignore, then delete (C16) |
| [#7](https://github.com/eagle27272/gsd-pi/issues/7) | `milestoneMergedInPhases` has no milestone identity (C30) |
| [#8](https://github.com/eagle27272/gsd-pi/issues/8) | 3 of 18 `execFileSync` git calls skip the env scrub, incl. `reset --hard` (C23) |
| [#9](https://github.com/eagle27272/gsd-pi/issues/9) | Unvalidated `task_id` → arbitrary file write (C7) |
| [#10](https://github.com/eagle27272/gsd-pi/issues/10) | Extension `secure_env_collect` lacks all MCP hardening (C27 + NEW-C35) |
| [#11](https://github.com/eagle27272/gsd-pi/issues/11) | `doctor` destructive ops without the `shouldFix` gate (C17, C20, C21, C22, C29-caveat) |
| [#12](https://github.com/eagle27272/gsd-pi/issues/12) | Worktree merge/teardown fail-open set + invisible quarantine (C24, C25/26, C9, C8a) |
| [#13](https://github.com/eagle27272/gsd-pi/issues/13) | Legacy import drops milestone worktree evidence (C31) |
| [#14](https://github.com/eagle27272/gsd-pi/issues/14) | Failed/SIGKILLed subagent reports exit 0, diff merged (C14 + `exec.ts`/`bash.ts`) |
| [#15](https://github.com/eagle27272/gsd-pi/issues/15) | `browser_emulate_device` bricks the session (C33) |
| [#16](https://github.com/eagle27272/gsd-pi/issues/16) | `crash-recovery` lock liveness has no host check |
| [#17](https://github.com/eagle27272/gsd-pi/issues/17) | Auto-loop verification gates that cannot fail |
| [#18](https://github.com/eagle27272/gsd-pi/issues/18) | browser-tools ref staleness; `browser_assert` passes on 0 checks |
| [#19](https://github.com/eagle27272/gsd-pi/issues/19) | bg-shell ignores `event.reason`; empty manifest; restart mis-anchors selection (C2) |
| [#20](https://github.com/eagle27272/gsd-pi/issues/20) | `secure_env_collect`: the AI chooses where the secret is written (C32) |
| [#21](https://github.com/eagle27272/gsd-pi/issues/21) | Unvalidated identifiers at destructive sinks (C15, C5, C12) |
| [#22](https://github.com/eagle27272/gsd-pi/issues/22) | `scope.milestone_id` vs `milestoneId` case mismatch (C1) |
| [#23](https://github.com/eagle27272/gsd-pi/issues/23) | Session layer: non-injective cwd mapping, compaction message loss, `fork()`, `/share` |
| [#24](https://github.com/eagle27272/gsd-pi/issues/24) | Tools reporting success on failure: ollama pull, shell-output, find |
| [#25](https://github.com/eagle27272/gsd-pi/issues/25) | Enable `noUnusedLocals`/`noUnusedParameters`; no lint step exists |
| [#26](https://github.com/eagle27272/gsd-pi/issues/26) | Guard gaps: post-abort rejection, ReDoS guard, `rm -fr`, PID 1 (C4, C11, C3, C28) |

### Not re-verified — treat with the report's original confidence, not more

The adversarial pass covered every Critical and the load-bearing Highs. These groups were **not**
re-checked and no issues were filed for them:

- **Credential storage** (the six `auth.json` / `keys add` / `keys rotate` findings)
- **github-sync** (per-task issue creation, `ghMergePR` result discarded)
- **MCP server** (`parseInt` selection, Telegram cursor, `ghAddToProject`, GraphQL injection)
- **subagent isolation** (symlink dereferencing, predictable patch path, baseline commit)
- **Slash commands** (`/gsd park`, `--force` prefix match, `--name`, `workflow uninstall`)
- Most **P1–P16** cross-cutting pattern *counts* — the individual instances cited under Criticals were
  checked, the aggregate counts were not (and where counts *were* checked, three were wrong: P13's
  18 → 17, the `allowFailure` helpers' 17 → ~20, `resolveSlicePath`'s 11 → 31). **Treat every
  unverified count in this report as approximate.**

---

**The legacy-import subsystem is the model.** Two thorough reviews, essentially zero findings:
verify-before-destroy, independent re-derivation on a fresh read-only connection, identity re-checks
around every read, consent bound into the intent hash. The worktree subsystem does equally
destructive things with none of it. This is not a codebase that lacks the right patterns — it
applies them rigorously in one place and barely at all next door.

---

## Process recommendation → eagle27272/gsd-pi#25

No `noUnusedLocals`/`noUnusedParameters` in any of the **21** tsconfigs (the report said 10), and no
lint step at all — verified: no eslint, biome or oxlint config or dependency anywhere in the repo.
The only static check is `tsc --noEmit` (`typecheck:extensions`).

That is mechanically why the following survived multiple commits of churn and code review:

- `src/resources/extensions/gsd/auto-recovery.ts:456` — `hasAdoptedMilestoneHistory`, a non-exported
  local guard function with **zero** call sites repo-wide.
- `src/resources/extensions/gsd/auto-recovery.ts:19-20` — `getSlice` and `getSliceTasks` imported and
  never used. **Correction:** the report attributed these vaguely, and a re-check confirmed they are
  *not* in `milestone-closeout.ts` (which never imports them). Both orphans and the dead function are
  in `auto-recovery.ts`.
- `native-git-bridge.ts:8` — `execSync` imported, zero call sites.
- `browser-tools/tools/device.ts:56` — `const suggestions = …` assigned, never read.
- `auto-dispatch.ts:45`, `auto.ts:50`, `workspace-index.ts:8` — `resolveSlicePath` imported, zero call
  sites in each.

**The two most damaging findings in this report share a shape these flags would *not* catch:** a dead
*field*. `browser-tools/state.ts:88`'s `frameContext` and `edit-diff.ts:70`'s `contentForReplacement`
are both written at multiple sites and never read, and in each case the guard they exist to enable
was never written. Worth a lint rule that flags never-read object properties, not just unused locals.
