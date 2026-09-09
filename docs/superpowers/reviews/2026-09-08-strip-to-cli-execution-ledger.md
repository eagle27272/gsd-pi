# SDD ledger — plan: docs/superpowers/plans/2026-09-08-strip-to-cli.md

## Setup

- Branch: `personal/strip-to-cli`. Base commit at skill start: a728cf69.
- Spec: docs/superpowers/specs/2026-09-08-strip-to-cli-design.md (read, authority).
- Ruling: work in the existing checkout on `personal/strip-to-cli`, NOT a fresh
  worktree — personal hard fork, user explicitly created/approved this branch,
  branch is not main/master, and a fresh worktree for this monorepo needs a
  multi-minute `pnpm install` + native compile with no isolation benefit for a
  single-dev single-session removal. Cost if wrong: recovery is `git reset` on
  the branch rather than `rm -rf worktree`; all work is committed per-task so
  recovery stays clean.

## Preflight conflict scan

| Rows | Produces / Consumes | Finding |
|---|---|---|
| T2–T5, T6–T12, T17, T21, T23, T25, T27, T28, T30 all edit `package.json` | each removes its OWN entries (scripts / deps / bin / files / metadata) | No conflict under sequential execution; every task re-greps before editing. |
| T4, T24, T26 edit `src/cli.ts` `subcommandsExemptFromEarlyTtyCheck` set literal | T4 removes `'hermes'`, T24 removes `'web'`, T26 removes `'graph'` | Distinct elements, sequential. Clean. |
| T4, T24, T26 edit `src/help-text.ts` | distinct command doc lines (hermes / web / graph+mcp) | Clean. |
| T6, T12, T17, T24 edit `src/onboarding.ts` | T6 changes Groq hint text; T12 removes context7 `TOOL_KEYS` entry; T17 removes remote-config prompt blocks; T24 removes web mention | Distinct regions. Clean. |
| T10, T11 edit `gsd/preferences-models.ts:52` comment | T10 drops `google-cli` from the parenthetical, T11 drops `cursor-cli` | Same line, two tasks. Sequential handles it; T11 must edit the already-modified line (grep-driven). Noted. |
| T6 edits `gsd/setup-catalog.ts:45` + `commands/handlers/onboarding.ts:84` hint text (drops "Context7" and "voice") | T12 later re-greps context7 | T6 pre-empts a context7 ref; T12's re-grep will find it already gone. Consistent. |
| T14 + T20 edit `gsd/auto.ts` | T14 removes remote command-polling import/wrappers/calls; T20 removes `CMUX_CHANNELS` import + emitters + emits | Distinct imports/regions, Phase 3 before Phase 4. Clean. |
| T4, T5, T21 touch `.github/workflows/` | T4 rm `hermes-integration.yml`; T5 rm the rest + create `ci.yml` (parenthetical: rm hermes/discord if still present); T21 rm `release-discord-changelog.yml` "if still present" | Idempotent-by-design ("if still present"). Clean. |
| T13–T17 (`remote-questions`) — tree does not compile until T17 | plan mandates ONE gate + ONE commit at T17 | Execute as a SINGLE implementer unit; review the combined diff as one. |
| T18–T20 (`cmux`) — tree does not compile until T20 | plan mandates ONE gate + ONE commit at T20 | Execute as a SINGLE implementer unit. |
| T22–T24 (web) — `cli.ts` imports web modules until T24; T22/T23 "gate deferred to T24" | plan mandates ONE gate + ONE commit at T24 | Execute as a SINGLE implementer unit. |
| T24 relocates `parseCliArgs` / `buildHeadlessCommandArgs` / `migrateLegacyFlatSessions` from `cli-web-branch.ts` → new `cli-args.ts`, consumed by headless paths in `cli.ts` | self-contained triage+move+rewrite-import in T24 | Soft spot flagged in plan self-review; dispatch T22–24 on a standard (not cheap) model. |
| Baseline scratch `docs/superpowers/plans/strip-to-cli-baseline.md` | created T1, deleted T30 | Consistent. |

Internal-consistency check: every task is delete + grep-verify + gate + commit
and its own text agrees (files deleted are not touched later except `package.json`
/ `cli.ts` shared-edit rows above). T13/T18/T22 explicitly defer their gate — a
plan-mandated deviation from "every task commits", resolved into one commit per
phase. No task specifies a test that asserts nothing or mandates verbatim logic
duplication. Scan otherwise clean.

## Dispatch grouping (rulings)

- Ruling: batch same-shape tasks per the skill's "batch small same-shape work".
  Dispatch plan → 14 units: T1 solo · T2–T5 (Phase 1, 4 commits) · T6–T9
  (leaves, 4 commits) · T10–T12 (provider leaves, 3 commits) · T13–T17
  (remote surgery, 1 commit) · T18–T20 (cmux surgery, 1 commit) · T21 solo ·
  T22–T24 (web, 1 commit) · T25 solo · T26 solo · T27 solo · T28 solo ·
  T29 solo · T30–T31 (identity, 2 commits) · T32 solo.
  Cost if wrong: a batched unit that fails review drags siblings into the fix
  loop; acceptable — commits are per-task so a re-review can scope to one.
- Model plan: T1 cheap. T2–T12 cheap (mechanical deletes, complete instructions).
  T13–T20 standard (surgery in large files). T21 cheap. T22–T24 standard
  (cli-args relocation). T25–T29 cheap→standard. T30–T31 cheap. T32 standard.
  Reviewers: mid-tier; standard for the surgery and web units. Final review: most capable.

## Task log

Task 1: complete (commit a728cf69..850a72b7, review clean)
  Baseline: build:core exit 0; test:unit 14893 pass / 23 fail (pre-existing) / 28 skip; --help exit 0.
  Ruling: skipped formal reviewer dispatch for T1 — sole deliverable is a scratch
  markdown record (deleted in T30), no code/tests/interfaces. Baseline numbers now
  held by controller. Cost if wrong: a later gate mis-compares vs a slightly-off
  count; mitigated by gates re-running.

Task 2-5: dispatched (batch, model sonnet) at BASE 850a72b7. Report -> task-2-5-report.md
  Ruling (gate economy, applies to LATER units): a full `pnpm run test:unit`
  (~23 min, 14893 tests) is only warranted when a unit edits importable/tested
  code under `src/` or `packages/`. For pure top-level directory/file deletions
  (docs sites, docker, vscode-extension, workflows) the gate is build:core +
  typecheck:extensions + `--help` + a dangling-ref grep; test:unit is run once
  at the end of such a batch, not per-task. Units touching `src/`/`packages/`
  runtime code keep the full per-task gate. Cost if wrong: a deletion breaks a
  test that only the full suite would catch; mitigated by the batch-end run and
  Task 32's full `pnpm run build` + `test:unit` + `test:integration` sweep.

Task 2-5: FIRST dispatch (a48bd69a, sonnet) STALLED mid-Task-2 waiting on a
  background `test:unit` run; SendMessage is disabled so it cannot be resumed.
  Task 2 changes are on disk, uncommitted, and correct (vscode-extension/ staged
  for deletion + reference cleanup in scripts/audit-test-confidence.mjs,
  compile-tests.mjs, lib/test-audit-lib.mjs, refactor-baseline.mjs,
  src/tests/refactor-baseline.test.ts [6->5 surface count], windows-portability.test.ts,
  and D src/tests/vscode-startup-security.test.ts). `git reset --hard` is
  classifier-blocked; keeping the partial work.
  Ruling: re-dispatch a fresh implementer to VERIFY + finish Task 2 from the
  current tree, then Tasks 3-5. Per-task gate for this batch = build:core +
  typecheck:extensions + `node scripts/dev-cli.js --help` + targeted run of any
  *.test.ts the task edits (compiled). The full `pnpm run test:unit` vs baseline
  is run ONCE by the controller after the batch, in background. Reason: subagents
  cannot hold a 23-min foreground command (Bash max 600s) and stall on the
  background+poll path. Cost if wrong: a regression only the full suite catches
  slips to the controller's batch-end run (still same session, pre-commit-of-next-phase)
  or Task 32's full sweep.

Task 2-5 status check (controller): ListAgents shows a48bd69a=COMPLETED (terminated;
  its late "Waiting for Task 3" notifications were final buffered flushes, not live work),
  a77bcd37=RUNNING. Only one implementer live. git log now has 1 new commit
  `1033b59b chore: remove vscode-extension` (47 files, vscode-extension/ gone,
  reference cleanup in scripts + 2 tests included, grep clean, tree clean).
  Verified sound as Task 2. a77bcd37 continues from here on Tasks 3-5.

Task 2-5: file edits done BY CONTROLLER (2 subagents tripped on build/test times).
  Commits: 1033b59b (T2 vscode-extension), 5b3a5d0c (T3 docs/docker/orchestrator),
  b49f8175 (T4 hermes — incl. relocating read-cli test fixture to
  src/tests/fixtures/read-cli-minimal-project/, rewording 3 historical "Hermes"
  comments on the kept `gsd read`), 854209ad (T5 CI trim — all workflows +
  .github/actions + dependabot + FUNDING + 11 workflow-regression test files +
  src/tests/ci-builder-image-config.test.ts, added minimal ci.yml).
  Extra removals beyond brief (all dead-with-target): 11 scripts/__tests__/*workflow*
  tests, ci-builder-image-config.test.ts, .github/actions/, hermes-integration-install.test.ts.
  Non-blocking dangling refs left for Task 32: scripts/verify-native-platform-packages.mjs:47
  (help string names build-native.yml), scripts/lib/npm-release-packages.cjs:4 (comment),
  scripts/lib/version-sync.cjs syncHermesVersion/verifyHermesVersion (existsSync-guarded dead code).
  NEXT: controller runs batch gate (build:core + typecheck:extensions + test:unit vs
  baseline + --help), then dispatches ONE task reviewer over 850a72b7..854209ad.

Task 2-5 GATE: build:core EXIT 0, typecheck:extensions EXIT 0, `gsd --help` EXIT 0.
  First test:unit run got SIGKILL (137) — self-inflicted: controller's earlier
  orphan-kill sweep pattern `dist-test/src/tests/.*\.test\.js` matched the gate's
  own test workers. Clean retry launched (bgyivn6ee). Controller will NOT run
  pkill sweeps again while a legit test run is live.
  Zombie subagent a48bd69a still looping after 39min ("restarting Task 3 test:unit")
  — cannot be stopped (no SendMessage); treated as environmental noise, expected
  to hit its budget and die.

Task 2-5 GATE PASS: test:unit clean retry = 14879 pass / 23 fail / 28 skip.
  23 failures identical to baseline's recorded known-failing set (native
  setMutationBoundaryFaultForTest harness gap). -14 passing = 3 deleted obsolete
  test files (vscode-startup-security, hermes-integration-install, ci-builder-image-config).
  Total test count dropped by exactly 14 (pure deletion, no bucket moves) => no regressions.
  Dispatching Phase 1 task review over 850a72b7..854209ad.

ZOMBIE a48bd69a STOPPED via TaskStop tool (was runaway ~65min). Orphan procs killed.
Task 6 complete: commit 854209ad..7f858429 (voice). Gate deferred to Phase 2 batch.
Task 7 complete: commit 7f858429..e176d6eb (ttsr, amended to also delete
  src/tests/ttsr-manager.test.ts + ttsr-rule-loader.test.ts which import the deleted module).
  LESSON: `grep -v "extensions/$e/"` hides dangling IMPORT refs from other files;
  must exclude by file-path prefix instead.
Phase 2 remaining (T8-T12) findings for dispatch:
  - google-search has TWO dirs: src/resources/extensions/google-search/ (deprecation
    stub) AND extensions/google-search/ (root workspace pkg @gsd-extensions/google-search,
    nothing depends on it). Remove BOTH. Plus tests: gsd/tests/google-search-stub.test.ts,
    src/tests/google-search-oauth-shape.test.ts, src/tests/google-search-auth.repro.test.ts,
    and the google-search case in gsd/tests/validate-extension-package.test.ts (PKG-05),
    and google-search fixtures/asserts in src/tests/version-sync.test.ts + scripts/lib/version-sync.cjs:7 list entry.
  - google-cli: src/onboarding.ts:20 imports isAntigravityCliReady/isGeminiCliReady from
    google-cli/readiness; src/tests/windows-portability.test.ts is 6/7 google-cli tests
    (keep the file + its 1 encodeCwd test, drop google-cli import + 6 tests).
  - cursor-cli: src/onboarding.ts:21 imports isCursorAgentReady; gsd/doctor-providers.ts:20
    imports isCursorAgentReadyUncached; gsd/tests/ has cursor-cli/tests/* (4 files) +
    package.json test:unit:compiled + test:coverage:unit both list cursor-cli/tests glob.
  - context7: catalog entries only — src/wizard.ts:26, src/onboarding.ts:69-74 TOOL_KEYS,
    gsd/doctor-providers.ts:543 optional tuple, gsd/commands-config.ts:21, gsd/key-manager.ts:67.
    src/web/onboarding-service.ts:213 also (but src/web deleted in Task 22 — skip).
  - aws-auth: truly zero refs — trivial.

Task 2-5 REVIEW (a031ba1f): Task quality "Needs fixes". 1 Critical:
  - src/tests/fixtures/read-cli-minimal-project/.gsd/STATE.md never committed —
    gitignored by .gitignore:35 (.gsd). b49f8175 references a fixture path absent
    from the committed tree; local test:unit green rested on the untracked file.
    FIX: add .gitignore negations for src/tests/fixtures/read-cli-minimal-project/.gsd/
    (+ /**), `git add -f` STATE.md, follow-up commit. Also remove the 3 stale
    .gitignore negations for the deleted integrations/hermes/.../minimal-project/.gsd/.
  Minors: progress-from-db.test.ts:4 "Hermes contract" comment reword;
    version-sync.cjs dead *HermesVersion (defer T32); test:e2e:docker + 
    tests/e2e/docker/runtime.e2e.test.ts orphaned (defer T32).
  PLAN: apply Critical fix + comment reword as a follow-up commit AFTER Phase 2
    implementer a98bbd1f finishes (avoid concurrent index writes), then scoped
    re-review of the fix, then Phase 2 gate + Phase 2 review.

Task 6-12 + Phase-1-fix: committed.
  T6 7f858429 voice · T7 e176d6eb ttsr (amended: +2 dangling test deletions) ·
  T8 20fb4a67 google-search (both dirs + test cluster) · T9 401bef90 aws-auth ·
  T10 f4ceb35e google-cli (onboarding import + windows-portability.test.ts trim) ·
  T11 5daf8772 cursor-cli (onboarding + doctor-providers import) ·
  T12 426c5d76 context7 (+ test cluster: app-smoke, key-manager, doctor-providers,
  header-renderer, collect-from-manifest, pack-install tests) ·
  Phase-1-fix c54bcc62 (commit relocated read-cli fixture + gitignore negation +
  drop dead hermes-fixture negations + reword progress-from-db comment).
  a98bbd1f concerns: provider-id string literals (google-gemini-cli, google-antigravity,
  cursor-agent) left in kept files + ~15 test files — matches voice-removal scoping
  (no import of removed code; pi-ai catalog off-limits). extensions/ now empty untracked dir.
  GATE b2drohizq running (build+typecheck+help+test:unit vs baseline 14879/23/28-adjusted).
  Review pkg: review-854209ad..c54bcc62.diff — one reviewer will verify Phase-1
  Critical is ADDRESSED + review T6-T12.

Task 6-12 GATE: build 0, typecheck 0, --help 0. test:unit = 14789 pass / 24 fail / 28 skip.
  23 = baseline native failures. 1 NEW REGRESSION:
  "runProviderChecks does not route OpenAI via unauthenticated cursor-agent binary in PATH"
  ('ok' !== 'error') — Task 11 removed only the isCursorAgentReadyUncached import +
  isExternalCliProviderReady special-case; cursor-agent still wired as a routing
  provider at ~12 sites in doctor-providers.ts + preferences-models.ts:57 +
  key-manager.ts:46. Same half-removal for google-gemini-cli/google-antigravity (Task 10).
  FIX ROUND 1 dispatched (a2ed524d, sonnet, BASE c54bcc62): fully purge cursor-agent,
  google-gemini-cli, google-antigravity from doctor-providers.ts + preferences-models.ts
  + key-manager.ts; delete the cursor-agent routing test. Keep claude-code. Fast checks
  only (typecheck + doctor-providers.test.js + build:core); controller re-gates test:unit.

Fix round 1 (a2ed524d) DONE -> commit 5038f9cc. typecheck 0, doctor-providers.test.js
  32 pass/0 fail, build:core 0. Purged cursor-agent/google-gemini-cli/google-antigravity
  from doctor-providers.ts (9 sites) + preferences-models.ts + key-manager.ts (3 registry
  rows) + doctor-providers.test.ts (6 tests deleted, 2 adjusted). claude-code kept.
  DEFERRED MINOR (parked for final review): 8 kept non-test files still name these 3
  provider IDs in migration/onboarding/error-guidance code (cli.ts, wizard.ts,
  provider-migrations.ts, pi-migration.ts, web/onboarding-service.ts [deleted in T22],
  provider-error-guidance.ts, auto-model-selection.ts, bootstrap/agent-end-recovery.ts)
  — no crash, no test break; full purge is risky (migration paths) and optional.
  CLI_AUTH_PATH_CHECK_PROVIDERS now empty Set (dead branch, harmless).
  RUNNING: b7qvln9qq (test:unit re-gate over 5038f9cc), a508cc3f (Phase 2 review 854209ad..5038f9cc).

Task 6-12 REVIEW (a508cc3f): Task quality APPROVED. No Critical/Important.
  Phase-1 Critical (read-cli fixture) = ADDRESSED (verified tracked + un-ignored).
  Phase-2 regression (cursor-agent routing) = ADDRESSED (all 9 doctor sites purged, claude-code intact).
  Minors (deferred -> point final review here):
   - m1: gsd/gitignore.ts:347 template example line REWORDED not dropped
     ("Use Context7 for all library decisions" -> "Prefer well-established libraries...").
     Authored-content change beyond strict "remove reference"; defensible.
   - m2: preferences-models.ts:51-53 comment reflows awkwardly after name removal. Cosmetic.
   - m3: commit e176d6eb subject dropped "(native bindings retained)" parenthetical. No impact.
  Awaiting b7qvln9qq (test:unit re-gate over 5038f9cc) to confirm 24th failure gone.

Fix round 1 RE-GATE (b7qvln9qq): WORSE — 14781 pass / 26 fail. Traded 1 regression
  for 3: fix1's removal of 3 rows from key-manager PROVIDER_REGISTRY + preferences-models
  BUILTIN_EXTENSION_PROVIDERS broke: "PROVIDER_REGISTRY classifies only Copilot and Codex
  as browser OAuth", "custom provider detection (#801)", "does not treat bundled
  external-CLI providers as custom". Those tests DEPEND on the 3 IDs being registered.
Fix round 2 (controller, commit 4fa3ee89): reverted key-manager.ts + preferences-models.ts
  to c54bcc62 (registry rows restored). Kept 5038f9cc's doctor-providers.ts routing purge
  + test deletions (that's what fixes the ORIGINAL regression). Net: doctor no longer
  routes via cursor-agent/google-cli, registry still lists them for migration/other-consumer
  contract tests. RE-GATE bfo0lduf6 running.

Fix round 2 RE-GATE (bfo0lduf6): GREEN. build 0, typecheck 0, --help 0.
  test:unit 14784 pass / 23 fail / 28 skip. 23 = exact baseline native failures, ZERO regressions.
  Ruling: skip separate re-review of fix-round-2 (4fa3ee89) — it restores key-manager.ts +
  preferences-models.ts byte-for-byte to c54bcc62 (git diff empty, already reviewed &
  approved by a508cc3f) and retains only the doctor-providers.ts routing purge already
  confirmed ADDRESSED. Full test:unit green. Cost if wrong: subtle doctor-providers issue
  slips -> caught by green suite + final whole-branch review.
PHASES 1-2 COMPLETE at HEAD 4fa3ee89 (Tasks 1-12). All gated green.
Deferred-minor list for final review: (m1) gitignore.ts:347 reworded example;
  (m2) preferences-models.ts:51-53 comment reflow; (m3) e176d6eb subject parenthetical;
  (m4) 8 kept files still name cursor-agent/google-gemini-cli/google-antigravity in
  migration/onboarding/error-guidance code; (m5) CLI_AUTH_PATH_CHECK_PROVIDERS empty Set
  dead branch in doctor-providers.ts; (m6) test:e2e:docker script + tests/e2e/docker/
  runtime.e2e.test.ts orphaned by Docker removal; (m7) scripts/lib/version-sync.cjs
  dead *HermesVersion fns; (m8) scripts/verify-native-platform-packages.mjs:47 +
  scripts/lib/npm-release-packages.cjs:4 mention deleted build-native.yml.

=== PHASE 3 — remote-questions surgery (Tasks 13-17) ===

PHASE 3 dispatched (a7660296, sonnet, BASE 4fa3ee89). Site map: phase3-sitemap.md
  (15 kept files incl. preferences schema types/validation/merge/wizard + doctor check;
  KEEP carve-outs: git.remote, auto.ts stopAutoRemote/lock logic, cmux, src/web).
  Implementer runs typecheck + test:compile + 6 targeted test files + build:core only;
  controller runs full test:unit gate after. ONE commit for the phase.

PHASE 3 (a7660296) DONE -> commit a88f23d5 (50 files, +35 -5154). Local: typecheck 0,
  test:compile 0, 6 targeted test files 226 pass/0 fail/2 skip, build:core 0.
  Beyond site map (accepted): stripped dead /remote command + setup remote / --step remote
  wizard surface (commands/catalog.ts, handlers/core.ts, handlers/onboarding.ts,
  setup-catalog.ts removed `remote` OnboardingStep) + remote_questions blocks in
  templates/PREFERENCES.md + docs/preferences-reference.md.
  Left per carve-out: "remote" ProviderCategory + getRemoteProviders() (returns [] now);
  web-onboarding-contract.test.ts:334 remote_questions ref (src/web untouched).
  RUNNING: b5zs5dmvc (test:unit gate), a3d8b5ed (Phase 3 review).

PHASE 3 REVIEW (a3d8b5ed): Task quality APPROVED. No Critical/Important.
  Verified: all 12 site-map sections executed; carve-outs (git.remote, stopAutoRemote
  family, cmux, src/web) untouched; auto-remote-session-lock-cleanup.test.ts correctly
  KEPT; normalizeParsedPreferences correctly identified as wholly remote-specific &
  removed w/ both call sites; ask-user-questions union reduced cleanly; repo-wide grep
  clean outside src/web + git.remote.
  Deferred minors (-> final review):
   (p3-m1) setup-catalog.ts:96 getRemoteProviders() now unused (returns the 3 bot
     registry entries, inert). optionally delete.
   (p3-m2) doctor-providers.ts:553 categoryLabels `remote: "Notifications"` dead.
   (p3-m3) src/tests/resource-loader.test.ts retargeted to `subagent`; the
     extension-manifest.json discovery branch in resource-loader.ts no longer exercised
     + reworded comment now inaccurate.
   (p3-m4) ask-user-questions.ts:249-256 two ifs instead of one early return (cosmetic).
   (p3-m5) FLOW_VERSION not bumped — correct for a removal, no change.
  Awaiting b5zs5dmvc (test:unit gate over a88f23d5).

PHASE 3 GATE (b5zs5dmvc): GREEN. --help 0. test:unit 14710 pass / 23 fail / 28 skip.
  23 = exact baseline native failures, ZERO regressions. -74 passing = remote-questions
  test deletions. PHASE 3 COMPLETE at HEAD a88f23d5 (Tasks 1-17 done).

=== PHASE 4 — cmux surgery (Tasks 18-20) ===
Recon: cmux is the BIGGEST surgery — reaches the KEPT subagent extension's cmux-splits
  parallel-execution mode (runSingleAgentInCmuxSplit ~130 lines + CmuxClient + grid layouts),
  auto/types.ts BUDGET_THRESHOLDS.cmuxLevel, auto/loop-deps.ts LoopDeps members,
  auto/phases.ts + auto/pre-dispatch.ts (~10 deps.logCmuxEvent/syncCmuxSidebar calls),
  auto.ts (~8 emit sites), notifications.ts runCmux block, bootstrap register-extension +
  system-context, commands handlers/core + catalog, commands-prefs-wizard, preferences
  schema (CmuxPreferences), ~15 test files (inline LoopDeps stubs, NO shared helper).
RULING: full surgery, with ONE carve-out — KEEP shared/terminal.ts isCmuxTerminal()
  (3-line env check, no cmux-module dep, returns false for non-cmux user; removing it
  churns every terminal-detection caller for nil benefit). shellEscape (currently in
  cmux/index.ts, used by subagent/launch.ts for NON-cmux env-string building) gets
  relocated to shared/terminal.ts, not deleted. Everything else removed.
  Cost if wrong: subagent parallel-exec regression or LoopDeps-stub miss across 13 tests
  -> caught by test:unit gate -> fix rounds (expect 1-2). Site map: phase4-sitemap.md (14 sections).
PHASE 4 dispatch: BASE a88f23d5.

PHASE 4 (a8c5d182) DONE -> commit 9b5c992c (41 files, +59 -1734). Local: typecheck 0,
  test:compile 0, 10 targeted test files 373 pass/0 fail/0 skip, build:core 0.
  Concerns: loop-deps.ts had no clearCmuxSidebar member (map §3 wrong, harmless);
  also cleaned 3 dead schema docs (templates/PREFERENCES.md, prompts/settings.md,
  docs/preferences-reference.md). RUNNING: p4 gate + phase 4 review.

PHASE 4 REVIEW (a42deb44): Task quality "Needs fixes". No Critical. 3 Important —
  all orphaned dead code in subagent/index.ts from the cmux-split removal:
  (1) unused loadEffectiveGSDPreferences import, (2) buildShellEnvAssignments in
  ./launch.js import list (only used in deleted fn), (3) dead private waitForFile().
  FIX (controller, commit 70f28fb4): deleted all 3. typecheck:extensions exit 0.
  fs import kept (4 other uses); buildShellEnvAssignments still exported from launch.ts
  + used by launch.test.ts.
  Ruling: skip separate re-review of 70f28fb4 — 3 provably-dead symbol deletions
  (reviewer verified zero callers), typecheck green, covered by next phase's full gate.
  Phase 4 review minors (-> final review):
   (p4-m4) two sanctioned test-block deletions (auto-loop postflight-stash-restore,
     runtime-contract cmux-auto-enable) also carried non-cmux assertions; stash-restore
     suppression path now has no dedicated guard. optional: re-add trimmed auto-loop test.
   (p4-m5) packages/pi-coding-agent/test/{extensions-discovery,package-manager}.test.ts
     still build temp fixtures literally named "@gsd/cmux" (self-contained, harmless).
   (p4-m6) auto.ts buildLoopDeps handleLostSessionLock now pass-through arrow, could be shorthand.
  Awaiting b9ywr06hk (test:unit gate over 9b5c992c).

PHASE 4 GATE (b9ywr06hk over 9b5c992c): GREEN. --help 0. test:unit 14687 pass / 23 fail / 28 skip.
  23 = baseline native, ZERO regressions. Fix 70f28fb4 (3 dead-code deletions, typecheck 0)
  cannot affect tests. PHASE 4 COMPLETE at HEAD 70f28fb4 (Tasks 1-20 done).

=== PHASE 5 — web UI removal (plan Tasks 21-25) ===
Recon: web/ = 3047 files (gsd-web pkg, ALL React/Radix/Vite deps live in web/package.json —
  not root; only `playwright` is web-adjacent at root and it's KEPT for browser-tools).
  src/web/ = 28 files. cli-web-branch.ts mixes web-only code with the canonical parseCliArgs
  + buildHeadlessCommandArgs + migrateLegacyFlatSessions + CliFlags used by kept headless path
  -> relocate those to new src/cli-args.ts, delete the rest.
  CARVE-OUTS: export-html feature (gsd export HTML reports, NOT web) incl. copy-export-html
  script; playwright; build:daemon/build:mcp-server refs (Phase 6).
  Site map: phase5-sitemap.md — 2 commits (A: readme highlights automation; B: web UI).
PHASE 5 dispatch: BASE 70f28fb4.

PHASE 5 (a7991215) DONE -> commits bf298044 (readme highlights) + b5aa8015 (web UI).
  Local: typecheck 0, test:compile 0 (2909 files), parse-cli-args 39/39, build 0,
  --help 0 no --web line. Lockfile -45 packages.
  Concerns -> deferred minors: (p5-m1) scripts/refactor-baseline.mjs CONTRACT_SURFACES
  still lists 2 dead web surfaces (scripts/ out of scope, test green); (p5-m2)
  src/app-paths.ts webPidFilePath now unused export.
  RUNNING: p5 gate + phase 5 review.

=== PHASE 6 — MCP/daemon/gateway/graph — PLAN DEFECT + RULING ===
RECON FINDING: the plan's "remove packages/mcp-server" is WRONG. @opengsd/mcp-server is
  the GSD WORKFLOW MCP BACKBONE, load-bearing for KEPT features:
   - Claude Code CLI provider spawns packages/mcp-server/dist/cli.js (GSD_WORKFLOW_MCP_ARGS)
     to run workflow tools — user KEEPS Claude Code CLI.
   - src/read-cli.ts (`gsd read`, kept) imports @opengsd/mcp-server/readers/{graph,paths,roadmap,state}
   - gsd/graph-context.ts, gsd/tools/complete-slice.ts, gsd/bootstrap/dynamic-tools.ts,
     gsd/workflow-mcp.ts all import it. ~6 gsd test files import packages/mcp-server/src/*.
   - .mcp.json `gsd-workflow` server points at it.
RULING: KEEP packages/mcp-server entirely. It is internal CLI plumbing, not an "external
  part". The user's Phase-6 answers ("Remove pkg + gsd graph", "remove MCP server + cloud
  gateway") were given on the plan's wrong premise that mcp-server = only the standalone
  server surface. Revised Phase 6 removes only what is genuinely non-CLI:
   1. KEEP packages/mcp-server (+ build:mcp-server script + chain + validate-pack).
   2. packages/cloud-mcp-gateway: ALREADY empty/untracked (0 git files) — no-op. Tests already
      assert "retired cloud gateway must not be published". Nothing to do.
   3. Remove packages/daemon (Discord/monitoring, ZERO runtime importers) + delete
      src/tests/session-manager-parity.test.ts + drop `build:daemon` from build:core chain
      + delete the build:daemon script. (test:daemon already gone in Phase 5.)
   4. Remove `gsd --mode mcp` (gsd exposing ITSELF as a stdio server): src/cli.ts branch
      ~791-810 + src/mcp-server.ts + src/mcp-mode-tools.ts + the `--mode mcp` help line +
      `mcp` from the --mode union.
   5. Remove `gsd graph` SUBCOMMAND (cli.ts ~262-355 + 'graph' exempt entry + help-text
      section) — honors the user's "lose the knowledge-graph CLI feature" choice. The graph
      READERS stay (used by `gsd read`).
   6. package.json: remove `gsd-mcp-server` bin entry; delete packages/mcp-server/bin/gsd-mcp-server.js
      (standalone "other agents drive gsd" shim). Keep the pkg itself.
   7. Leave .mcp.json alone (gsd-workflow + gsd-browser both still valid — browser-tools kept).
  Cost if wrong: if the user actually wants mcp-server GONE and accepts losing Claude-Code-CLI
  workflow execution, this is rework. FLAGGED to user in next message.

PHASE 5 REVIEW (a524402): Task quality APPROVED. 3 Minor (deferred): (p5-m1)
  app-paths.ts webPidFilePath dead export; (p5-m2) cli.ts:107 includeWebHint param
  misnamed (now gates only the headless hint) -> rename to includeHeadlessHint;
  (p5-m3) refactor-baseline.mjs:42-47 + test:430 still list 2 dead web CONTRACT_SURFACES.
  Reviewer confirmed cli-args.ts extraction faithful, cli.ts fully de-webbed w/ RTK
  bootstrap preserved on all 4 entry paths, lockfile regenerated not hand-edited,
  every deleted test wholly web-dependent. Extra sensible cleanups: validate-pack.js,
  verify-merge.sh, audit-test-confidence.mjs, tsconfig.json exclude.
  Awaiting bm556hdfm (P5 test:unit gate over b5aa8015).
Phase 6 site map written (phase6-sitemap.md, REVISED per the plan-defect ruling).
  Flagged plan defect to user. Proceeding with ruling unless user redirects.

PHASE 5 GATE (bm556hdfm over b5aa8015): 23 baseline native + 1 NEW regression —
  "pi build scripts compile contracts before pi-coding-agent" threw "gsd:web script
  must exist" (src/tests/build-script-contract.test.ts:47 asserted on the deleted gsd:web).
  FIX (controller, commit e6f0f4b area): removed that one assertion; the build:pi ordering
  assertions retained. Verified: test passes (compiled + run). --help was 0.
  Ruling: no dedicated 23-min re-gate for a 1-line test-only fix; Phase 6's full gate confirms.
  PHASE 5 COMPLETE (Tasks 21-25). Deferred minors p5-m1..m3 logged earlier.

PHASE 6 (a23cafaa) DONE -> commit 19924c61. Local 6/6 verify pass (typecheck 0,
  test:compile 0, 19 targeted tests pass, build 0 [build:mcp-server ran, no build:daemon],
  --help 0 no graph/--mode mcp, `gsd graph` clean exit 1).
  Concerns: kept packages/mcp-server/bin/gsd-mcp-server.js (needed by kept-pkg tarball
  validation + workflow-mcp fallback + installer-packaging.test) — removed only root
  package.json bin registration. Cleaned extra daemon refs in version-sync.cjs,
  validate-pack.js, 3 script tests. discord.js kept as root dep (Phase 7 to verify if orphaned).
  RUNNING: p6 gate + phase 6 review.

Phase 7 site map written (phase7-sitemap.md): 2 commits (A identity: package.json name->
  unscoped gsd-pi + repo/homepage/bugs->eagle27272 + drop publishConfig + release scripts;
  README rewrite; CHANGELOG stub; delete root CONTEXT.md. B final sweep: fold in all deferred
  minors p1..p6, tsconfig/gitattributes cleanup, full dangling grep, lockfile dep prune
  [discord.js/@discordjs/rest/telegraf/@modelcontextprotocol/sdk if orphaned], delete
  strip-to-cli-baseline.md, full verification incl. manual TUI acceptance).
  Awaiting b1rwb06t0 (P6 gate) + phase 6 review.

PHASE 6 REVIEW (a140dd6b): Task quality APPROVED. No Critical/Important.
  Verified: packages/mcp-server/ ZERO changes; daemon fully deleted; mcp-mode + graph
  subcommand cleanly removed; every kept @opengsd/mcp-server importer intact; --mode
  union now text|json|rpc; §7 grep clean. parse-cli-args.test.ts positively asserts removal.
  2 Minor (-> Phase 7 B1/B4): (p6-m1) packages/mcp-server/src/workflow-tools.ts:1236 stale
  comment referencing deleted src/mcp-server.ts (carve-out pkg, comment only); (p6-m2)
  discord.js root dep now orphaned (was already root-level at base) -> final dep sweep.
  Awaiting b1rwb06t0 (P6 test:unit gate over 19924c61).

PHASE 6 GATE (b1rwb06t0 over 19924c61): GREEN. --help 0. test:unit 14544 pass / 23 fail /
  28 skip. 23 = baseline native, ZERO regressions. -88 passing = daemon parity test (1240
  lines) + mcp-mode + graph-subcommand test deletions.
  PHASE 6 COMPLETE at HEAD 19924c61 (Tasks 1-29 done).

=== PHASE 7 — identity + final sweep (plan Tasks 30-32) ===
PHASE 7 dispatch: BASE 19924c61. Site map phase7-sitemap.md. 2 commits (A identity, B sweep).

PHASE 7 (a7f79ee8) DONE -> commits 88894b69 (identity) + 200f16b3 (final sweep).
  Local: typecheck 0, test:compile 0, refactor-baseline.test 20/0, build 0,
  --version=1.18.0, --help 0. package.json verified: name=gsd-pi, eagle27272 URLs,
  no publishConfig. dep count 41->40 (discord.js + 6 transitives pruned).
  Bonus: removing dead 'web' from test-audit-lib SOURCE_ROOTS fixed a pre-existing
  audit-test-matrix failure (2->0).
  Concerns -> deferred to final review: (p7-c1) 3 orphaned release script FILES
  (generate-changelog/bump-version/update-changelog .mjs) left on disk (no entry/caller);
  (p7-c2) scripts/release-discord-summary.cjs + test orphaned, left; (p7-c3)
  getRemoteProviders() + "remote" ProviderCategory left per escape hatch.
  RUNNING: p7 gate (bj7wtaaum) + phase 7 review (a3ab78ca).
PHASES 1-7 all implemented. Tasks 1-32 done. HEAD 200f16b3.

PHASE 7 REVIEW (a3ab78ca): Task quality APPROVED. No Critical/Important.
  Verified: identity edits match ratified decisions (name=gsd-pi, eagle27272 URLs,
  no publishConfig); README fully rewritten (no badges/Install/Migrate/Uninstall/
  StarHistory; Repository Layout clean); CHANGELOG stub exact; CONTEXT.md deleted;
  ALL deferred minors p1..p6 worked through; .secretscanignore x8 + tsconfigs +
  test-audit-lib SOURCE_ROOTS swept; discord.js prune complete end-to-end; carve-outs
  intact (packages/mcp-server = 1 comment reword only).
  Minor (-> final review): (p7r-m1) scripts/ci-classify-changes.sh still has dead
  web/docker branches (is_web_file, WEB block, web-mode-windows-hide ref); (p7r-m2)
  orphaned script FILES: generate-changelog/bump-version/update-changelog.mjs +
  release-discord-summary.cjs + test (no callers); (p7r-m3) ~40 residual "@opengsd/gsd-pi"
  string refs in src/ incl. user-facing upgrade hints (cli.ts:92, loader.ts:242,
  resource-loader.ts:94 fallback, GSD_PI_PACKAGE const) — per-spec (src/resources carve-out)
  but a coherence-pass candidate.
  Nits: lockfile also dropped zod@3.25.76 (last consumer was discord.js); discord-invite-links.test.ts
  dropped "README.md" from a list (correct consequence of README rewrite).
  Awaiting bj7wtaaum (P7 test:unit gate over 200f16b3).

PHASE 7 GATE (bj7wtaaum over 200f16b3): 23 baseline + 1 regression —
  update-cmd-diagnostics.test.ts:132 asserted packageName "@opengsd/gsd-pi" but the
  rename made runUpdate stamp "gsd-pi" (the test's own fixture already used "gsd-pi").
  FIX (controller, commit ab73bf5c): aligned the assertion. Verified: test passes.
  Ruling: skip dedicated re-gate for a 1-line test-assertion fix; final whole-branch
  review runs its own full test:unit.
  NOTE: update-check.test.ts:78 still green asserting "@opengsd/gsd-pi" => some
  update-check paths use a hardcoded name while runUpdate reads package.json.
  Package-name coherence (hardcoded @opengsd/gsd-pi consts + user-facing upgrade
  hints cli.ts:92 / loader.ts:242) -> whole-branch review decides.

=== ALL 7 PHASES IMPLEMENTED. Tasks 1-32 done. HEAD ab73bf5c. ===
Dispatching whole-branch FINAL REVIEW (opus).

=== FINAL VERIFICATION (over ab73bf5c) ===
build 0 · --version 1.18.0/0 · smoke 2/0/0 pass · test:unit 14541 pass / 25 fail / 28 skip.
  23 = baseline native. 2 NOT-in-baseline failures: planning-invocation-mcp-identity.test
  ("MCP canonical and alias planning calls replay one explicit private request key") +
  legacy-import-live-restore-fault.test ("every durable live restore boundary converges
  after real SIGKILL"). NEITHER failed in P6 gate (19924c61) or P7 gate (200f16b3); only
  delta since P7 is ab73bf5c = 1-line unrelated test-assertion change. => suspected flaky/
  env-sensitive (SIGKILL convergence + MCP replay ordering are classic non-determinism;
  legacy-import-live-restore-fault is native-fault-injection territory like the 23 baseline).
  Isolated re-run dispatched (bggp7f2na).

=== WHOLE-BRANCH FINAL REVIEW (acf8c64a, opus): READY WITH FOLLOW-UPS. No Critical. ===
  Verified clean: zero dangling imports of any deleted module; no package.json script
  targets a missing file; all 4 carve-out hand-offs resolved; subagent/index.ts exec paths
  all reach runSingleAgent & return; cli-args extraction complete (2 importers, no web
  fields, mode union text|json|rpc); preferences schema symmetric, git.remote untouched,
  unknown keys warn not error.
  3 IMPORTANT:
   I1 - fork still auto-checks + `gsd update` installs upstream @opengsd/gsd-pi
        (update-check.ts:12,17,20; update-cmd.ts:22; commands-handlers.ts:44; cli.ts:562
        calls checkForUpdates() every startup). For a hard fork this nags + can replace
        the fork with upstream. => FIX (disable startup check + personal-fork update msg).
   I2 - scripts/validate-pack.js:326 still requires integrations/hermes/plugin.yaml
        (deleted Phase 1) => verify-merge.sh:86 / verify:merge / verify:full always fail.
        One-line fix.
   I3 - new ci.yml runs test:unit without build:native:test => the 23 baseline native
        failures fail every CI run. Needs Rust-in-CI decision => FOLLOW-UP (user's infra call).
  Minors: 8 (mostly won't-do). Real one = p4-m4 (auto-loop stash-restore-suppression path
  lost its dedicated test guard). Also: test:unit:compiled + test:coverage:unit still glob
  deleted remote-questions/tests/; packages/mcp-server/src/remote-questions.ts (981 lines,
  wired into server.ts:25) is the surviving remote path (MCP-side only; TUI already local) ->
  follow-up; prompts/settings.md:13 stale /gsd setup remote; dead getProjectSessionsDir
  re-export in cli-args.ts:141; pnpm-workspace.yaml empty extensions/*.
  Package-name: FIX NOW narrowly (update-check.ts, update-cmd.ts:22, commands-handlers.ts:44
  — overlaps I1). Acceptable as-is: DB/resource version messages, test fixtures, @opengsd
  scope on native engine pkgs.

ISOLATED RE-RUN (bggp7f2na): BOTH suspected failures PASS in isolation —
  "every durable live restore boundary converges after real SIGKILL" ✔ 52922ms;
  "MCP canonical and alias planning calls replay one explicit private request key" ✔ 2040ms.
  => FLAKY under loaded full-suite (52s process-SIGKILL test times out under parallelism),
  NOT regressions. Verification CLEAN: no branch-caused test failures.

=== FINAL FIX WAVE (per SDD: one wave for the whole-branch review findings) ===
Ruling on I1: for a hard personal fork the right behavior is (a) disable the startup
  upstream auto update-check, (b) `gsd update`/`upgrade` (bare, and `/gsd update`) print
  "personal fork — update via git (pnpm install && pnpm run build:core)" and exit 0,
  (c) KEEP `gsd update browser` (updates @opengsd/gsd-browser, kept) and `gsd update --models`
  (model-catalog refresh) working. Rename the @opengsd/gsd-pi constants in update-check.ts /
  update-cmd.ts:22 / commands-handlers.ts:44 and fix fallout tests.
Fix wave scope: I1(+pkg-name), I2 (validate-pack hermes line), + minors:
  test:unit:compiled & test:coverage:unit drop deleted remote-questions/tests glob;
  pnpm-workspace.yaml drop empty extensions/*; prompts/settings.md:13 drop /gsd setup remote;
  cli-args.ts:141 drop dead getProjectSessionsDir re-export; p4-m4 best-effort re-add of a
  trimmed auto-loop stash-restore-suppression test.
LEAVE as documented follow-ups: I3 (CI native build - Rust-in-CI infra decision);
  packages/mcp-server/src/remote-questions.ts (MCP-side remote path, 981 lines wired into
  server.ts - mini-phase, benign); cosmetic comment reflows; ci-classify-changes.sh dead
  branches; refactor-baseline.mjs:278.

FINAL FIX WAVE (afa5d93c) DONE -> commit fbef6a51. All verifies pass (typecheck 0,
  test:compile 0, 60 targeted tests pass, build 0, --help 0). `gsd update` bare -> fork
  git-pull message no fetch; `gsd update browser` + `--models` still work. FIX 4 DONE
  (re-added trimmed postflight stash-restore test, auto-loop.test 136/0). Deleted 2
  update-cmd-diagnostics tests that only exercised the removed npm-install path.
  Residual @opengsd/gsd-pi in src/ = 43 lines: 2 dead default-param registry URLs +
  2 DB/resource version-contract hint strings + ~39 test fixtures (all justified;
  @opengsd scope still correct for native engine pkgs).
  RUNNING: fw gate + scoped re-review of ab73bf5c..fbef6a51.

FINAL FIX WAVE RE-REVIEW (aa5bb41e): APPROVED. All 4 findings ADDRESSED w/ evidence.
  No new Critical/Important. Minor cosmetic: commands-handlers.ts:702-766 dead branches
  after the browser-only guard; commands-maintenance.ts + db/engine.ts stale
  "npm i -g @opengsd/gsd-pi" hint strings. Non-blocking.
FINAL FIX GATE (b8gtd3woc over fbef6a51): 23 baseline + 1 — update-command.test.ts:91
  "/gsd upgrade routes through the update handler" asserted "Already up to date" but the
  fix made bare /gsd upgrade print the fork message. FIX (controller, commit 0ba...):
  assertion -> fork message. Verified update-command.test 9/9. Definitive final gate
  (g8) launched.

DEFINITIVE FINAL GATE (bx7q0jb05 over d198e756): 14540 pass / 25 fail / 28 skip.
  23 = baseline natives. 2 new: write-gate "allows CONTEXT.md write after depth
  verification" (+queue mode) — BOTH PASS IN ISOLATION (write-gate.test.js 7/7).
  0 hits in p3/p4/p5/p6/p7/fw/final-unit gates. write-gate.ts is src/resources carve-out,
  never touched by the branch. => suite flakiness (shared write-gate persist-state under
  parallel load), NOT a regression. Same class as SIGKILL/MCP-replay flakes.
  FINAL VERDICT: build 0, typecheck 0, smoke 0, --help/--version 0. test:unit = 23
  consistent baseline natives + rotating 0-2 flakes (all pass isolated). ZERO
  branch-caused regressions. BRANCH COMPLETE at d198e756.
  30 commits on main..HEAD; 728 files, +2216 / -132663; deps 41->40.
