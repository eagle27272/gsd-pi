# Remove Obsolete Migration and Legacy-Path Machinery — Design

**Date:** 2026-09-11
**Status:** Approved for planning
**Branch:** `claude/wonderful-swirles-095e62`

## Context

This repository is a personal hard fork of `open-gsd/gsd-pi`, detached at
upstream v1.18.0. It has exactly one consumer: its owner. Every project the
owner runs GSD against has already been migrated off the old on-disk layouts —
there is no remaining repo that needs a migration to be performed for it.

That premise was verified, not assumed:

- All 63 project state stores under `~/.gsd/projects/` are on the flat-phase
  layout. The single `milestones/` directory that exists (`5294c6d80abf`) is
  empty, so `isLegacyMilestonesLayout` already returns false for it, and a
  sibling `phases/` directory is present.
- All 63 stores are external, so the in-repo `.gsd/` → `~/.gsd/projects/<hash>/`
  relocation has nothing left to relocate.

The migration machinery that served those transitions is therefore dead weight:
roughly 100k lines of TypeScript plus a 2.5MB test-fixture corpus, threaded
through live startup, database, and path-resolution code. This design removes
it.

## Goals

- Delete the migration and legacy-path code paths that can no longer fire.
- Leave behind a small, explicit guard so that a legacy-layout project fails
  loudly instead of being silently misread or partially overwritten.
- Keep every path that is still load-bearing, including several that are
  *named* "legacy" but are not.
- Land in independently-revertable waves, since two of the four touch
  `gsd-db.ts` and every path resolver.

## Non-Goals

- Migrating anything. Nothing in this work converts data; it only removes the
  ability to convert.
- Renaming the misleadingly-named survivors (`migration-auto-check.ts`, the
  `legacy.*` naming inside `component-loader.ts`). Worth doing, but it is
  churn that would obscure the deletion diff. Follow-up.
- Touching `packages/pi-coding-agent/**`, which is vendored from upstream.

## What is being removed

### Wave 1 — legacy telemetry counters and MCP aliases (~0.6k LOC)

`legacy-telemetry.ts` maintained five runtime counters whose purpose was to
prove that a compat path had gone unused before it was deleted. The counters
themselves are being removed along with the gate tooling built around them:

- `src/resources/extensions/gsd/legacy-telemetry.ts`
- `scripts/legacy-cleanup-gate.mjs`, `scripts/legacy-cleanup-evidence.mjs`,
  `scripts/legacy-state-path-proof.mjs`
- the `legacy:cleanup:gate`, `legacy:cleanup:evidence`, and
  `legacy:cleanup:proof` entries in `package.json`
- `src/tests/legacy-cleanup-gate.test.ts`,
  `src/tests/legacy-cleanup-evidence.test.ts`,
  `src/resources/extensions/gsd/tests/legacy-telemetry.test.ts`,
  `src/resources/extensions/gsd/tests/legacy-component-format-telemetry.test.ts`
- the seven `incrementLegacyTelemetry` call sites in `bootstrap/db-tools.ts`,
  `commands-workflow-templates.ts`, `component-loader.ts`, `model-router.ts`,
  and `uok/kernel.ts`

Also removed: the deprecated MCP tool aliases. `registerAlias` in
`bootstrap/db-tools.ts:57` wraps a canonical tool under a second name whose
description tells the model to prefer the canonical one. Callers use the
canonical `gsd_*` names.

**Critically, the paths the other four counters guarded are NOT removed.** See
"What is deliberately kept".

### Wave 2 — the `gsd migrate` command (~16k LOC incl. tests)

The v1 `.planning/` → DB-backed `.gsd/` converter.

- `src/resources/extensions/gsd/migrate/` (16 files: `audit.ts`,
  `command.ts`, `execution.ts`, `layout-detect.ts`, `parser.ts`, `parsers.ts`,
  `plan.ts`, `planning-writer.ts`, `presentation.ts`, `preview.ts`,
  `publication-store.ts`, `safety.ts`, `transformer.ts`, `types.ts`,
  `validator.ts`, `writer.ts`)
- the `migrate` entry in `commands/catalog.ts:75` and its mention in the
  command string at `commands/catalog.ts:22`
- `src/resources/extensions/gsd/tests/migrate-*.ts`

### Wave 3 — the legacy-import kernel (~83k LOC incl. tests, + 2.5MB fixtures)

The subsystem that imported a file-layout GSD project into the database, with
preview, backup, forward-repair, and live-restore stages.

- the 40 `src/resources/extensions/gsd/legacy-import-*.ts` modules
- `src/resources/extensions/gsd/db/writers/legacy-import-application.ts`
- `src/resources/extensions/gsd/db/writers/authority-recovery.ts` — all four
  of its exports (`insertAuthorityCutoverReceipt`, `insertImportRestoreReceipt`,
  `applyImportForwardRepairPlan`, `insertImportForwardRepairReceipt`) are
  import receipts, and every consumer is either a legacy-import module or a
  command surface for the import feature
- `src/resources/extensions/gsd/project-authority-cutover-domain-operation.ts`
- `src/resources/extensions/gsd/tests/__fixtures__/legacy-import-corpus/`
- roughly 35 `tests/legacy-import-*.ts` files and their worker/helper fixtures

Unwiring, in the same commit:

- the two barrel re-exports at `gsd-db.ts:76-77`
- ten import blocks in `db-workspace.ts`
- three type-only imports in `db/domain-operation.ts`
- the import-recovery command surfaces in `commands-maintenance.ts`

### Wave 4 — pre-flat-phase pathing, external-state relocation, and the guard

**Pre-flat-phase pathing** (~1.4k LOC plus ~35 sites in `paths.ts`). Strip the
legacy branches from `paths.ts`: `milestones/<MID>/` layout detection
(`legacyMilestonesHasSubdirs`, `isLegacyMilestonesLayout`,
`dirIsContentBearingLegacyMilestone`, `dirIsMetaOnlyLegacyMilestone`,
`legacyMilestonesDir`, `LEGACY_GSD_ROOT_FILES`), the
`T##-DESCRIPTOR-SUFFIX.md` filename fallback, and the bare `roadmap.md`
fallback. Delete `flat-phase-migration.ts` and its four call sites in
`bootstrap/register-hooks.ts` (lines 1190, 1195, 1216),
`state-reconciliation/index.ts:107`, and `auto-dispatch.ts:60`.

**External-state relocation** (~290 LOC). `migrate-external.ts` moves an
in-repo `.gsd/` to `~/.gsd/projects/<hash>/` and leaves a symlink behind. It
runs on every auto-start. Remove `migrateToExternalState`,
`recoverFailedMigration`, and `isCurrentGsdStateIntactForMigratingCleanup`,
along with their call sites in `auto-start.ts:1220`, `auto.ts:204`, and
`doctor-runtime-checks.ts:16`.

**Keep the symlink step.** `auto-start.ts:1228` ("Ensure symlink exists —
handles fresh projects and post-migration") is a distinct concern from the
relocation and is how a brand-new project gets wired to its external store. It
stays.

**The guard** (~50 LOC, new). `src/resources/extensions/gsd/legacy-layout-guard.ts`,
called from auto-start and from doctor. It fails startup with a message naming
v1.18.0 as the last version able to migrate, when it finds any of:

1. a content-bearing `milestones/<MID>/` directory (the pre-flat-phase layout)
2. a v1 `.planning/` directory
3. an in-repo `.gsd/` that is a real directory rather than a symlink

The guard is the reason the wave-4 deletions are safe to make: without it, a
legacy-layout project would present as an empty hierarchy, and the recovery
machinery — which writes — could act on that misreading.

## What is deliberately kept

Each of these matched a `legacy`/`migrat` search and is *not* obsolete.

| Kept | Why |
|---|---|
| `db-migration-steps.ts` and every `db-*-schema.ts` | Forward SQLite schema DDL, v29→v48. Schema history is immutable: deleting a past step breaks any database that has to replay it. The import-kernel tables (`...ImportKernelCloseoutFoundationSchemaV35`, `createAuthorityRecoverySchemaV45`) become orphaned-but-present, which is correct. The active store is at v48 with `gsd.db.backup-v29` and `-v30` on disk. |
| `migration-auto-check.ts` | Misleading name. It compares the markdown projection hierarchy against the database and returns `"recovery-required"` on drift (`:279`). A live consistency check consumed by `auto-start.ts` and `doctor-runtime-checks.ts`. |
| `skill-md` / `agent-md` loaders in `component-loader.ts` (`:265`, `:341`) | Zero `component.yaml` files ship; 37 `SKILL.md` files and 13 agent `.md` files do. The "legacy" format is the only format in use. |
| `markdown-phase` workflow engine (`commands-workflow-templates.ts:504`) | 12 of the 24 templates in `workflow-templates/registry.json` are `markdown-phase`, against 1 `auto-milestone`. |
| Provider-default fallback (`model-router.ts:1061`) | Fires when the model registry is empty and no session model was supplied — a real runtime state, not a migration artifact. |
| UOK parity fallback (`uok/kernel.ts:188`) | Preference-dependent; reachability cannot be ruled out statically. Needs a runtime observation before anyone deletes it. |
| `src/pi-migration.ts`, `src/provider-migrations.ts` | Home-directory credential migrations (`~/.pi/agent/auth.json` → GSD auth; `anthropic` → `claude-code`; `google-gemini-cli` → `google-antigravity`). These concern the machine, not the repos, so the premise behind this work does not cover them. |
| `packages/pi-coding-agent/**` migrations | Vendored from upstream. |

## Verification

The baseline was established before any deletion, in this worktree.

### Worktree setup this required

A nested worktree starts out unable to run either gate. Both were fixable:

- **Typecheck.** `pnpm run typecheck:extensions` is **green** after building
  the workspace packages in order: `build:contracts`, `build:pi`,
  `build:rpc-client`, `build:mcp-server`. `packages/rpc-client/dist` was
  missing, which had made this gate look permanently broken here.
- **Native addon.** The Rust addon had never been compiled in this worktree —
  no `.node` binary existed — so every test touching the native file-identity
  engine failed on `handle.setMutationBoundaryFaultForTest is not a function`
  or `native projection root identity locking failed`.

  Two separate things were missing. `build:native-pkg` only compiles the
  TypeScript wrapper; it does not build the addon at all. And a plain
  `build:native:dev` still leaves the tests red, because
  `set_mutation_boundary_fault_for_test` is gated behind
  `#[cfg(feature = "test-fault-injection")]`
  (`native/crates/engine/src/projection_root_identity_lock.rs:1583`), an
  opt-in cargo feature. The command that actually produces a test-capable
  addon is:

  ```
  node native/scripts/build.js --dev --test-fault-injection
  ```

  Confirmed by checking that `setMutationBoundaryFaultForTest` appears on
  `ProjectionRootIdentityLock.prototype` in the built `.node` file. Anyone
  setting up a fresh worktree for this repo needs this step, and it is not
  wired into `test:unit`.
- **Root `dist/`.** `bootstrap-links.test.ts` imports `dist/bootstrap.js`, so
  it fails with `ERR_MODULE_NOT_FOUND` until the root build has run. Use
  `pnpm run build:core`, **not** a bare `npx tsc`: `app-smoke.test.ts` prefers
  `dist/resources/extensions` over `src/` whenever `dist/resources` exists, so
  a half-built `dist` is worse than no `dist` at all — bare `tsc` made that
  test fail with `expected >=10 extensions, found 7` when it had been passing.
  `build:core` adds `copy-resources`, `copy-themes`, and `copy-export-html`,
  after which `dist` and `src` both discover 18 extensions.
- `pnpm run test:compile` — green, 6070 files.

### The unit baseline is green

`pnpm run test:unit` — **14689 passed, 0 failed, 29 skipped.**

Getting there took some untangling, and the intermediate readings are recorded
because they were actively misleading. Three runs of an unchanged tree gave 24,
26, and 25 failures, which looked like test flakiness. It was not. Every one of
those failures was a missing build artifact, and the varying count came from
process-isolated tests racing over artifacts that were absent rather than from
nondeterministic logic:

- 23 native-engine tests (`tree publication …`, `tree deletion …`,
  `tree retirement …`, `native exact …`) — the addon was never compiled, and
  then was compiled without `--test-fault-injection`
- 1 `bootstrap-links.test.js` — no root `dist/`
- the `write-gate:` pair and `missing host command … (#1943)`, which surfaced
  in some runs and not others, all cleared once the artifacts were in place

The lesson for anyone repeating this: do not accept a red baseline in a fresh
worktree as "pre-existing failures". Chase each one to an artifact first.

### The contract

Each wave must satisfy, before its commit:

1. `pnpm run typecheck:extensions` exits 0.
2. `pnpm run test:unit` reports zero failures.
3. The passing count drops only by the number of tests in files that wave
   deleted. An unexplained drop is a regression signal, not a win.

Because the baseline is green, any failure appearing during a wave is caused by
that wave. This is the main reason the setup work above was worth doing rather
than proceeding against a 24-failure baseline.

## Risks

**Wave 3 and wave 4 are the dangerous ones.** Wave 3 touches `gsd-db.ts` and
`db-workspace.ts`; wave 4 touches every path resolver. The mitigation is the
wave structure itself: four commits in dependency order, each independently
revertable, so a bisect that lands in this range names a cluster rather than a
100k-line blob.

**The guard is load-bearing.** If it is wrong, wave 4 converts "GSD refuses to
start on a legacy project" into "GSD silently misreads one". It gets direct
tests for all three detection cases.

**Orphaned schema tables are intentional.** Someone reading the database later
will find import-kernel tables with no writer. That is the correct outcome and
is recorded here so it is not mistaken for an incomplete deletion.
