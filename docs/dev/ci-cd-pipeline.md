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
| `.github/workflows/ci.yml` | One workflow, one job |

Everything else this repo calls a "gate" is a local script. That is a
deliberate trade, and the important consequence is in the next section.

## The only CI job

`ci.yml` triggers on `pull_request` against `main` — there is no `push:`
trigger, no `workflow_dispatch`, and no schedule. It defines a single job,
`build-and-test`, guarded by:

```yaml
if: startsWith(github.head_ref, 'mergify/merge-queue/')
```

**That guard means the job does not run on your PR.** It runs only on the
temporary branches Mergify creates when a PR enters the merge queue. Open a
pull request and you will see `build-and-test` skipped; it executes once, after
you queue the PR, against the prospective merge result.

The job runs on `ubuntu-latest`:

1. `pnpm install --frozen-lockfile` (pnpm 10.12.1, Node 24.20.0, pnpm cache)
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

## What actually gates merge

Not GitHub branch protection — Mergify. `.mergify.yml` sets
`branch_protection_injection_mode: queue` and declares exactly one required
check:

```yaml
merge_conditions:
  - check-success = @github-actions/build-and-test
```

So the complete merge gate is: **the unit suite, a typecheck, a core build, and
the dead-code baseline, run once in the merge queue.** Nothing else blocks.

## What CI does not run

This is the honest part of the document. All of the following exist as scripts,
are useful, and are enforced nowhere except on your machine:

| Local command | What it covers | CI job |
|---|---|---|
| `pnpm run verify:fast` (`scripts/ci-fast-gates.sh`) | Secret scan, base64 scan, docs prompt-injection scan, skill references, `require-tests`, source-grep test rejection, the three `audit:*` strict gates, `scripts/__tests__/`, pi boundary, dead code, actionlint | **none** |
| `pnpm run verify:merge` (`scripts/verify-merge.sh`) | Full Linux stack: `validate-pack`, workspace coverage, compiled unit + package tests, integration, e2e | **none** |
| `pnpm run verify:merge:needed` (`scripts/ci-classify-changes.sh`) | Heavy-change classification — decides whether `verify:merge` is worth paying for | **none** |
| `pnpm run test:integration`, `test:packages`, `test:e2e`, `test:coverage` | Everything beyond `test:unit` | **none** |

Note the filename trap: `scripts/ci-fast-gates.sh` is named after a `fast-gates`
CI job that was deleted in `854209ad`. The script is current and worth running;
the name is a fossil.

Likewise `scripts/ci-classify-changes.sh` is **not** dead code — it is called by
`scripts/verify-merge.sh` and `scripts/verify-merge-needed.sh` and asserted by
`scripts/__tests__/verify-merge.test.mjs`. It is simply local-only. No CI job
has invoked it since the pipeline was cut down.

There is no Windows job, no Docker job, no coverage workflow, and no
path-gating in CI. Those concepts survive only inside the local scripts.

## Recommended local workflow

Because the merge gate is thin, local verification is doing the real work:

```bash
pnpm run verify:fast      # before every push — fast, catches policy/security
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
documented job is not defined by any workflow, when a workflow defines a job
nobody documented, or when `.mergify.yml` requires a check that does not exist.
`scripts/__tests__/ci-workflow-lib.test.mjs` additionally fails this file and
[test-confidence-stack.md](./test-confidence-stack.md) if either references a
workflow filename that is not on disk.

Both run inside `pnpm run verify:fast`.

Two conventions keep those guards usable when editing this file:

- Refer to a deleted workflow by bare name, without backticks — the filename
  check only inspects backticked names, so backticks assert "this exists".
- Do not describe something as a job unless a workflow defines it. The guard
  looks for a backticked name followed by the word "job".
