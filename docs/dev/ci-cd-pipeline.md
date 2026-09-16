# CI/CD Pipeline Guide

## Overview

**There is no CD.** No npm publish, no Docker push, no tagging, no GitHub
Release, no changelog, no triage automation. Commit `854209ad` removed all of
it — release, publish, native build, coverage, security audit, model catalog,
issue lifecycle, and the composite actions they shared.

What remains is two files:

| File | Purpose |
|------|---------|
| `.github/dependabot.yml` | Weekly grouped GitHub Actions version bumps |
| `.github/workflows/ci.yml` | Two jobs: `fast-gates` and `build-and-test` |

`ci.yml` triggers on `pull_request` against `main`. There is no `push:`
trigger, no `workflow_dispatch`, and no schedule — nothing runs after a merge.

## The two jobs

### `fast-gates` — every PR

Runs on every pull request, with no `if:` guard. It checks out full history
(`fetch-depth: 0`), because the scans diff against the base ref and a local
`verify:fast` falls back to `git merge-base`, which a shallow clone lacks. It
installs dependencies with `--ignore-scripts`, installs a pinned,
SHA256-verified `actionlint`, then runs `bash scripts/ci-fast-gates.sh` with
`BASE_REF` and `PR_BASE_SHA` from the PR event.

The actionlint install is load-bearing: `ci-fast-gates.sh` runs actionlint only
when it is already on `PATH`, so without that step the workflow static-analysis
gate would silently self-skip in the one place it is meant to block.

The script covers secret and base64 scans, the docs prompt-injection scan,
skill references, `require-tests`, source-grep test rejection, the three
`audit:*` strict gates, `scripts/__tests__/`, the pi boundary check, the
knip dead-code baseline, and actionlint.

### `build-and-test` — merge queue only

Guarded by:

```yaml
if: startsWith(github.head_ref, 'mergify/merge-queue/')
```

**It does not run on your PR.** It runs only on the temporary branches Mergify
creates when a PR enters the merge queue, so you will see it skipped until the
PR is queued. Steps:

1. `pnpm install --frozen-lockfile` (pnpm 11.25.0, Node 24.20.0, pnpm cache)
2. `pnpm run lint:dead-code` — knip against the committed baseline. Runs on
   source, so it needs no build and fails in about a minute, ahead of the
   expensive steps.
3. `pnpm run build:core`
4. `pnpm run typecheck:extensions`
5. `pnpm run build:native:test` with `RUSTFLAGS: -C debuginfo=0`, over a cargo
   cache keyed on the `native/**` manifests
6. `pnpm run test:unit`

Two non-obvious details are load-bearing, and both are commented in the
workflow:

- **The native addon is rebuilt from source.** The unit suite drives fault
  injection through the native engine, and the pinned `@opengsd/engine-*`
  binary lags the Rust source. Without this step the loader silently falls back
  to the pinned binary and the migrate-safety-audit suite fails on
  `setMutationBoundaryFaultForTest`.
- **`RUSTFLAGS` must be overridden.** `native/.cargo/config.toml` builds with
  `-C target-cpu=native` for local dev. The runner fleet is heterogeneous, so a
  cached proc-macro `.so` built on one runner can be restored onto a narrower
  one, and rustc dies with SIGILL when it dlopens `napi_derive`. Any non-empty
  `RUSTFLAGS` replaces the config wholesale, dropping `target-cpu=native`.

## What gates merge

Not GitHub branch protection — Mergify. `.mergify.yml` sets
`branch_protection_injection_mode: queue` and requires both jobs:

```yaml
queue_conditions:
  - base = main
  - check-success = @github-actions/fast-gates
merge_conditions:
  - check-success = @github-actions/fast-gates
  - check-success = @github-actions/build-and-test
```

`fast-gates` appears in **both** lists on purpose: because it runs on the PR
itself, requiring it as a queue condition keeps a known-red PR from entering
the queue and burning a check slot.

## What CI still does not run

These exist as scripts, are useful, and are enforced nowhere but your machine:

| Local command | What it covers | In CI? |
|---|---|---|
| `pnpm run verify:merge` (`scripts/verify-merge.sh`) | Full Linux stack: `validate-pack`, workspace and extension coverage, compiled unit + package tests, `@gsd/pi-ai` vitest, integration, e2e | No |
| `pnpm run verify:merge:needed` (`scripts/ci-classify-changes.sh`) | Heavy-change classification — decides whether `verify:merge` is worth paying for | No |
| `pnpm run test:integration`, `test:packages`, `test:e2e` | Everything beyond `test:unit` | No |
| `pnpm run test:coverage`, `test:coverage:full` | c8 thresholds and merged coverage | No |
| `pnpm run test:e2e:docker`, `test:e2e:windows-smoke` | Docker and Windows paths | No |

`scripts/ci-classify-changes.sh` is **not** dead code — `scripts/verify-merge.sh`
and `scripts/verify-merge-needed.sh` both call it, and
`scripts/__tests__/verify-merge.test.mjs` asserts it. It is simply local-only:
no CI job has invoked it since the pipeline was cut down, so the path gating it
implements is a local cost-saving heuristic, not a CI behaviour.

There is no Windows job, no Docker job, and no coverage workflow.

## Recommended local workflow

```bash
pnpm run verify:fast      # what fast-gates runs — check before pushing
pnpm run verify:pr        # inner loop: build:core + typecheck + unit
pnpm run verify:merge     # before requesting review on heavy code changes
```

Use `pnpm run verify:merge:needed -- --base upstream/main` first to decide
whether the diff warrants the expensive one. See
[Test confidence stack](./test-confidence-stack.md) for the code-area → runner
map.

## Publishing

There is no automated publish path. The workflows that built native binaries,
stamped prerelease versions, published to npm, pushed Docker images, and cut
GitHub Releases were all deleted. The scripts they called
(`verify-npm-release.mjs`, `sync-platform-versions`, `pipeline:version-stamp`)
still exist in `scripts/` and `package.json`, but nothing invokes them.

Publishing this fork today means running those steps by hand. Treat any
instruction elsewhere in the docs that says "run the NPM Publish workflow" as
obsolete.

## Keeping this document honest

The job names and workflow filenames above are machine-checked.
`scripts/lib/ci-workflow-lib.mjs` parses `.github/workflows/*.yml` and
`.mergify.yml`; `scripts/audit-test-confidence.mjs --strict` fails when a
documented job does not exist, when it is documented as blocking but missing
from `merge_conditions`, when it no longer runs a step the map claims, when a
blocking job carries an undeclared `if:` that would let it skip, or when a
workflow defines a job nobody documented.

`scripts/__tests__/ci-workflow-lib.test.mjs` additionally fails the build if
this file or [test-confidence-stack.md](./test-confidence-stack.md) references
a workflow filename that is not on disk, or calls a name a job when no workflow
defines it.

All of it runs inside `fast-gates`, on every PR.

One convention keeps those guards usable when editing this file: refer to a
deleted workflow by bare name, without backticks. The filename check only
inspects backticked names, so backticks assert "this exists".
