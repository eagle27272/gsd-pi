# Pi upstream tracking and upgrade runbook

GSD vendors the [earendil-works/pi](https://github.com/earendil-works/pi) monorepo (formerly `badlogic/pi-mono` / `@mariozechner/pi-*`) into `packages/pi-*`. GSD-specific session, mode, and CLI code lives in `@gsd/agent-core` and `@gsd/agent-modes` per [ADR-010](./ADR-010-pi-clean-seam-architecture.md).

**Overlay policy (2026-05-26):** Vendored pi is **upstream + allowlisted deltas**, not pristine upstream. See [ADR-010 amendment](./ADR-010-pi-clean-seam-architecture.md) and the executable checklist in [pi-overlay-execution-plan.md](./pi-overlay-execution-plan.md).

## Current status (Phase 2 complete)

| Item | Value |
|---|---|
| Upstream repo | `earendil-works/pi` |
| Pinned ref | **v0.75.5** |
| npm scope (upstream) | `@earendil-works/pi-*` |
| GSD packages | `@gsd/pi-*`, `@gsd/agent-core`, `@gsd/agent-modes` |
| Build | `npm run build:pi` |
| Boundary | `npm run verify:pi-boundary` (also in `scripts/ci-fast-gates.sh`) |
| Patch inventory CI | `npm run verify:pi-patches` |
| Claude tool schemas | `npm run test:pi-claude-schemas` |

Phase 2 used **GSD shim restoration** (incremental compat on upstream v0.75.5 APIs) rather than a full upstream modes sync. `@gsd/agent-modes` was migrated from the old GSD fork and reconciled via shims in pi-tui, pi-coding-agent, pi-ai, and agent-core.

## Pin metadata

See [`scripts/pi-upstream.json`](../../scripts/pi-upstream.json):

| Upstream path | GSD package |
|---|---|
| `packages/agent` | `@gsd/pi-agent-core` |
| `packages/ai` | `@gsd/pi-ai` |
| `packages/tui` | `@gsd/pi-tui` |
| `packages/coding-agent` | `@gsd/pi-coding-agent` |

Protected from vendor overwrite: `packages/gsd-agent-core`, `packages/gsd-agent-modes`.

`patchAllowlist` in the same JSON file lists every path GSD may diverge from upstream under `packages/pi-*`. CI (`verify:pi-patches`) fails if you change other pi-* files without updating the allowlist. By default the script checks **working tree** changes only; set `VERIFY_PI_PATCHES_BRANCH=1` to include the full branch diff vs main (vendor bumps).

## Verification (after every vendor or seam change)

```bash
npm run build:pi
npm run verify:pi-boundary
npm run verify:pi-patches
npm run test:pi-claude-schemas
npm run test:smoke
```

Optional fuller checks:

```bash
npm run build
npm test
node scripts/verify-pi-boundary.cjs
```

Smoke tests exercise CLI `--help` and `--version` only; they do not require API keys. **Smoke does not catch Cloud Code Assist tool-schema 400s** — use golden B (`test:pi-claude-schemas`).

## Upgrade workflow

1. **Ensure seam is green** — run verification commands above on current pin before touching upstream.
2. **Vendor upstream** (does not touch GSD packages):
   ```bash
   node scripts/vendor-pi.cjs --ref vX.Y.Z
   ```
   `vendor-pi.cjs` is the only vendoring script that talks to the upstream remote, so it is
   the only one that takes `--ref`. It refreshes `.cache/pi-upstream` at that ref (default:
   `pinnedRef` in `scripts/pi-upstream.json`), then runs the three post-vendor steps in order.

   | Flag | Effect |
   |---|---|
   | `--ref vX.Y.Z` | Upstream tag/branch to check out. Defaults to `pinnedRef`. |
   | `--checkout-only` | Refresh `.cache/pi-upstream` and stop, for driving the steps by hand. |
   | `--skip-checkout` | Run the steps against whatever is already staged in `.cache/pi-upstream`. |
   | `--dry-run` | Print the ref and the steps without cloning or running anything. |

   The three steps take **no arguments** — they read whatever `.cache/pi-upstream` already
   contains. To run them individually, stage the ref first:
   ```bash
   node scripts/vendor-pi.cjs --ref vX.Y.Z --checkout-only  # refresh .cache/pi-upstream only
   node scripts/vendor-pi-deps.cjs               # pi-ai, pi-agent-core, pi-tui + import/package.json/tsconfig normalization
   node scripts/vendor-pi-coding-agent-core.cjs  # pi-coding-agent src/core + src/utils, seam files preserved
   node scripts/apply-seam.cjs                   # post-vendor deletes, import rewrites, index trim, boundary verify
   ```
   `packages/coding-agent` is never copied wholesale: `vendor-pi-coding-agent-core.cjs` syncs
   only `src/core` and `src/utils` and restores the seam files around them, so the allowlisted
   patches under `packages/pi-coding-agent/src` survive the copy.

   Seam config: `scripts/pi-seam.json` (forbidden paths, protected files, import rewrites, theme/tool fixes).
3. **Reconcile GSD shims** — re-apply every path in `patchAllowlist`. Prefer **incremental shims** over restoring entire pre-vendor GSD files (HEAD restore of `model-registry.ts` / `settings-manager.ts` broke v0.75.5 compat in Phase 2).
4. **Normalize package.json** — preserve `@gsd/pi-*` names, `gsd.linkable`, workspace `tsc` build scripts, and subpath exports (`./*` → `./dist/*`).
5. **Fix import extensions** — GSD uses Node16 `.js` suffix imports; upstream may use `.ts` for `tsgo`. Bulk-fix or adopt upstream `tsconfig.build.json` if switching compilers.
6. **Merge dependency deltas** — upstream may rename packages (`typebox` vs `@sinclair/typebox`). Merge without dropping `@gsd/native` shims.
7. **Build GSD layers** — errors should surface in `@gsd/agent-core` and `@gsd/agent-modes`, not in vendored pi-* except documented shims.
8. **Session event migration** (pi ≥ 0.65): use `session_start` + `reason` instead of deprecated `session_switch` / `session_fork` / `session_directory`.
9. **Update pin** in `scripts/pi-upstream.json` and note manual patches in this file.
10. **Verify** — full verification block above (+ optional live Cloud Code Assist smoke — see execution plan “Golden C”).

## GSD patches that must survive vendoring

Every row must have a matching entry in `scripts/pi-upstream.json` → `patchAllowlist`.

| Area | Location | Purpose |
|---|---|---|
| Clean seam | `packages/gsd-agent-core`, `packages/gsd-agent-modes` | Session, SDK, modes, CLI |
| Type seam | `packages/pi-coding-agent/src/core/gsd-seam-types.ts` | Avoid compile-time pi ↔ agent-core cycle |
| Session types | `packages/pi-coding-agent/src/core/extension-session-types.ts` | Re-export session types from `@gsd/agent-core` |
| Ambient shim | `packages/pi-coding-agent/src/agent-core.d.ts` | Extension types without package dep |
| Extension loader | `packages/pi-coding-agent/src/core/extensions/loader.ts` | `@gsd/agent-*`, `@earendil-works/*` aliases |
| GSD core files | `model-discovery.ts`, `discovery-cache.ts`, `models-json-writer.ts`, `package-commands.ts`, `local-model-check.ts`, `capability-patches.ts`, `bash-interceptor.ts`, `constants.ts` | Provider discovery, offline mode, capability patches |
| Keybindings | `packages/gsd-agent-core/src/keybindings.ts` | Legacy `AppAction` names + `app.*` keybinding map (pi re-exports via shim) |
| Model registry shims | `packages/pi-coding-agent/src/core/model-registry.ts` | `discoverModels`, `isAllLocalChain`, `getApiKey`, GSD auth modes |
| Settings shims | `packages/pi-coding-agent/src/core/settings-manager.ts` | Adaptive TUI, compaction override, gitignore picker |
| Interactive stream dedup | `packages/gsd-agent-modes/src/modes/interactive/controllers/chat-controller.ts`, `packages/gsd-agent-modes/src/modes/interactive/components/chat-turn-connect.ts` | Reconcile mismatched tool IDs across event streams |
| pi-tui shims | `style.ts`, `editor-keybindings.ts`, `Container.detachChildren`, `Markdown.maxLines`, `Input.secure`, `Image.getDimensions` | GSD interactive mode compat |
| pi-ai shims | `ServerToolUse` / `WebSearchResult` types, `server_tool_use` event, `supportsXhigh()` | GSD content blocks + thinking level |
| Tool argument normalization tests | `packages/pi-ai/src/utils/tests/normalize-tool-arguments.test.ts` | Regression coverage for shared validation/transcript argument normalization |
| **Claude tool schemas** | `packages/pi-ai/src/providers/google-shared.ts` | Cloud Code Assist / Claude `input_schema` sanitization (`toClaudeInputSchemaRoot`, `normalizeClaudeToolSchemaForGoogle`) |
| **Claude schema tests** | `packages/pi-ai/test/google-shared-convert-tools.test.ts`, `src/resources/extensions/gsd/tests/claude-tool-schema-golden.test.ts` | Golden B regression |
| OAuth cache breakpoint | `packages/pi-ai/src/providers/anthropic.ts` (`buildParams`) | Drop `cache_control` from the constant Claude Code identity block when a real system prompt follows — the trailing breakpoint already covers it; saves one of Anthropic's 4 cache breakpoints |
| OAuth cache breakpoint test | `packages/pi-ai/test/cache-retention.test.ts` | Regression coverage for single-breakpoint OAuth system array |
| `cacheRetention` passthrough | `packages/pi-agent-core/src/agent.ts` (`AgentOptions.cacheRetention`, `Agent.cacheRetention`, `createLoopConfig`) | Threads a settable prompt-cache TTL preference into `AgentLoopConfig`/`StreamOptions` — previously the field existed on `StreamOptions` but nothing populated it for the `Agent` class (only the separate, unused `AgentHarness` had it) |
| `cacheRetention` passthrough test | `packages/pi-agent-core/test/agent.test.ts` | Regression coverage for `cacheRetention` reaching `streamFn` options, pattern-matched off the existing `sessionId` passthrough test |
| `cacheRetention` setting test | `packages/pi-coding-agent/test/settings-manager.test.ts` | Regression coverage for `getCacheRetention`/`setCacheRetention` persistence, pattern-matched off `httpIdleTimeoutMs` |
| Per-line ending restoration | `packages/pi-coding-agent/src/core/tools/edit-diff.ts` (`restoreLineEndings`, `AppliedEditsResult.appliedRanges`), `packages/pi-coding-agent/src/core/tools/edit.ts` | Upstream restores one detected ending across the whole file, so editing a mixed-ending file silently rewrites every other line while the LF-space diff shows only the edit. Terminators are now restored per line from the bytes on disk |
| Per-line ending test | `packages/pi-coding-agent/test/edit-line-ending-scope.test.ts` | Regression coverage that untouched terminators survive and the preview diff changes the same lines as the write |
| Bash execution width test (deleted) | `packages/pi-coding-agent/test/bash-execution-width.test.ts` | Upstream's #2569 test for `BashExecutionComponent`, which ADR-010 moved to `@gsd/agent-modes`. Re-pointing it would make a pi-* package import `@gsd/agent-modes`; the equivalent coverage lives in `packages/gsd-agent-modes/src/modes/interactive/components/bash-execution.test.ts`. Delete again after a vendor bump restores it |
| Theme path | `packages/pi-coding-agent/src/theme/` | Shared theme (not under `modes/`) |
| Copy assets | `packages/pi-coding-agent/scripts/copy-assets.cjs` | Theme + LSP assets |
| Root staging | `scripts/copy-themes.cjs`, `scripts/copy-export-html.cjs` | Bun binary / pkg layout |

## CI boundary

```bash
npm run verify:pi-boundary
npm run verify:pi-patches
```

Fails if `packages/pi-*/src/` imports `@gsd/agent-*` or `@opengsd/*` outside the allowlist, or if pi-* files change without `patchAllowlist` coverage.

`verify:pi-boundary` also chains `bash scripts/check-mcp-bridge-boundary.sh`, which fails if `packages/mcp-server/src/workflow-tools.ts` imports core GSD extension modules (`bootstrap/write-gate`, `bootstrap/dynamic-tools`, `gsd-db`, `state`, `preferences`, `db-writer`, `doctor`, `journal`, `milestone-ids`) directly instead of through `src/resources/extensions/gsd/mcp-bridge.ts`.

## Vendored test corpora are not run

`packages/pi-*/test/` is the upstream pi test corpus that comes along with each vendor sync. **No runner executes it**, and that is deliberate:

| Directory | Files | Status |
|---|---:|---|
| `packages/pi-coding-agent/test/` | 135 | Unrun. ~40 files import `../src/modes/**`, `../src/cli/**`, `../src/core/sdk.ts`, `../src/core/compaction/**` and `../src/core/export-html/**` — paths [ADR-010](./ADR-010-pi-clean-seam-architecture.md) deliberately deleted from the package. Enabling the suite wholesale fails immediately. |
| `packages/pi-tui/test/` | 27 | Unrun. `vitest.config.ts` includes only `test/wrap-ansi.test.ts`, and the package has no `test` script. |
| `packages/pi-agent-core/test/` | 20 | Unrun. Has a `"test": "vitest --run"` script, but nothing invokes it. |
| `packages/pi-ai/test/` | 81 | **Runs**, but only via `pnpm --filter @gsd/pi-ai test` in [`scripts/verify-merge.sh`](../../scripts/verify-merge.sh) — not from `npm test`. |

What *does* run per package is `packages/<pkg>/src/**`: `scripts/compile-tests.mjs` mirrors it into `dist-test/packages/<pkg>/src` (and explicitly deletes `dist-test/packages/<pkg>/test`), and `scripts/run-package-tests.cjs` globs only that mirrored `src` tree.

`scripts/lib/test-audit-lib.mjs` encodes this: `packages/<pkg>/src/**` → `packages`, `packages/pi-ai/test/**` → `verify-merge`, the other three → `vendored-upstream`. The `vendored-upstream` bucket is recorded in `ACKNOWLEDGED_UNRUN_RUNNERS`, so `audit:test-gaps --strict-unwired` reports it with its reason instead of failing on it. Do not silence a *new* dead test by adding it there — wire it, or record it with a reason that stands on its own.

## Tool schema authoring

GSD extension tools must pass golden B when sanitized for Claude. Authoring rules: [tool-schema-authoring.md](./tool-schema-authoring.md).

## Legacy names

Docs and extension loader still accept `@mariozechner/pi-*` during transition. New code should reference `earendil-works/pi` and `@earendil-works/pi-*`.

## Known limitations after v0.75.5 vendor

- **Provider discovery** is wired via `ModelRegistry.discoverModels()` + `model-discovery.ts` adapters; cache at `~/.pi/agent/discovery-cache.json`. Static providers (Anthropic, Bedrock) still have no runtime discovery.
- **GSD content blocks** (`serverToolUse`, `webSearchResult`) use type guards in agent-modes (`gsd-content-blocks.ts`) rather than extending upstream `AssistantMessage.content` unions (avoids breaking pi-ai providers).
- **Extension context** uses optional `setCompactionThresholdOverride` and legacy keybinding action names; upstream uses `app.*` keybinding IDs internally.
- **Cloud Code Assist** requires strict Claude tool schemas; sanitizer in `google-shared.ts` plus golden B tests are mandatory overlay deltas.
