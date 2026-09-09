# Whole-branch final review — `personal/strip-to-cli`

Scope: cross-phase coherence + merge-readiness over 28 commits (722 files, +2153 / −132524),
HEAD `ab73bf5c`. All 7 per-phase task reviews already Approved; this pass covers only what a
single-phase reviewer could not see.

## Merge readiness: READY WITH FOLLOW-UPS

No Critical findings. The stripped CLI is internally consistent: zero dangling imports of any
deleted module anywhere in `src/`, no `package.json` script pointing at a missing file, every
carve-out hand-off resolved, and `pnpm run build` + `gsd --version` green at HEAD.

Three Important findings, all outside the runtime hot path but all real:

1. the fork still checks and installs **upstream** `@opengsd/gsd-pi` on update,
2. `pnpm run validate-pack` (and therefore `verify:merge` / `verify:full`) exits 1 on a stale
   hermes entry,
3. the new minimal `ci.yml` will be permanently red because it runs `test:unit` without the
   fault-injection native build.

None of the three blocks landing the branch on a personal fork; #1 should be fixed before the
fork is used day-to-day, because it will silently offer to replace itself with upstream.

---

## Cross-phase coherence findings

### Important

**I1 — The fork still checks for, and installs, upstream `@opengsd/gsd-pi`.**
`src/update-check.ts:12` (`GSD_PI_PACKAGE_NAME`), `:17` (`NPM_PACKAGE_NAME`), `:20`
(`DEFAULT_REGISTRY_URL = https://registry.npmjs.org/@opengsd%2fgsd-pi/latest`);
`src/update-cmd.ts:22` (`NPM_PACKAGE`); `src/resources/extensions/gsd/commands-handlers.ts:44`
(`GSD_PI_PACKAGE`).

Why it misbehaves rather than being cosmetic: `src/cli.ts:562` calls `checkForUpdates()` on
every startup with no `packageName` override, and `defaultCurrentVersion()` (update-check.ts:244-247)
short-circuits for this package to `process.env.GSD_VERSION || '0.0.0'` — it never fails to
resolve a "current version". So as soon as upstream publishes anything above 1.18.0, the fork
prints an update banner every launch telling the user to
`npm install -g @opengsd/gsd-pi@latest`, and `gsd update` / `gsd upgrade` / the in-TUI
`/gsd update` will actually run that install — replacing the fork with upstream.

Phase 7 renamed `package.json` and the resource stamp (`pack-install.test.ts:297` now asserts
`packageName: "gsd-pi"`) but left the update/upgrade identity scoped. That split is exactly the
inconsistency the ledger flagged at `update-check.test.ts:78`.

Fix: see **Package-name recommendation** below.

**I2 — `pnpm run validate-pack` is broken by a Phase-1 deletion.**
`scripts/validate-pack.js:326` still lists `'integrations/hermes/plugin.yaml'` in
`requiredFiles`; a missing entry prints `MISSING:` and `process.exit(1)` (lines 335-345).
`integrations/hermes/` was deleted in Phase 1 (T4) and the two hermes rows were dropped from
`package.json` `files` in Phase 7, so the file can never be in the tarball.
`scripts/verify-merge.sh:86` runs `pnpm run validate-pack`, so `pnpm run verify:merge` /
`verify:full` — the repo's own documented pre-merge gate — now always fails.

Nobody caught it because Phase 5 edited this file for web and Phase 6 for daemon; neither
re-checked the hermes row. Fix: delete line 326. (`prepublishOnly` was removed, so nothing else
is affected.)

**I3 — The new `ci.yml` will fail on every push.**
`.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile` → `build:core` →
`typecheck:extensions` → `test:unit`. The 23 known-failing baseline tests are the native
fault-injection suite (`setMutationBoundaryFaultForTest`, "tree deletion|publication|retirement"),
which only pass when the addon is built with `pnpm run build:native:test`
(`native/scripts/build.js --dev --test-fault-injection`). The old CI did that in its build job;
the minimal replacement does not, so `test:unit` will be red on every run.

Two secondary notes on the same file: `pnpm install --frozen-lockfile` has no `--ignore-scripts`,
so `postinstall` → `scripts/install.js` runs in CI (the old workflow set
`GSD_SKIP_RTK_INSTALL=1` / `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`); and `pull_request:` is declared
with no `branches:` filter, which is fine but broader than the push filter.

`engines: node >= 22.18.0` and the pinned `node-version: 22.18.0` / `pnpm 10.12.1` do match —
no problem there.

Fix (pick one): add `pnpm run build:native:test` before `test:unit`; or drop `test:unit` from CI
and keep build + typecheck only; or accept a known-red CI. Decide explicitly rather than
discovering it on the first push.

### Minor

**M1 — `src/resources/extensions/gsd/prompts/settings.md:13` advertises a deleted command.**
The line reads `- **Integrations**: remote, search — /gsd setup remote|search.` Phase 3 deleted
the `remote` `OnboardingStep` from `setup-catalog.ts`, and Phase 4 edited *this exact line* to
drop cmux but left `remote`. It is the only surviving `setup remote` string in `src/`. Because
it is an LLM-facing prompt, the model will emit a command that no longer exists.
Fix: `- **Integrations**: search — /gsd setup search.`

**M2 — Stale test glob for a deleted extension.**
`package.json` `test:unit:compiled` and `test:coverage:unit` both still glob
`dist-test/src/resources/extensions/remote-questions/tests/*.test.js` (deleted in Phase 3). The
same edits correctly dropped the `cursor-cli` and `voice` globs. Verified harmless — the run in
`final-unit.log` proceeds normally with an unmatched pattern — but it is dead and should go.

**M3 — Remote-questions survives inside the kept `packages/mcp-server`, creating an asymmetry.**
`packages/mcp-server/src/remote-questions.ts` (981 lines) is wired into
`packages/mcp-server/src/server.ts:25-26` (`isRemoteConfigured`, `tryRemoteQuestions`) and reads
the `remote_questions` block straight out of `~/.gsd/PREFERENCES.md`
(remote-questions.ts:186-191). After Phase 3 the TUI can no longer route questions to
Discord/Slack/Telegram, but the workflow-MCP path (which the kept Claude Code CLI provider
drives) still can — while `remote_questions` is no longer in `KNOWN_PREFERENCE_KEYS`, so
configuring it now emits `unknown preference key "remote_questions" — ignored`
(`preferences-validation.ts:147-156`). Related live plumbing kept on purpose or by omission:
`src/wizard.ts:28-30` (bot-token env hydration) and
`src/resources/extensions/gsd/key-manager.ts:74-76` (three `category: "remote"` registry rows).
Not a break in either direction. Decide: delete the mcp-server module + its wiring + those two
call sites, or keep it and re-add `remote_questions` to the known-keys set so the warning stops.

**M4 — Dead re-export in the relocated arg parser.**
`src/cli-args.ts:141` does `export { getProjectSessionsDir } from './project-sessions.js'` —
carried over verbatim from `cli-web-branch.ts`. `src/cli.ts:30` imports it directly from
`./project-sessions.js`, and nothing imports it through `cli-args.js`. Drop the line.

**M5 — Dead web/docker branches in CI helper scripts.**
`scripts/ci-classify-changes.sh` still defines `is_web_file` (line 30-32) and `is_docker_file`
(line 53), emits `web-changed` / `docker-changed` outputs nothing consumes any more, and its
portability pattern (line 39) still names the deleted
`src/tests/integration/web-mode-windows-hide.test.ts`. `scripts/refactor-baseline.mjs:278` still
lists `"web"` in `trackedAreas` (the two dead web `CONTRACT_SURFACES` *were* removed).
`scripts/ci-fast-gates.sh` and `ci-fetch-diff-base.sh` are now uncalled by the minimal ci.yml.
All inert; sweep when convenient. (This is ledger item p7r-m1 plus the residue of p5-m3.)

**M6 — `pnpm-workspace.yaml` still lists `'extensions/*'`.** That directory is now empty and
untracked (`git ls-files extensions/` is empty) after the `@gsd-extensions/google-search`
workspace package was removed. pnpm tolerates a non-matching pattern; cosmetic.

**M7 — Comment reflow damage in a kept file.**
`src/resources/extensions/ask-user-questions.ts:70-73` — removing the remote-channel clause left
`// canonicalized payload (id, header,` / `// question, options, ...` broken across lines
mid-phrase. Cosmetic.

**M8 — `src/resource-loader.ts:92,94` fallback package name is still `'@opengsd/gsd-pi'`.**
Only reached when `package.json` cannot be read; the live path returns `pkg.name` = `gsd-pi`,
which `pack-install.test.ts:297` now pins. Fold into the I1 sweep.

---

## What I verified clean (the things this pass existed to check)

**Carve-out hand-offs — all resolved, nothing orphaned.**
- Phase 2/3 left `context7` / `remote_questions` refs in `src/web/onboarding-service.ts` for
  Phase 5 → `src/web/` is gone; repo-wide grep for `src/web/` hits only an old plans doc.
- Phase 5 left `build:daemon` / `build:mcp-server` for Phase 6 → `build:daemon` removed from both
  the `build:core` chain and the script list; `build:mcp-server` correctly retained and observed
  running in `final-build.log`.
- Phase 4 carve-outs honored: `isCmuxTerminal()` kept in `shared/terminal.ts`; `shellEscape`
  relocated there and `subagent/launch.ts:6` imports it from the new home.
- Phase-1 Critical (the un-committed `read-cli-minimal-project/.gsd/STATE.md` fixture) is
  committed and un-ignored.
- Ledger minors m6 (test:e2e:docker + `tests/e2e/docker/`), m7 (`version-sync.cjs`
  `*HermesVersion`), m8 (build-native.yml mentions), p5-m1/m2, p6-m1/m2 are all genuinely gone —
  re-verified on disk, not just claimed.

**`subagent/index.ts` (−271) — sound.** All three execution modes reach a single implementation:
parallel (`index.ts:1324`), single (`:1435`), chain (`:1209`) all call `runSingleAgent` and every
path assigns `finalResults` and returns. Zero occurrences of `cmux`/`Cmux`/`CMUX`/`gridSurfaces`/
`waitForFile` anywhere under `src/resources/extensions/subagent/`. The Phase-4 dead-code fix
(`loadEffectiveGSDPreferences` import, `buildShellEnvAssignments` from the import list,
private `waitForFile`) is applied; `buildShellEnvAssignments` is still exported from `launch.ts`
and exercised by `launch.test.ts`; the `fs` import is still needed by four other uses.

**`cli-args.ts` relocation — complete and consistent.** Only two importers repo-wide
(`src/cli.ts:29`, `src/tests/parse-cli-args.test.ts:6`). `CliFlags` carries no `web` / `webPath` /
`webPort` / `webAllowedOrigins` / `webNoAuth` fields and the mode union is `text|json|rpc`; the
`--mode mcp` branch, the `--web` branch, `runWebCliBranch`, `stopWebMode`, the `web`/`graph`/
`hermes` TTY-exemption entries and the `cliFlags.web` guard are all gone from `cli.ts`. Every
one of the ~45 `cliFlags.*` reads in `cli.ts` (lines 186-794) references a surviving field.
`help-text.ts` matches the new surface (no `--web`/`--host`/`--port`/`--allowed-origins`/
`--no-auth`/`--mode mcp`/`graph`/`hermes`), and `parse-cli-args.test.ts` now positively asserts
`--mode mcp` yields `undefined`. `buildHeadlessCommandArgs` and `migrateLegacyFlatSessions`
moved verbatim.

**Preferences schema — symmetric, no half-removed field.** `cmux` and `remote_questions` are
gone from `KNOWN_PREFERENCE_KEYS`, the `GSDPreferences` interface, both type declarations, the
`preferences.ts` type re-exports, both validation blocks, the merge function, and the wizard —
with the whole `normalizeParsedPreferences` helper (wholly remote-specific) removed together
with both call sites. `git` (including `git.remote`) is untouched and every other key is still
spread in `mergePreferences`. Unknown keys produce a *warning*, not an error
(`preferences-validation.ts:147-156`), so an existing user's `PREFERENCES.md` with a leftover
`cmux:` or `remote_questions:` block still loads.

**No half-registered extension, no broken script chain.** The 17 kept extensions plus the two
single-file extensions are all present; nothing in `src/` imports any removed extension
(`cmux`, `remote-questions`, `ttsr`, `voice`, `context7`, `aws-auth`, `google-search`,
`google-cli`, `cursor-cli`) or any removed module (`web-mode`, `cli-web-branch`,
`mcp-mode-tools`, `src/mcp-server`, `hermes-integration-install`). A scripted check of every
`package.json` script for a missing target file came back empty. The four orphaned release
scripts (`bump-version.mjs`, `generate-changelog.mjs`, `update-changelog.mjs`,
`release-discord-summary.cjs`) are self-contained, have no callers, and — checked — pull no
pruned dependency (`release-discord-summary.cjs` requires only node builtins, so the `discord.js`
prune did not strand it).

---

## Deferred-minor triage

| Tag | Verdict | Why |
|---|---|---|
| p1-m1 `gitignore.ts:347` reworded Context7 template line | won't-do | Authored template guidance; the replacement reads correctly and dropping it would leave a gap. |
| p1-m2 `preferences-models.ts:51-53` comment reflow | won't-do | Re-read post-edit; it flows fine. |
| p1-m3 commit `e176d6eb` subject parenthetical | won't-do | History cosmetics on a personal branch. |
| p1-m4 7 kept files still naming `cursor-agent`/`google-gemini-cli`/`google-antigravity` | follow-up | Deliberate: these are migration/onboarding/error-guidance paths for users with existing configs, and fix-round-1 proved a fuller purge breaks the registry contract tests. Leave unless the strings actually surface. |
| p1-m5 `CLI_AUTH_PATH_CHECK_PROVIDERS` now an empty `Set` | follow-up | Dead branch, zero runtime effect; delete during the next doctor-providers touch. |
| p1-m6 `test:e2e:docker` + `tests/e2e/docker/` | closed | Both removed; verified `tests/e2e/` has no `docker/`. |
| p1-m7 `version-sync.cjs` `*HermesVersion` | closed | No hermes reference remains in the file. |
| p1-m8 `verify-native-platform-packages.mjs` / `npm-release-packages.cjs` naming `build-native.yml` | closed | Both reworded in Phase 7. |
| p3-m1 `setup-catalog.ts:97` `getRemoteProviders()` unused | follow-up | Bundle with the M3 decision — it is the setup-side half of the same question. |
| p3-m2 `doctor-providers.ts` `categoryLabels.remote` | won't-do | Not dead: `key-manager.ts:74-76` still registers three `category: "remote"` providers, so the label is still reachable. |
| p3-m3 `resource-loader.test.ts` retargeted to `subagent` + now-inaccurate comment | follow-up | One-line comment fix; the manifest-discovery branch losing coverage is worth a note, not a rewrite. |
| p3-m4 `ask-user-questions.ts` two ifs instead of an early return | won't-do | Cosmetic. |
| p3-m5 `FLOW_VERSION` not bumped | won't-do | Correct as-is for a pure removal. |
| p4-m4 sanctioned test-block deletions also dropped non-cmux assertions (auto-loop postflight-stash-restore) | **follow-up — highest value of the minors** | This is the only item that costs real coverage on a KEPT feature: the stash-restore suppression path now has no dedicated guard. Re-add a trimmed, cmux-free version of that test. |
| p4-m5 pi-coding-agent fixtures literally named `@gsd/cmux` | won't-do | Self-contained temp fixtures; the name is arbitrary. |
| p4-m6 `handleLostSessionLock` pass-through arrow | won't-do | Cosmetic. |
| p5-m1 `app-paths.ts` `webPidFilePath` dead export | closed | Both web path exports deleted. |
| p5-m2 `cli.ts:107` `includeWebHint` misnamed | closed | Renamed to `includeHeadlessHint`, doc comment updated. |
| p5-m3 `refactor-baseline.mjs` dead web `CONTRACT_SURFACES` | partly closed → follow-up | The two surfaces are gone; `trackedAreas` still lists `"web"` (folded into M5). |
| p6-m1 `workflow-tools.ts:1236` stale `src/mcp-server.ts` comment | closed | Reworded. |
| p6-m2 orphaned `discord.js` root dep | closed | Pruned end-to-end (dep + 6 transitives + `zod@3.25.76`). |
| p7-c1 / p7r-m2 orphaned release script files | won't-do | Self-contained, no callers, no stranded deps — and `bump-version.mjs` is genuinely useful if the fork ever cuts a version. |
| p7-c2 `release-discord-summary.cjs` + test | won't-do | Node-builtins only, test green. |
| p7-c3 `getRemoteProviders()` + `"remote"` ProviderCategory | follow-up | Same decision as p3-m1 / M3. |
| p7r-m1 `ci-classify-changes.sh` dead web/docker branches | follow-up | Folded into M5. |
| p7r-m3 ~40 residual `@opengsd/gsd-pi` strings | **split** | 3 sites **block day-to-day use** (see I1); the rest are cosmetic. See below. |

---

## Package-name recommendation: FIX NOW (narrow), then leave the rest

This is **not** cosmetic, but only three files matter. The rename made the *package identity*
unscoped (`package.json`, the `managed-resources.json` stamp, `npm-package-identity.test.ts`)
while the *update identity* stayed scoped — so the fork now points its self-update machinery at
someone else's package.

**Fix now:**

1. `src/update-check.ts` — `GSD_PI_PACKAGE_NAME` (:12) and `DEFAULT_REGISTRY_URL` (:20).
   `gsd-pi` is unpublished, so the cleanest fix is to make the startup check a no-op for the fork
   (early-return in `checkForUpdates`, or gate `src/cli.ts:562` behind an opt-in env var) rather
   than to repoint the constant at a package that does not exist on the registry. Whichever you
   pick, `src/tests/update-check.test.ts:78` and the `@opengsd/gsd-pi` fixtures in
   `update-cmd-diagnostics.test.ts` / `installer-detect-existing.test.ts` need to follow — expect
   test churn, which is exactly why the ledger's "still green asserting `@opengsd/gsd-pi`" note
   was the right thing to escalate here.
2. `src/update-cmd.ts:22` `NPM_PACKAGE` — `gsd update` / `gsd upgrade` must not install upstream
   over the fork. Either repoint it or make the command refuse with a clear message.
3. `src/resources/extensions/gsd/commands-handlers.ts:44` `GSD_PI_PACKAGE` — same for the in-TUI
   `/gsd update` path.

**Then, cheap and cosmetic (same commit, or never):** the user-facing hint strings at
`src/cli.ts:92` and `src/loader.ts:242,246`, and the unreachable fallback at
`src/resource-loader.ts:92,94`. These only mislead; they do not act.

**Acceptable as-is:** the `@opengsd/gsd-pi` strings inside error messages that describe the
*database/resource version contract* (`db/engine.ts:187`, the `db-open-version-stamp` /
`read-cli-schema-too-new` / `headless-*` tests, `commands-maintenance.ts:1077,1493`) and every
test fixture. They are historical text or test data, and the `@opengsd` scope is still correct
for the native engine packages, which `npm-package-identity.test.ts` now asserts explicitly.

---

## Verified working vs. still pending

**Verified in this review (static, on HEAD `ab73bf5c`):**
- `pnpm run build` exit 0 (`final-build.log`, `BUILD_EXIT=0`) — `build:mcp-server` runs, no
  `build:daemon`.
- `gsd --version` → `1.18.0`, exit 0 (`final-ver.log`).
- Zero dangling imports of any removed module in `src/`; no `package.json` script targets a
  missing file; the `extensions/` workspace is empty and tracked-clean.
- Subagent single/parallel/chain wiring, `cli-args` extraction + every `CliFlags` consumer,
  preferences schema symmetry, and all carve-out hand-offs, as detailed above.

**Still needs the controller's full gate:**
- `pnpm run test:unit` — the run in `final-unit.log` was still in flight when I read it
  (compile step done, `test:unit:compiled` mid-run). Pass condition remains **exactly** the 23
  baseline native failures. Nothing I found predicts a new failure, but the Phase-7 fix
  (`ab73bf5c`, the `update-cmd-diagnostics.test.ts:132` assertion) has never been through a full
  suite, and neither has the Phase-4 dead-code fix `70f28fb4` — both are covered only by this run.
- `tests/smoke/run.ts` — no result yet; this is the only end-to-end check of the interactive TUI
  and the headless/print paths after the `cli-args` relocation, so treat it as the gating signal
  for I-level confidence in `gsd -p` / `gsd quick` / `gsd auto`.
- Manual TUI acceptance (plan Task 32) — not something a static pass can substitute for.

If both come back clean, the branch is mergeable with I1–I3 and M1–M8 tracked as follow-ups; I1
(update identity) and I2 (`validate-pack`) are ~5 lines total and worth doing before the merge
commit rather than after.
