# Test confidence stack

This document maps **what protects what** across local scripts and CI. Use it when you need merge confidence, not just a green `verify:pr`.

## Quick reference

CI is exactly two jobs, both in `.github/workflows/ci.yml`. Anything below with
**no CI job** is a local-only tier — running it is a judgement call, nothing
enforces it. `audit:test-confidence --strict` checks the CI map *in
`scripts/audit-test-confidence.mjs`* against the real workflow and
`.mergify.yml`; this table is prose and is not machine-checked, so keep it in
step with that map.

| When | Run locally | CI equivalent | Blocks merge? |
|------|-------------|---------------|---------------|
| Every push | `npm run verify:fast` | `fast-gates` (every PR) | Yes |
| Fast iteration while editing | `npm run verify:pr` | Partial `build-and-test` (`build:core` + unit tests) | No — not sufficient alone |
| Decide whether the heavy merge gate is needed | `npm run verify:merge:needed -- --base upstream/main` | — no CI job | No — advisory |
| **Before requesting PR review on heavy-code changes** | **`npm run verify:merge`** | `build-and-test` (merge queue only) | Yes, in the merge queue |
| Full evaluation baseline | `npm run test:evaluation` | — no CI job | No |
| Repo-wide coverage report | `npm run test:coverage:full` | — no CI job | No |
| Coverage thresholds | `npm run test:coverage` | — no CI job | No |
| Portability paths changed | `src/tests/windows-portability.test.ts` runs on Linux via `test:unit` | `build-and-test` (Linux only) | Yes, but never on Windows |
| Windows smoke (experimental) | `npm run test:e2e:windows-smoke` | — no CI job | No |

`fast-gates` runs on every PR: it needs no build and no Rust toolchain, so the
scans and policy checks see the real PR diff. `build-and-test` is gated on
`startsWith(github.head_ref, 'mergify/merge-queue/')` and therefore runs only
once Mergify queues the PR. Both are listed in `.mergify.yml`
`merge_conditions`, which is what actually blocks the merge.

**Node 26+:** `c8` depends on `yargs` v17, which breaks under Node 26’s module resolution. The repo pins `yargs@^18` via `package.json` `overrides` (CI uses Node 24).

Run the inventory anytime:

```bash
npm run audit:test-confidence
npm run audit:test-confidence -- --strict   # fail if the tier map drifts from package.json, ci.yml or .mergify.yml
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
| Extension integration suites | `node --test` + `resolve-ts.mjs` | `test:integration` | ollama, async-jobs, browser-tools, mac-tools, search-the-web, bg-shell, slash-commands |
| `packages/*` | `node --test` (compiled to dist-test) | `test:packages` | Every linkable package must have ≥1 test (`verify:workspace-coverage`) |
| `@gsd/pi-ai` vitest | `vitest --run` | `pnpm --filter @gsd/pi-ai test` | Wired into `verify:merge`; not in CI, not covered by `test:packages` |
| Extensions with ≥5 source files | `tests/*.test.*` required | `verify:extension-coverage` | Enforced in `verify:merge` |
| `scripts/__tests__` | `node --test` | `verify:fast` → CI `fast-gates` | CI contract/policy regressions |
| `tests/e2e/` | `node --test` against built binary | `test:e2e` | Requires `GSD_SMOKE_BINARY=dist/loader.js` |
| Coverage (merged) | c8 across unit/integration/packages | `test:coverage:full` | Writes `coverage/lcov.info` + `coverage/file-index.json` |
| Coverage thresholds | c8 on GSD slice | `test:coverage` | Local spot-check; no CI job |

## Enforcement philosophy

### Block merge (PR)

**`fast-gates`** — every PR to `main`. Installs dependencies only (no build, no
Rust toolchain) and runs `scripts/ci-fast-gates.sh`: secret / base64 /
prompt-injection scans, skill references, PR test-policy checks, the three
audits, `verify:pi-boundary`, `lint:dead-code`, actionlint, and the whole
`scripts/__tests__` suite.

**`build-and-test`** — merge-queue branches only, in one job to avoid repeated
checkout/setup/install overhead: `lint:dead-code` → `build:core` →
`typecheck:extensions` → `build:native:test` → `test:unit`.

`build:native:test` is not an optimisation: `test:unit` drives fault injection
through the native engine, and the pinned `@opengsd/engine-*` binary lags the
Rust source, so without a local addon the loader silently falls back and the
migrate-safety-audit suite fails.

Local parity for `build-and-test` is **`npm run verify:merge`**. It covers far
more — `validate-pack`, `verify:workspace-coverage`,
`verify:extension-coverage`, package tests, `@gsd/pi-ai` vitest,
`test:integration` and e2e smoke, none of which any CI job runs today — but it
is **not a strict superset**: it calls `test:unit:compiled` directly rather
than `test:unit`, so it skips `test:live-workflow:unit`, which CI does run.
It stages `dist-test/native/addon/` with `GSD_NATIVE_PREFER_LOCAL=1` and needs
a local Rust toolchain. Use `npm run verify:merge:needed -- --base upstream/main`
first so you only pay for it when the diff warrants it.

Compiled package tests use Node's `--test-force-exit` so leaked handles in one package do not idle until the CI watchdog fires after all assertions pass.

`verify:fast` also runs:

- `scripts/__tests__/`
- `audit:test-gaps --strict-unwired`
- `audit:test-matrix --strict`
- `lint:dead-code` — knip against `.config/knip-baseline.json`; see [dead-code-lint.md](dead-code-lint.md)

### Coverage (local only)

There is no coverage workflow. Both targets are run by hand:

- `test:coverage` — c8 thresholds (40/40/20/20) on the GSD slice
- `test:coverage:full` — merged coverage artifacts

For compiled coverage suites, build the native test addon from the checked-out
Rust source, set `GSD_NATIVE_PREFER_LOCAL=1`, and copy the addon into
`dist-test/native/addon/` before merging the coverage artifacts.

### Not gated by CI

`854209ad` replaced an older multi-job pipeline with the minimal one described
above, and these never came back:

- **Windows** — no Windows runner exists. `src/tests/windows-portability.test.ts` runs, but only on Linux, so it catches path/separator logic and not real Windows behaviour. `test:e2e:windows-smoke` runs nowhere.
- **Docker e2e** — no CI job and no `test:e2e:docker` script; the older pipeline's Docker step has no local equivalent today.
- **Integration, package, `@gsd/pi-ai` vitest and e2e suites** — exist and pass locally under `verify:merge`, but no CI job runs them.

## Why `verify:pr` still exists

`verify:pr` is a **fast inner loop** (~5–15 min): `build:core` → `typecheck:extensions` → `test:unit` → `gate:lifecycle-shadow-no-cutover`.

It is intentionally lighter than `verify:merge`. Start with `verify:merge:needed`, then pay for `verify:merge` when the path classification says it matters. Because CI runs neither the integration, package, nor e2e suites, a passing `verify:pr` is weaker evidence than it looks — `verify:merge` locally is the only place those run before merge.

`verify:full` is an alias for `verify:merge` (kept for backward compatibility).

## Known gaps (honest)

These are tracked limitations, not bugs to hide:

1. **CI is narrower than the local tiers** — only `fast-gates` and `test:unit` run in CI. Integration, package, `@gsd/pi-ai` vitest and e2e suites exist but no job runs them; `verify:merge` locally is the only gate that does
2. **Windows and Docker** — scripts exist, no CI job runs them on any platform
3. **Web UI** — many files rely on suite-level indirect coverage; use `audit:test-matrix` to separate named coverage from indirect coverage
4. **Single-file extensions** — may rely on root-level suite coverage instead of dedicated extension-local tests

## Related docs

- [Test evaluation report](./test-evaluation-report.md) — regeneratable matrix snapshot
- [CI/CD Pipeline Guide](./ci-cd-pipeline.md) — promotion pipeline and workflow files
- [Development](./development.md) — local development commands
