# Test confidence stack

This document maps **what protects what** across local scripts and CI. Use it when you need merge confidence, not just a green `verify:pr`.

**CI is one job.** `build-and-test` runs `lint:dead-code`, `build:core`,
`typecheck:extensions`, a native test-addon build, and `test:unit` — and only
on merge-queue branches, not on your PR. Every other row below is enforced
locally or not at all. See [CI/CD Pipeline Guide](./ci-cd-pipeline.md).

## Quick reference

| When | Run locally | CI equivalent | Blocks merge? |
|------|-------------|---------------|---------------|
| Every push | `npm run verify:fast` | none | No — local only |
| Fast iteration while editing | `npm run verify:pr` | Closest analogue to `build-and-test` | No — not sufficient alone |
| Decide whether the heavy local gate is needed | `npm run verify:merge:needed -- --base upstream/main` | none | No — advisory |
| **Before requesting PR review on heavy-code changes** | **`npm run verify:merge`** | none | No — but it is the real safety net |
| Merge queue | — | `build-and-test` | **Yes — the only required check** |
| Full evaluation baseline | `npm run test:evaluation` | none | No |
| Repo-wide coverage report | `npm run test:coverage:full` | none | No |
| Coverage thresholds | `npm run test:coverage` | none | No |
| Docker paths changed | `npm run test:e2e:docker` | none | No |
| Portability paths changed | `npm run test:packages` on Windows | none | No |
| Windows smoke (experimental) | `npm run test:e2e:windows-smoke` | none | No |

The `none` rows are not aspirational — the workflows that once ran them were
deleted in `854209ad`. Path gating, the Windows matrix, the coverage workflow,
and the Docker e2e job survive only as local scripts.

**Node 26+:** `c8` depends on `yargs` v17, which breaks under Node 26’s module resolution. The repo pins `yargs@^18` via `package.json` `overrides` (CI uses Node 24).

Run the inventory anytime:

```bash
npm run audit:test-confidence
npm run audit:test-confidence -- --strict   # fail if tier map drifts from package.json
npm run audit:test-gaps                     # unwired tests, zero-test extensions, thin packages
npm run audit:test-gaps -- --strict-unwired # fail if any test file is unwired/unknown
npm run audit:test-matrix                   # per-source-file status matrix
npm run audit:test-matrix -- --strict       # fail unless the audit matrix is fully covered
npm run audit:test-matrix -- --write-report # regenerate docs/dev/test-evaluation-report.md
```

`audit:test-matrix --strict` is the repo audit definition for source coverage:
zero untested source files, zero critical/high untested files, zero source
files mapped only to unwired tests, zero unwired test files, and zero
unreachable test files. A source file can count as `indirect` when a reachable
suite-level test covers its package, root area, or extension even without a
same-stem test file.

## Test runners by code area

| Code area | Test runner | Invoked by | Notes |
|-----------|-------------|------------|-------|
| `src/` + GSD extension | `node --test` on compiled `dist-test/` | `test:unit` | Primary app unit tests; compile via `test:compile` |
| Extension integration suites | `node --test` + `resolve-ts.mjs` | `test:integration` | ollama, async-jobs, browser-tools, search-the-web, bg-shell, slash-commands |
| `packages/*` | `node --test` (compiled to dist-test) | `test:packages` | Every linkable package must have ≥1 test (`verify:workspace-coverage`) |
| `@gsd/pi-ai` vitest | `vitest --run` | `pnpm --filter @gsd/pi-ai test` | Wired into `verify:merge`; not covered by `test:packages` or by CI |
| Extensions with ≥5 source files | `tests/*.test.*` required | `verify:extension-coverage` | Enforced in `verify:merge` |
| `scripts/__tests__` | `node --test` | `verify:fast` | CI contract/policy regressions, including the workflow/doc reconciliation guards |
| `tests/e2e/` | `node --test` against built binary | `test:e2e` | Requires `GSD_SMOKE_BINARY=dist/loader.js` |
| Coverage (merged) | c8 across unit/integration/packages | `test:coverage:full` | Writes `coverage/lcov.info` + `coverage/file-index.json` |
| Coverage thresholds | c8 on GSD slice | `test:coverage` | Manual only — no coverage workflow exists |

## Enforcement philosophy

### Block merge (merge queue)

One job, `build-and-test`, gated on `startsWith(github.head_ref, 'mergify/merge-queue/')`. It does not run on ordinary PRs — only once the PR is queued:

1. `lint:dead-code` — knip baseline ratchet, first because it needs no build
2. `build:core` and `typecheck:extensions`
3. `build:native:test` — the unit suite drives fault injection through the native engine, and the pinned `@opengsd/engine-*` binary lags the Rust source
4. `test:unit`

`.mergify.yml` requires exactly this check and nothing else.

### The local gate is broader than CI

**`npm run verify:merge`** runs the full Linux stack sequentially — `validate-pack`, `verify:workspace-coverage`, `verify:extension-coverage`, compiled unit and package tests, `@gsd/pi-ai` vitest, integration, and e2e. It also builds `pnpm run build:native:test` and stages `dist-test/native/addon/` with `GSD_NATIVE_PREFER_LOCAL=1`; requires a local Rust toolchain.

Nothing in CI re-runs any of that. Use `npm run verify:merge:needed -- --base upstream/main` first so you only pay for it when the diff warrants it — the classification is a local heuristic (`scripts/ci-classify-changes.sh`), not a CI behaviour.

Native package tests are skipped in the main package-test step unless native/portability paths changed; otherwise a full Rust native rebuild dominates the run. Compiled package tests use Node's `--test-force-exit` so leaked handles in one package do not idle after all assertions pass.

`verify:fast` also runs:

- `scripts/__tests__/`
- `audit:test-gaps --strict-unwired`
- `audit:test-matrix --strict`
- `lint:dead-code` — knip against `.config/knip-baseline.json`; see [dead-code-lint.md](dead-code-lint.md)

### Coverage (local only)

- `test:coverage` — c8 thresholds (40/40/20/20) on the GSD slice
- `test:coverage:full` — merged coverage artifacts

The coverage workflow that once ran these weekly was deleted in `854209ad`;
both commands are now manual. Build the native test addon from the checked-out
Rust source and set `GSD_NATIVE_PREFER_LOCAL=1` first. For compiled coverage
suites, copy that addon into `dist-test/native/addon/` before merging the
coverage artifacts.

### Not enforced anywhere

- **Windows e2e smoke** — `test:e2e:windows-smoke` exists; no job runs it
- **Docker e2e** — `test:e2e:docker` exists; no job runs it
- **Path gating** — `scripts/ci-classify-changes.sh` is consumed only by
  `verify:merge` and `verify:merge:needed`, both local
- **Doc-only PRs** — nothing to skip; the merge-queue job builds and runs the
  unit suite regardless of what changed

## Why `verify:pr` still exists

`verify:pr` is a **fast inner loop** (~5–15 min): `build:core` → `typecheck:extensions` → `test:unit`.

It is close to what the merge queue runs, which is exactly why it is not enough: CI is thin, so a green `verify:pr` mostly predicts a green CI, not a correct change. Start with `verify:merge:needed`, then pay for `verify:merge` when the classification says it matters.

`verify:full` is an alias for `verify:merge` (kept for backward compatibility).

## Known gaps (honest)

These are tracked limitations, not bugs to hide:

1. **CI covers a fraction of the suite** — integration, package, e2e, coverage, Windows, and Docker tests block nothing. A PR can merge having run only `test:unit`.
2. **The merge gate skips ordinary PRs** — `build-and-test` fires only on merge-queue branches, so a PR shows no signal until it is queued.
3. **Web UI** — many files rely on suite-level indirect coverage; use `audit:test-matrix` to separate named coverage from indirect coverage
4. **Windows smoke** — not run anywhere; flake rate is unmeasured
5. **Single-file extensions** — may rely on root-level suite coverage instead of dedicated extension-local tests

## Related docs

- [Test evaluation report](./test-evaluation-report.md) — regeneratable matrix snapshot
- [CI/CD Pipeline Guide](./ci-cd-pipeline.md) — the workflow, the merge gate, and what CI does not run
- [Development](./development.md) — local development commands
