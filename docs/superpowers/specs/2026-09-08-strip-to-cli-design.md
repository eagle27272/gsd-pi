# Strip GSD Pi to the CLI — Design

**Date:** 2026-09-08
**Status:** Approved for planning
**Branch:** `personal/strip-to-cli`

## Context

This repository is a personal hard fork of `open-gsd/gsd-pi` (forked, then
detached from the fork network). It will be fully customized for one person's
use. The owner uses only the interactive `gsd` terminal app and will never
merge upstream changes again.

Today the repo is a large pnpm monorepo: ~14 workspace packages, ~28 bundled
extensions, a web UI (`web/` + `src/web/` + `gsd --web`), a VS Code extension,
an MCP server, a Discord/monitoring daemon, a cloud MCP gateway, three docs
sites, Docker packaging, a Python `hermes` integration, and CI/release
automation (npm publish, changelog, Discord webhook).

## Goals

- Reduce cognitive load — fewer files, dirs, and concepts when working on the code.
- Faster builds and installs — fewer workspace packages and dependencies.
- Shrink the maintenance surface — fewer moving parts, tests, and security-relevant deps.
- Clean personal-fork identity — no upstream branding, docs sites, or release/Discord machinery.

## Non-goals

- No upstream merge compatibility. Merge conflicts are irrelevant; deletion is safe.
- No rewrite or re-architecture of kept code. Remove, don't refactor.
- No trimming of the `pi-ai` internal provider/model catalog (generated, deep, low payoff).
- Headless / print mode (`gsd -p`, `src/headless*.ts`) is **left untouched** — low
  cognitive-load cost, and it shares code paths with auto mode.
- `browser-tools` and `visual-brief` are **kept**. Exploration found the kept `gsd`
  and `mac-tools` extensions statically import them (browser engine selection,
  web-app UAT, screenshot constraints, the `/brief` command). Removing them means
  surgery in `gsd/auto.ts` and the command catalog for little benefit; not worth it.

## Keep / Remove inventory

### KEEP — the CLI core

- **Interactive TUI** (`gsd`): onboarding, planned and quick coding sessions,
  worktree-aware git automation, `.gsd/` project memory, auto mode.
- **Providers:** Claude OAuth (Anthropic API), Claude Code CLI, Ollama.
- **Bundled extensions:** `gsd`, `shared`, `async-jobs`, `bg-shell`,
  `slash-commands`, `subagent`, `universal-config`, `mcp-client`, `github-sync`,
  `claude-code-cli`, `ollama`, `ask-user-questions`, `get-secrets-from-user`,
  `mac-tools`, `search-the-web`, `browser-tools`, `visual-brief`.
- **Workspace packages:** `contracts`, `native`, `pi-ai`, `pi-agent-core`,
  `pi-coding-agent`, `pi-tui`, `rpc-client`, `gsd-agent-core`, `gsd-agent-modes`,
  `db`.
- **Headless / print mode** — untouched.
- **CI:** one minimal `ci.yml` (pnpm build + unit tests on push/PR).

### REMOVE

- **Bundled extensions — clean leaves (7):** `voice`, `ttsr`, `google-search`,
  `aws-auth`, `google-cli`, `cursor-cli`, `context7`. Only soft references
  (onboarding hint text, API-key catalog entries, one `doctor-providers.ts`
  import). Delete the dir, drop the soft refs.
- **Bundled extensions — full surgery (2):** `remote-questions` and `cmux` are
  statically imported by the kept `gsd` extension (command polling in
  `auto.ts`, `notifications.ts`, `/remote` command handler, welcome-screen hook,
  `ask-user-questions.ts`, `src/onboarding.ts`; cmux sidebar/log event
  emissions scattered through `auto.ts`, `bootstrap/register-extension.ts`,
  `commands-cmux.ts`, `shared/cmux-events.ts`). Removal deletes the extension
  **and** every call site in kept code.
- **Web UI:** `web/` workspace package, `src/web/`, `src/web-mode.ts`,
  `src/cli-web-branch.ts`, the `--web` flag and `web` subcommands in `src/cli.ts`,
  `@opengsd/gsd-browser` dependency, web build scripts
  (`scripts/build-web-if-stale.cjs`, `scripts/stage-web-standalone.cjs`),
  `package.json` web scripts (`gsd:web*`, `build:web-host`, `stage:web-host`,
  the web tail of `build`), and the `web` entry in `pnpm-workspace.yaml`.
- **VS Code extension:** `vscode-extension/` and its build wiring.
- **Docs sites and containers:** `gitbook/`, `mintlify-docs/`, `docker/`,
  `Dockerfile`, `.dockerignore`, `gsd-orchestrator/`,
  `screenshot-context-breakdown.jpg`. Keep the plain `docs/` tree.
- **Server / cloud / integrations:** `packages/mcp-server` (and the `gsd graph`
  subcommands and the `gsd-mcp-server` bin that depend on it), `src/mcp-server.ts`,
  `src/mcp-mode-tools.ts`, `packages/cloud-mcp-gateway`, `packages/daemon`
  (Discord/monitoring — remove once confirmed unreferenced on the interactive
  path), `integrations/hermes/` and `src/hermes-integration-install.ts`.
- **CI/release automation:** all `.github/workflows/*` except a new minimal
  `ci.yml`; release-highlights automation in `README.md` and its scripts;
  changelog / Discord / npm-publish / Dependabot workflows.
- **Identity:** rewrite `README.md`; update `package.json` `name`, `repository`,
  `homepage`, `bugs` to `eagle27272/gsd-pi` and drop `publishConfig.provenance`;
  reset `CHANGELOG.md` to a fork stub; delete `CONTEXT.md`; simplify
  `.npmignore` / `.npmrc` / `publishConfig` since nothing is published;
  update `.mcp.json`.

## Approach

**Staged, outside-in, build-verified.** Remove in dependency order —
standalone top-level dirs first, then leaf extensions, then the web UI, then
MCP/daemon, then identity cleanup. Build and smoke-test the TUI after each
stage and commit per stage, so every commit leaves a working `gsd` and any
breakage is bisectable.

Rejected alternatives:

- *Big-bang branch* — one commit, fix the build once at the end. In a codebase
  this interconnected the build breaks in dozens of places at once with no way
  to isolate cause.
- *Disable-then-delete* — flip everything off via the extension registry first,
  verify, then delete dead code in a second pass. Safer reference detection but
  roughly doubles the work and leaves dead code between passes.

## Stages

### Stage 0 — Baseline and safety net

- Create branch `personal/strip-to-cli`.
- Run `pnpm install`, `pnpm run build:core`, `pnpm run test:unit`, and a TUI
  smoke (`node scripts/dev-cli.js --help`, launch to prompt). Record the
  starting pass/fail set — this is the regression baseline for every later gate.

### Stage 1 — Standalone top-level directories

Nothing on the CLI path imports these.

- Delete `vscode-extension/`, `gitbook/`, `mintlify-docs/`, `docker/`,
  `Dockerfile`, `.dockerignore`, `gsd-orchestrator/`, `integrations/hermes/`,
  `screenshot-context-breakdown.jpg`.
- Remove `src/hermes-integration-install.ts` and its call sites.
- Update `package.json` `files[]` (drop `integrations/hermes*` entries).
- Replace `.github/workflows/*` with a single minimal `ci.yml`.
- **Gate.**

### Stage 2 — Clean-leaf extensions (7)

For each of `voice`, `ttsr`, `google-search`, `aws-auth`, `google-cli`,
`cursor-cli`, `context7`:

- Delete `src/resources/extensions/<name>/`.
- Remove soft references: onboarding `TOOL_KEYS` entries (`context7`; the Groq
  hint text mentions voice), `src/wizard.ts` `context7` row, `gsd`
  key-manager / config / doctor catalogs (`context7`, `cursor-cli`), and the
  `cursor-cli` import in `gsd/doctor-providers.ts`.
- Delete matching test files.
- Update `package.json` test globs that name removed paths.
- Keep the `ttsr` native bindings in `packages/native` (harmless, separate
  concern) — only the TS extension is removed.
- **Gate.** One or two commits.

### Stage 2b — `remote-questions` full surgery

- Delete `src/resources/extensions/remote-questions/` and `src/remote-questions-config.ts`.
- `gsd/auto.ts`: remove the `../remote-questions/manager.js` import, the
  `startAutoCommandPolling` / `stopAutoCommandPolling` wrappers, and their call
  sites (`isRemoteConfigured()` guard, `s.commandPollingCleanup`).
- `gsd/notifications.ts`: drop `sendRemoteNotification` import; make
  `remoteNotificationDispatcher.send` a no-op (or remove the dispatcher and its
  one caller).
- `gsd/commands/handlers/ops.ts`: remove the `handleRemote` import and the
  `remote` / `remote …` command branch.
- `gsd/bootstrap/register-hooks.ts`: remove the dynamic
  `../../remote-questions/config.js` import and the `remoteChannel` plumbing
  into `buildWelcomeScreenLines`.
- `ask-user-questions.ts`: remove the `tryRemoteQuestions` / `isRemoteConfigured`
  dynamic import and collapse the "race remote + local" routing to local-only.
- `src/onboarding.ts`: remove the three `saveRemoteQuestionsConfig` dynamic
  imports and the Slack / Telegram / Discord channel-config prompts that call them.
- Delete `gsd/tests/remote-questions.test.ts`, `remote-status.test.ts`,
  `remote-notification-from-desktop.test.ts`, `auto-remote-session-lock-cleanup.test.ts`,
  `discord-invite-links.test.ts`, and remote assertions in
  `register-hooks-depth-verification.test.ts`.
- Prune `discord.js` from root `package.json` if now orphaned.
- **Gate**, including an auto-mode smoke.

### Stage 2c — `cmux` full surgery

- Delete `src/resources/extensions/cmux/`, `src/resources/extensions/shared/cmux-events.ts`,
  and `src/resources/extensions/gsd/commands-cmux.ts`.
- `gsd/auto.ts`: remove the `CMUX_CHANNELS` / `CmuxLogLevel` import, the
  `makeCmuxEmitters` function, the `...cmux` spread into `LoopDeps`, the
  `clearCmuxSidebar` call in `handleLostSessionLock`, and every
  `pi.events.emit(CMUX_CHANNELS.…)` site (~8, around lines 2063, 3046, 3088,
  3165, 3170). Drop the cmux members from the `LoopDeps` type.
- `gsd/bootstrap/register-extension.ts`: remove the `initCmuxEventListeners`
  import and the `["cmux-events", …]` listener registration.
- `gsd/bootstrap/system-context.ts` and `gsd/commands/handlers/core.ts`: remove
  the `autoEnableCmuxPreferences` / `handleCmux` imports and call sites; remove
  the `/cmux` command from the catalog.
- Remove `cmux` from the GSD preferences schema/types if it has a typed field.
- Delete `gsd/tests/cmux.test.ts` and cmux assertions in `runtime-contract.test.ts`.
- **Gate**, including an auto-mode smoke.

### Stage 3 — Web UI

- Delete `web/`, `src/web/`, `src/web-mode.ts`, `src/cli-web-branch.ts`.
- In `src/cli.ts`: remove the `cli-web-branch` / `web-mode` imports, `--web`
  flag parsing, the `web` / `web stop` subcommand branches, the `cliFlags.web`
  TTY guard, and the `web` entry in the subcommand list.
- Strip `--web` lines from `src/help-text.ts`, `src/onboarding.ts`,
  `src/welcome-screen.ts`.
- Delete `scripts/build-web-if-stale.cjs`, `scripts/stage-web-standalone.cjs`;
  remove `package.json` scripts `gsd:web`, `gsd:web:stop`, `gsd:web:stop:all`,
  `build:web-host`, `stage:web-host`, and the web tail of `build` (make `build`
  == `build:core`).
- Remove `web` from `pnpm-workspace.yaml`.
- Remove web-only deps from root `package.json`.
- **Gate**, including a full session-start smoke.

### Stage 4 — MCP server, cloud gateway, daemon, `gsd graph`

- Delete `packages/mcp-server` and `packages/cloud-mcp-gateway`.
- `grep -rn "@opengsd/daemon"` across `src/`, `packages/pi-*`,
  `packages/gsd-agent-*`. If nothing on the interactive path imports it, delete
  `packages/daemon`; otherwise keep it and note why.
- In `src/cli.ts`: remove the `@opengsd/mcp-server` import and the `graph`
  subcommands (`buildGraph`, `writeGraph`, `graphStatus`, `graphQuery`,
  `graphDiff`); remove the `startMcpServer` branch.
- Delete `src/mcp-server.ts` and `src/mcp-mode-tools.ts` and their wiring
  (`src/register-agent-bundles.ts` and `src/tool-bootstrap.ts` if they touch
  MCP-mode tools).
- Remove the `gsd-mcp-server` bin entry and `build:mcp-server` / `build:daemon`
  scripts from `package.json`.
- Prune `@modelcontextprotocol/sdk` and daemon-only deps (`discord.js`) if now
  orphaned.
- Update `.mcp.json`.
- **Gate.**

### Stage 5 — Provider trim (light)

- Cursor and Gemini providers are already gone with their extensions (Stage 2).
- Remove removed-provider options from static lists in `src/onboarding.ts` and
  `src/startup-model-validation.ts` if present.
- Do **not** touch the `pi-ai` catalog internals.
- **Gate** with an onboarding smoke. May fold into a Stage 2 commit.

### Stage 6 — Identity cleanup

- Rewrite `README.md`: what this personal fork is, build-from-source, `gsd`
  usage. Drop badges, upstream links, npm-install and migration sections, and
  the release-highlights markers.
- `package.json`: `name` -> personal (decision below), `repository` /
  `homepage` / `bugs` -> `eagle27272/gsd-pi`, drop `publishConfig.provenance`,
  keep `bin.gsd`.
- `CHANGELOG.md` -> stub: "Personal fork of open-gsd/gsd-pi at v1.18.0. Changes
  tracked in git history."
- Delete `CONTEXT.md`.
- Simplify `.npmignore` / `.npmrc` / `publishConfig` (nothing is published).
- Remove release-only scripts (`sync-pkg-version.cjs` and similar) if unused by
  the kept build.
- **Gate**, plus `gsd --version`.

### Stage 7 — Final sweep

- Regenerate the lockfile (`pnpm install`), `pnpm dedupe`.
- Full `pnpm run build`; `pnpm run test:unit`; `pnpm run test:integration`
  (best effort); `node --experimental-strip-types tests/smoke/run.ts`.
- Dangling-reference grep across `src/ packages/ scripts/ *.json`:
  `web-mode`, `cli-web-branch`, `mcp-server`, `gsd-browser`, `hermes`,
  `vscode-extension`, `cloud-mcp-gateway`, `remote-questions`, `cmux`, and each
  removed clean-leaf extension id (`voice`, `ttsr`, `google-search`, `aws-auth`,
  `google-cli`, `cursor-cli`, `context7`).
- Fix `tsconfig*.json` `references` / `paths`, `pnpm-workspace.yaml` comments,
  and `.gitattributes` entries that point at removed trees.

## Verification gate (every stage)

1. `pnpm run build:core` — clean.
2. `pnpm run typecheck:extensions` — clean.
3. `pnpm run test:unit` — no new failures versus the Stage 0 baseline.
4. `node scripts/dev-cli.js --help` exits 0; the TUI launches and reaches the
   input prompt.

A stage is not committed until its gate passes.

## Risks

- **Extension cross-references.** Extensions may be named in `src/cli.ts`,
  `src/tool-bootstrap.ts`, `src/resource-loader.ts`, or shared event contracts.
  The dangling-reference grep in Stage 7 (run opportunistically earlier too) is
  the backstop.
- **`packages/daemon` reach.** Described as monitoring + Discord, but confirm by
  grep before deleting; fall back to keeping it.
- **`gsd graph` removal.** Chosen deliberately; the codebase knowledge-graph
  feature goes away with `packages/mcp-server`.
- **Test globs.** Several `package.json` test scripts hardcode removed paths and
  will error if not updated in the same stage as the deletion.
- **`native` package.** Core to SQLite identity/state, not web. Keep; verify it
  is not pulled only by a removed surface.

## Open decision — package name

`package.json` `name` is currently `@opengsd/gsd-pi`. Options: unscoped
`gsd-pi`, a personal scope (e.g. `@mirogers/gsd`), or leave as-is. The `gsd`
binary name stays regardless. To be settled during Stage 6.
