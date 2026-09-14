# Test Evaluation Report

Generated: 2026-09-13T22:44:33.090Z

## Summary

| Metric | Count |
|--------|------:|
| Source files | 1556 |
| Covered (named test) | 550 |
| Indirect (stem/other-name/suite tests) | 1003 |
| Untested | 0 |
| Unwired | 0 |
| Critical untested | 0 |
| High untested | 0 |

## Untested by area (top 20)

| Area | Untested / Total | Critical untested |
|------|----------------:|------------------:|
| pkg:contracts | 0 / 3 | 0 |
| pkg:db | 0 / 3 | 0 |
| pkg:gsd-agent-core | 0 / 34 | 0 |
| pkg:gsd-agent-modes | 0 / 104 | 0 |
| pkg:mcp-server | 0 / 28 | 0 |
| pkg:native | 0 / 33 | 0 |
| pkg:pi-agent-core | 0 / 33 | 0 |
| pkg:pi-ai | 0 / 83 | 0 |
| pkg:pi-coding-agent | 0 / 218 | 0 |
| pkg:pi-tui | 0 / 35 | 0 |
| pkg:rpc-client | 0 / 5 | 0 |
| scripts | 0 / 57 | 0 |
| src:app-paths.ts | 0 / 1 | 0 |
| src:bootstrap.ts | 0 / 1 | 0 |
| src:bundled-extension-paths.ts | 0 / 1 | 0 |
| src:bundled-resource-path.ts | 0 / 1 | 0 |
| src:claude-cli-check.ts | 0 / 1 | 0 |
| src:cli-args.ts | 0 / 1 | 0 |
| src:cli-auto-routing.ts | 0 / 1 | 0 |
| src:cli-model-override.ts | 0 / 1 | 0 |

## Priority gaps (critical/high untested)


## Acknowledged unrun test files

No runner executes these. They are recorded rather than wired, and excluded from the strict gate.

- **1 file(s)** — packages/db has no package.json, so it is not a pnpm workspace package and run-package-tests.cjs never iterates it. Its packages/db/src files are excluded from the untested count by this same entry.
- **182 file(s)** — Vendored earendil-works/pi test corpus (docs/dev/pi-upstream.md, scripts/pi-upstream.json). ADR-010 deleted the src/modes, src/cli, src/core/sdk.ts, src/core/compaction and src/core/export-html paths that roughly 40 of these files import, so the corpus cannot be enabled wholesale.

Regenerate: `npm run audit:test-matrix -- --write-report`
