# Strip GSD Pi to the CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce this personal hard fork of `gsd-pi` to the interactive `gsd` CLI, removing the web UI, VS Code extension, MCP server, daemon, cloud gateway, docs sites, Docker, the Python `hermes` integration, nine bundled extensions, and release/Discord CI.

**Architecture:** Staged, outside-in removal. Delete standalone top-level dirs first, then clean-leaf extensions, then the two entangled extensions with call-site surgery, then the web UI, then MCP/daemon, then identity cleanup, then a final sweep. Every task ends with a verification gate and a commit; every commit leaves a working `gsd`.

**Tech Stack:** pnpm workspace monorepo, TypeScript (ESM, `.js` import specifiers), Node's built-in test runner, `tsc` + esbuild builds, `node scripts/dev-cli.js` as the dev entrypoint.

**Spec:** `docs/superpowers/specs/2026-09-08-strip-to-cli-design.md`

## Global Constraints

- Node `>=22.18.0`; package manager `pnpm@10.12.1`. Do not change these.
- This is a hard fork. Upstream merge compatibility is a non-goal — deletion is safe.
- Remove, do not refactor. Kept code changes only where an import or call site points at removed code.
- Do **not** touch the `pi-ai` internal provider/model catalog.
- Do **not** touch headless / print mode (`src/headless*.ts`, `gsd -p`, `gsd quick`, `gsd auto`).
- Keep `browser-tools` and `visual-brief` extensions — kept `gsd`/`mac-tools` code imports them statically.
- Keep the `ttsr` native bindings in `packages/native`; only the `ttsr` TS extension is removed.
- ESM import specifiers end in `.js` even for `.ts` source. Match existing style.
- Commit messages end with:
  `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
- Work on branch `personal/strip-to-cli` (already created).

## Verification gate (run at the end of every task unless the task says otherwise)

1. `pnpm run build:core` — exits 0, no TypeScript errors.
2. `pnpm run typecheck:extensions` — exits 0.
3. `pnpm run test:unit` — no failures that were not already failing in the Task 1 baseline.
4. `node scripts/dev-cli.js --help` — exits 0.

If any gate step regresses, fix it within the same task before committing. A task is not "done" until its gate passes and its commit is made.

---

## Phase 0 — Baseline

### Task 1: Capture the pre-removal baseline

**Files:**
- Create: `docs/superpowers/plans/strip-to-cli-baseline.md` (scratch record; delete in Task 30)

- [ ] **Step 1: Confirm branch**

Run: `git branch --show-current`
Expected: `personal/strip-to-cli`. If not, `git checkout personal/strip-to-cli`.

- [ ] **Step 2: Clean install**

Run: `pnpm install`
Expected: completes without error.

- [ ] **Step 3: Baseline build**

Run: `pnpm run build:core`
Record: exit code and the tail of output into the baseline file.

- [ ] **Step 4: Baseline unit tests**

Run: `pnpm run test:unit 2>&1 | tee /tmp/strip-baseline-unit.txt`
Record into `strip-to-cli-baseline.md`: the final pass/fail counts and the names of any already-failing tests. These are the "known failures" the gate compares against.

- [ ] **Step 5: Baseline smoke**

Run: `node scripts/dev-cli.js --help`
Expected: exits 0, prints usage. Record any warnings.

- [ ] **Step 6: Commit the baseline record**

```bash
git add docs/superpowers/plans/strip-to-cli-baseline.md
git commit -m "chore: record pre-removal baseline for strip-to-cli

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Phase 1 — Standalone top-level directories

Nothing on the `gsd` runtime path imports these. Each task is a delete + reference cleanup + gate + commit.

### Task 2: Remove the VS Code extension

**Files:**
- Delete: `vscode-extension/`
- Modify: `pnpm-workspace.yaml` (only if it lists `vscode-extension`), `tsconfig*.json` (if any `references` entry points at it)

- [ ] **Step 1: Check for references**

Run: `grep -rn "vscode-extension" --include='*.json' --include='*.ts' --include='*.cjs' --include='*.mjs' --include='*.yaml' . | grep -v node_modules | grep -v "^\./vscode-extension/"`
Note every hit outside `vscode-extension/` itself.

- [ ] **Step 2: Delete the directory**

Run: `git rm -r vscode-extension`

- [ ] **Step 3: Remove references found in Step 1**

For each hit: delete the line if it is a list entry (workspace glob, tsconfig reference, lint path); if it is code, stop and report — the spec assumed no code references.

- [ ] **Step 4: Gate** (build:core, typecheck:extensions, test:unit, `--help`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove vscode-extension

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 3: Remove docs sites, Docker, and the orchestrator

**Files:**
- Delete: `gitbook/`, `mintlify-docs/`, `docker/`, `Dockerfile`, `.dockerignore`, `gsd-orchestrator/`, `screenshot-context-breakdown.jpg`
- Modify: `package.json` (`files[]`, any `docker`/`gitbook`/`mintlify` scripts), `.gitattributes`, `pnpm-workspace.yaml` (if `gsd-orchestrator` is a workspace member)

- [ ] **Step 1: Check membership and references**

Run: `grep -n "gsd-orchestrator\|gitbook\|mintlify\|docker" pnpm-workspace.yaml package.json .gitattributes`

- [ ] **Step 2: Delete**

```bash
git rm -r gitbook mintlify-docs docker Dockerfile .dockerignore gsd-orchestrator screenshot-context-breakdown.jpg
```

- [ ] **Step 3: Clean references**

Remove any `package.json` script whose command invokes `docker`, `gitbook`, or `mintlify`. Remove matching `.gitattributes` lines and any `pnpm-workspace.yaml` entry.

- [ ] **Step 4: Gate.**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove docs sites, Docker, and gsd-orchestrator

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 4: Remove the Hermes integration

**Files:**
- Delete: `integrations/hermes/`, `src/hermes-integration-install.ts`, `.github/workflows/hermes-integration.yml`
- Modify: `src/cli.ts` (the `hermes` subcommand branch + the `'hermes'` entry in `subcommandsExemptFromEarlyTtyCheck`), `package.json` (`files[]` entries `integrations/hermes/plugin.yaml` and `integrations/hermes`), `src/help-text.ts` (any `hermes` line)

- [ ] **Step 1: Find all Hermes references**

Run: `grep -rn "hermes\|Hermes" src package.json --include='*.ts' --include='*.json' | grep -vi "ephemeral\|theremin"`

- [ ] **Step 2: Delete files**

```bash
git rm -r integrations/hermes src/hermes-integration-install.ts .github/workflows/hermes-integration.yml
```

- [ ] **Step 3: Edit `src/cli.ts`**

Remove the `import` of `hermes-integration-install.js`, the `if (cliFlags.messages[0] === 'hermes') { … }` branch, and the string `'hermes'` from the `subcommandsExemptFromEarlyTtyCheck` set literal.

- [ ] **Step 4: Edit `package.json`**

Delete the two `files[]` array entries `"integrations/hermes/plugin.yaml"` and `"integrations/hermes"`.

- [ ] **Step 5: Edit `src/help-text.ts`**

Remove any line documenting `gsd hermes`.

- [ ] **Step 6: Re-grep**

Run the Step 1 grep again. Expected: no hits in `src/` or `package.json`.

- [ ] **Step 7: Gate.**

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: remove hermes integration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 5: Trim CI to a single build+test workflow

**Files:**
- Delete: every file in `.github/workflows/` except a new `ci.yml`
- Delete: `.github/dependabot.yml`, `.github/FUNDING.yml`
- Create: `.github/workflows/ci.yml`
- Keep: `.github/CODEOWNERS`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/` (harmless; optional to trim)

- [ ] **Step 1: Delete the workflow set**

```bash
cd .github/workflows
git rm agent-workflow-guard.yml ai-triage.yml build-native.yml ci.yml cleanup-dev-versions.yml codex-code-review.yml coverage-report.yml forensics-check.yml issue-dedupe.yml issue-lifecycle.yml npm-publish.yml pipeline.yml pr-risk.yml release-issue-upgrade-comments.yml release-readme-highlights.yml security-audit.yml update-model-catalog.yml version-check.yml
cd ../..
git rm .github/dependabot.yml .github/FUNDING.yml
```
(`hermes-integration.yml` and `release-discord-changelog.yml` are removed in Tasks 4 and 21; if either is still present, `git rm` it here.)

- [ ] **Step 2: Write the minimal CI**

Create `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main, "personal/**"]
  pull_request:
jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.12.1
      - uses: actions/setup-node@v4
        with:
          node-version: 22.18.0
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build:core
      - run: pnpm run typecheck:extensions
      - run: pnpm run test:unit
```

- [ ] **Step 3: Verify no workflow references a deleted workflow**

Run: `grep -rn "workflow_run\|uses: ./.github/workflows" .github/`
Expected: no reference to a now-deleted file.

- [ ] **Step 4: Gate** (CI does not affect the local gate; still run build:core + test:unit + `--help`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "ci: replace release/triage workflows with a minimal build+test CI

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Phase 2 — Clean-leaf extensions

Each of these seven extensions is referenced only by soft/optional code (onboarding hints, API-key catalogs, one readiness import). Remove the directory and the soft refs.

### Task 6: Remove the `voice` extension

**Files:**
- Delete: `src/resources/extensions/voice/`
- Modify: `src/onboarding.ts` (Groq `TOOL_KEYS` entry hint text), `src/resources/extensions/gsd/setup-catalog.ts:45`, `src/resources/extensions/gsd/commands/handlers/onboarding.ts:84`
- Modify: `package.json` test globs naming `voice`

- [ ] **Step 1: Grep**

Run: `grep -rn "extensions/voice\|'voice'\|\"voice\"\| voice " src packages --include='*.ts' --include='*.json' | grep -v node_modules`

- [ ] **Step 2: Delete the directory**

Run: `git rm -r src/resources/extensions/voice`

- [ ] **Step 3: Edit `package.json`**

In the `test:unit:compiled` script string, delete the glob segment
`"dist-test/src/resources/extensions/voice/tests/*.test.js"` (and its leading space). Do the same in any other `test:*` script that names `voice`.

- [ ] **Step 4: Soft-ref copy edits**

- `src/onboarding.ts`: the Groq `TOOL_KEYS` entry stays (Groq is also a model provider) but change its `hint` from `'voice transcription — free at console.groq.com'` to `'fast inference — free at console.groq.com'`.
- `src/resources/extensions/gsd/setup-catalog.ts:45`: change hint `"Context7, Jina, Groq voice, etc."` → `"Jina, Groq, etc."` (Context7 also removed in Task 12; safe to drop both now).
- `src/resources/extensions/gsd/commands/handlers/onboarding.ts:84`: same substring edit.

- [ ] **Step 5: Gate.**

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove voice extension

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 7: Remove the `ttsr` TS extension (keep native bindings)

**Files:**
- Delete: `src/resources/extensions/ttsr/`
- Keep untouched: `packages/native/**` (`ttsrCompileRules` etc.), `src/resources/extensions/gsd/debug-logger.ts` (its `ttsr*` counters are cheap and read by the debug summary — leaving them costs nothing and avoids touching the debug schema)
- Modify: `package.json` test globs naming `ttsr`

- [ ] **Step 1: Grep**

Run: `grep -rn "extensions/ttsr\|from \"\.\./ttsr\|from '\.\./ttsr" src --include='*.ts'`
Expected: hits only inside `src/resources/extensions/ttsr/` and `.../gsd/tests/` (if any).

- [ ] **Step 2: Confirm no kept runtime code imports the extension**

Run: `grep -rn "ttsr/index\|ttsr/manager\|extensions/ttsr" src --include='*.ts' | grep -v "extensions/ttsr/"`
Expected: no hits. If a hit exists in `gsd/bootstrap/*`, remove that import and its registration line, then note it in the commit body.

- [ ] **Step 3: Delete**

Run: `git rm -r src/resources/extensions/ttsr`

- [ ] **Step 4: Edit `package.json`** — drop any `ttsr` test glob.

- [ ] **Step 5: Gate.**

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove ttsr TS extension (native bindings retained)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 8: Remove the `google-search` extension

**Files:**
- Delete: `src/resources/extensions/google-search/`
- Modify: `scripts/lib/version-sync.cjs:7` (remove the `"extensions/google-search"` list entry)
- Modify: `package.json` test globs naming `google-search`

- [ ] **Step 1: Grep**

Run: `grep -rn "google-search" src scripts packages --include='*.ts' --include='*.cjs' --include='*.json' | grep -v node_modules`

- [ ] **Step 2: Delete**

Run: `git rm -r src/resources/extensions/google-search`

- [ ] **Step 3: Edit `scripts/lib/version-sync.cjs`** — delete the `"extensions/google-search",` array element.

- [ ] **Step 4: Edit `package.json`** — drop any `google-search` test glob.

- [ ] **Step 5: Gate.**

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove google-search extension

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 9: Remove the `aws-auth` extension

**Files:**
- Delete: `src/resources/extensions/aws-auth/`
- Modify: `package.json` test globs naming `aws-auth` (if any)

- [ ] **Step 1: Grep**

Run: `grep -rn "aws-auth\|awsAuth" src packages --include='*.ts' --include='*.json' | grep -v node_modules`
Expected: hits only inside `src/resources/extensions/aws-auth/`.

- [ ] **Step 2: Delete**

Run: `git rm -r src/resources/extensions/aws-auth`

- [ ] **Step 3: Edit `package.json`** — drop any `aws-auth` test glob.

- [ ] **Step 4: Gate.**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove aws-auth extension

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 10: Remove the `google-cli` extension

**Files:**
- Delete: `src/resources/extensions/google-cli/`
- Modify: `src/resources/extensions/gsd/preferences-models.ts:52` (comment only — drop `google-cli` from the parenthetical), any provider-list constant that names `google-cli`
- Modify: `package.json` test globs naming `google-cli`

- [ ] **Step 1: Grep**

Run: `grep -rn "google-cli\|googleCli\|gemini-cli" src packages --include='*.ts' --include='*.json' | grep -v node_modules`

- [ ] **Step 2: Delete**

Run: `git rm -r src/resources/extensions/google-cli`

- [ ] **Step 3: Handle non-comment hits**

If any kept file (e.g. `gsd/preferences-models.ts`, `gsd/doctor-providers.ts`, a provider registry) has a runtime reference to the `google-cli` provider id, remove that entry/branch. Comments: edit to drop the name.

- [ ] **Step 4: Edit `package.json`** — drop any `google-cli` test glob.

- [ ] **Step 5: Gate.**

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove google-cli provider extension

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 11: Remove the `cursor-cli` extension

**Files:**
- Delete: `src/resources/extensions/cursor-cli/`
- Modify: `src/resources/extensions/gsd/doctor-providers.ts:20` (remove `import { isCursorAgentReadyUncached } from "../cursor-cli/readiness.js"` and its use), `src/resources/extensions/gsd/preferences-models.ts:52` (comment)
- Modify: `package.json` test globs — remove `dist-test/src/resources/extensions/cursor-cli/tests/*.test.js`

- [ ] **Step 1: Grep**

Run: `grep -rn "cursor-cli\|cursorCli\|isCursorAgentReady\|cursor-agent" src packages --include='*.ts' --include='*.json' | grep -v node_modules`

- [ ] **Step 2: Delete**

Run: `git rm -r src/resources/extensions/cursor-cli`

- [ ] **Step 3: Edit `gsd/doctor-providers.ts`**

Remove the `isCursorAgentReadyUncached` import. Find where it is called (a provider-readiness check, likely a `cursor` case in a switch or a map entry) and remove that case/entry so `gsd doctor` no longer probes Cursor.

- [ ] **Step 4: Edit `gsd/preferences-models.ts:52`** — drop `cursor-cli` from the comment's parenthetical list.

- [ ] **Step 5: Edit `package.json`** — remove the `cursor-cli` test glob segment.

- [ ] **Step 6: Gate.**

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove cursor-cli provider extension

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 12: Remove the `context7` extension

**Files:**
- Delete: `src/resources/extensions/context7/`
- Modify: `src/wizard.ts:26` (drop `['context7', 'CONTEXT7_API_KEY']`), `src/onboarding.ts:69-74` (drop the `context7` `TOOL_KEYS` entry), `src/resources/extensions/gsd/doctor-providers.ts:543` (drop `"context7"` from the `optional` tuple), `src/resources/extensions/gsd/commands-config.ts:21`, `src/resources/extensions/gsd/key-manager.ts:67`
- Modify: `package.json` test globs naming `context7`

- [ ] **Step 1: Grep**

Run: `grep -rn "context7\|CONTEXT7_API_KEY\|Context7" src packages --include='*.ts' --include='*.json' | grep -v node_modules | grep -v "packages/mcp-server"`
(`packages/mcp-server` is deleted whole in Task 18 — ignore its hits.)

- [ ] **Step 2: Delete**

Run: `git rm -r src/resources/extensions/context7`

- [ ] **Step 3: Remove each catalog entry**

- `src/wizard.ts`: delete the `['context7', 'CONTEXT7_API_KEY'],` tuple.
- `src/onboarding.ts`: delete the `{ provider: 'context7', envVar: 'CONTEXT7_API_KEY', label: 'Context7', hint: 'up-to-date library docs' },` object from `TOOL_KEYS`.
- `gsd/doctor-providers.ts:543`: change `["brave", "tavily", "jina", "context7"]` → `["brave", "tavily", "jina"]`.
- `gsd/commands-config.ts:21` and `gsd/key-manager.ts:67`: delete the `context7` row from each array literal.

- [ ] **Step 4: Edit `package.json`** — drop any `context7` test glob.

- [ ] **Step 5: Re-grep** (Step 1 command). Expected: no hits outside `packages/mcp-server`.

- [ ] **Step 6: Gate.**

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove context7 extension and its key-catalog entries

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Phase 3 — `remote-questions` full surgery

`remote-questions` provides remote answering of `ask_user_questions` and auto-mode commands over Telegram/Slack/Discord. Removing it means deleting the extension **and** every call site in kept code, then collapsing the "race remote vs local" paths to local-only.

### Task 13: Delete the extension and the shared config shim

**Files:**
- Delete: `src/resources/extensions/remote-questions/`, `src/remote-questions-config.ts`
- Do **not** gate yet — this task intentionally leaves the tree non-compiling; Tasks 14–17 fix the call sites. Commit only after Task 17.

- [ ] **Step 1: Inventory call sites** (record the list for Tasks 14–17)

Run: `grep -rn "remote-questions\|remote-questions-config\|RemoteQuestions\|isRemoteConfigured\|tryRemoteQuestions\|saveRemoteQuestionsConfig\|sendRemoteNotification\|handleRemote\|resolveRemoteConfig\|startCommandPolling" src --include='*.ts' | grep -v "src/resources/extensions/remote-questions/"`

- [ ] **Step 2: Delete**

```bash
git rm -r src/resources/extensions/remote-questions src/remote-questions-config.ts
```

- [ ] **Step 3: Delete the dedicated tests**

```bash
git rm src/resources/extensions/gsd/tests/remote-questions.test.ts \
       src/resources/extensions/gsd/tests/remote-status.test.ts \
       src/resources/extensions/gsd/tests/remote-notification-from-desktop.test.ts \
       src/resources/extensions/gsd/tests/auto-remote-session-lock-cleanup.test.ts \
       src/resources/extensions/gsd/tests/discord-invite-links.test.ts
```
(If any path does not exist, skip it.)

Proceed directly to Task 14.

### Task 14: Cut remote command polling out of `gsd/auto.ts`

**Files:**
- Modify: `src/resources/extensions/gsd/auto.ts`

**Interfaces:**
- Removes: `startAutoCommandPolling`, `stopAutoCommandPolling` (module-private in `auto.ts` — verify with grep they are not exported/imported elsewhere).

- [ ] **Step 1: Remove the import**

Delete line ~192:
```ts
import { startCommandPolling as _startCommandPolling, isRemoteConfigured } from "../remote-questions/manager.js";
```

- [ ] **Step 2: Remove the wrapper functions**

Delete the `startAutoCommandPolling` function (the `if (!isRemoteConfigured()) return; … s.commandPollingCleanup = _startCommandPolling(basePath);` body, ~lines 843–855) and the `stopAutoCommandPolling` function immediately after it.

- [ ] **Step 3: Remove the call sites**

Run: `grep -n "startAutoCommandPolling\|stopAutoCommandPolling\|commandPollingCleanup" src/resources/extensions/gsd/auto.ts`
Delete each call line. For `s.commandPollingCleanup`: remove the field usage; if `commandPollingCleanup` is declared on the session state type, remove that field declaration too (grep the state type file it points to).

- [ ] **Step 4: Local check**

Run: `pnpm exec tsc --noEmit -p tsconfig.extensions.json 2>&1 | grep -i "auto.ts" | head`
Expected: no errors mentioning remote/polling symbols (other files may still error until Tasks 15–17).

### Task 15: Neutralize remote notifications in `gsd/notifications.ts`

**Files:**
- Modify: `src/resources/extensions/gsd/notifications.ts`

- [ ] **Step 1: Inspect**

Read `src/resources/extensions/gsd/notifications.ts` around lines 1–60. The `remoteNotificationDispatcher` wraps `sendRemoteNotification`; its `.send()` is called fire-and-forget at ~line 54.

- [ ] **Step 2: Remove the import and dispatcher**

Delete line 9 (`import { sendRemoteNotification as _sendRemoteNotification } …`) and the `remoteNotificationDispatcher` object (lines ~12–14).

- [ ] **Step 3: Remove the caller**

Delete the `void remoteNotificationDispatcher.send(title, message).catch(() => {});` line (~54) and the now-stale comment above it (~53). If that leaves an empty function body or unused params, keep the function signature and leave a single-line comment `// local desktop notification only` where the call was, matching how the rest of the file reads.

- [ ] **Step 4: Gate deferred to Task 17.**

### Task 16: Remove the `/remote` command and welcome-screen channel line

**Files:**
- Modify: `src/resources/extensions/gsd/commands/handlers/ops.ts`, `src/resources/extensions/gsd/bootstrap/register-hooks.ts`

- [ ] **Step 1: `ops.ts`**

Delete the import at line 16 (`import { handleRemote } from "../../../remote-questions/mod.js";`) and the branch at ~lines 258–260:
```ts
if (trimmed === "remote" || trimmed.startsWith("remote ")) {
  await handleRemote(trimmed.replace(/^remote\s*/, "").trim(), ctx, pi);
  ...
}
```
Remove the whole `if` block (read a few lines past 260 to catch its `return`/closing brace).

- [ ] **Step 2: Grep for a command-catalog registration of `remote`**

Run: `grep -rn "\"remote\"\|'remote'\|/remote" src/resources/extensions/gsd/commands --include='*.ts'`
Remove any catalog entry that registers the `remote` slash command / help text.

- [ ] **Step 3: `register-hooks.ts`**

Around lines 160–176: delete the `let remoteChannel …`, the `const { resolveRemoteConfig } = await import("../../remote-questions/config.js")` block, and the `remoteChannel` property passed into `buildWelcomeScreenLines(...)`. Then update the `buildWelcomeScreenLines` interface at line ~124 to drop the optional `remoteChannel?: string` param, and its implementation to stop rendering that line.

- [ ] **Step 4: Gate deferred to Task 17.**

### Task 17: Collapse remote routing in `ask-user-questions.ts` and onboarding

**Files:**
- Modify: `src/resources/extensions/ask-user-questions.ts`, `src/onboarding.ts`
- Test: `src/resources/extensions/gsd/tests/register-hooks-depth-verification.test.ts` (drop remote assertions)

- [ ] **Step 1: `ask-user-questions.ts`**

At ~line 322 remove:
```ts
const { tryRemoteQuestions, isRemoteConfigured } = await import("./remote-questions/manager.js");
const hasRemote = isRemoteConfigured();
```
Replace `hasRemote` with `false` everywhere it is used below, then simplify: delete the "Case 1: Both remote and local" race block and the "remote-only" case entirely, keeping only the local-UI path. The bell (`playQuestionBell()`) should now fire on `ctx.hasUI` alone. Read from line 320 to the end of the routing block (~line 420) and rewrite it to the local-only shape.

- [ ] **Step 2: `onboarding.ts`**

Run: `grep -n "saveRemoteQuestionsConfig\|remote-questions-config\|Slack channel\|Telegram bot\|Discord channel" src/onboarding.ts`
Remove the three `const { saveRemoteQuestionsConfig } = await import('./remote-questions-config.js')` sites (~1037, 1106, 1219) together with the surrounding prompt blocks that collect Slack/Telegram/Discord channel IDs and call `saveRemoteQuestionsConfig(...)`. If those blocks sit inside a "set up remote notifications?" menu, remove that menu option and any now-unreachable helper. Do not remove unrelated onboarding steps.

- [ ] **Step 3: Fix the depth-verification test**

In `register-hooks-depth-verification.test.ts` remove the import `toRoundResultResponse` from `../../remote-questions/manager.ts` and any assertion block that exercises remote round-result handling. If the whole test file is remote-specific, `git rm` it.

- [ ] **Step 4: Full grep**

Run: `grep -rn "remote-questions\|isRemoteConfigured\|saveRemoteQuestionsConfig\|tryRemoteQuestions\|handleRemote\|sendRemoteNotification\|resolveRemoteConfig" src --include='*.ts'`
Expected: **zero hits**.

- [ ] **Step 5: Prune `discord.js`**

Run: `grep -rn "discord" package.json packages/*/package.json --include='*.json'`
If `discord.js` in root `package.json` is now referenced only by the (soon-removed) daemon, leave it for Task 19; if nothing references it, remove it from `dependencies` here.

- [ ] **Step 6: Gate** (full gate — build:core, typecheck:extensions, test:unit, `--help`). Also run:
`node scripts/dev-cli.js auto --help` — expected exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove remote-questions extension and all call sites

Deletes Telegram/Slack/Discord remote answering. ask_user_questions and
auto-mode command handling are now local-only.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Phase 4 — `cmux` full surgery

`cmux` mirrors auto-mode state to an external `cmux` terminal multiplexer via `pi.events` channels. Removing it means deleting the extension, the shared event contract, the `commands-cmux.ts` helper, and every `CMUX_CHANNELS` emit in `auto.ts`.

### Task 18: Delete the cmux extension, shared contract, and helper

**Files:**
- Delete: `src/resources/extensions/cmux/`, `src/resources/extensions/shared/cmux-events.ts`, `src/resources/extensions/gsd/commands-cmux.ts`
- Test: `git rm src/resources/extensions/gsd/tests/cmux.test.ts`
- Do **not** gate until Task 20.

- [ ] **Step 1: Inventory**

Run: `grep -rn "cmux\|Cmux\|CMUX" src --include='*.ts' | grep -v "src/resources/extensions/cmux/"`
Record every hit for Tasks 19–20.

- [ ] **Step 2: Delete**

```bash
git rm -r src/resources/extensions/cmux \
         src/resources/extensions/shared/cmux-events.ts \
         src/resources/extensions/gsd/commands-cmux.ts \
         src/resources/extensions/gsd/tests/cmux.test.ts
```

Proceed to Task 19.

### Task 19: Remove cmux wiring from gsd bootstrap and commands

**Files:**
- Modify: `src/resources/extensions/gsd/bootstrap/register-extension.ts`, `src/resources/extensions/gsd/bootstrap/system-context.ts`, `src/resources/extensions/gsd/commands/handlers/core.ts`
- Modify: the GSD preferences type/schema file if it declares a `cmux` field

- [ ] **Step 1: `register-extension.ts`**

Delete the `import { initCmuxEventListeners } from "../../cmux/index.js";` line (~28) and its explanatory comment (~22–27), and the `["cmux-events", () => initCmuxEventListeners(pi.events)],` entry (~238) from the listener-registration array. If removing that element empties the array, keep the array literal `[]` and leave the surrounding loop intact.

- [ ] **Step 2: `system-context.ts`**

Delete `import { autoEnableCmuxPreferences } from "../commands-cmux.js";` (~24) and the call to `autoEnableCmuxPreferences(...)` (grep the file). Remove any log line that reported "cmux preferences written".

- [ ] **Step 3: `commands/handlers/core.ts`**

Delete `import { handleCmux } from "../../commands-cmux.js";` (~13), the `getVisualBriefOutputDir`/`visual-brief` imports stay (kept). Remove the `cmux` command branch that calls `handleCmux`. Grep the commands catalog (`commands/catalog.ts`) for a `cmux` registration and remove it.

- [ ] **Step 4: Preferences schema**

Run: `grep -rn "cmux" src/resources/extensions/gsd/preferences*.ts src/resources/extensions/gsd/*preferences* --include='*.ts'`
If a `cmux?: { enabled: boolean; … }` field is declared on the preferences interface / zod schema, remove it. Leave existing user `.gsd/preferences.md` files alone (an unknown key is ignored at read time).

- [ ] **Step 5: Gate deferred to Task 20.**

### Task 20: Strip `CMUX_CHANNELS` emissions from `gsd/auto.ts`

**Files:**
- Modify: `src/resources/extensions/gsd/auto.ts`
- Modify: the `LoopDeps` type definition (grep for `interface LoopDeps` / `type LoopDeps`)

**Interfaces:**
- Removes from `LoopDeps`: `syncCmuxSidebar`, `logCmuxEvent`, `clearCmuxSidebar`.

- [ ] **Step 1: Remove the import**

Delete line ~244: `import { CMUX_CHANNELS, type CmuxLogLevel } from "../shared/cmux-events.js";`

- [ ] **Step 2: Remove `makeCmuxEmitters`**

Delete the whole `function makeCmuxEmitters(pi: ExtensionAPI) { … }` (~lines 255–264).

- [ ] **Step 3: Remove the LoopDeps wiring**

- Delete `const cmux = makeCmuxEmitters(pi);` (~2477).
- Delete the `...cmux,` spread in the `LoopDeps` object literal (~2488).
- In `handleLostSessionLock` (~2490) delete the `cmux.clearCmuxSidebar(...)` line, keeping the `handleLostSessionLock(ctx, lockStatus)` call.
- In the `LoopDeps` interface/type, delete the `syncCmuxSidebar` / `logCmuxEvent` / `clearCmuxSidebar` members. Then grep consumers: `grep -rn "syncCmuxSidebar\|logCmuxEvent\|clearCmuxSidebar" src --include='*.ts'` and delete any remaining call.

- [ ] **Step 4: Remove the bare `pi.events.emit(CMUX_CHANNELS.…)` sites**

Run: `grep -n "CMUX_CHANNELS" src/resources/extensions/gsd/auto.ts`
For each remaining hit (~2063, 2064, 3046, 3088, 3165, 3170): delete the `pi.events.emit(CMUX_CHANNELS.SIDEBAR, …)` / `CMUX_CHANNELS.LOG` statement. Where the emit is the sole body of a `try { … } catch { debugLog("…-cmux", …) }`, delete the whole try/catch. Where it sits among other statements, delete just the emit statement.

- [ ] **Step 5: Confirm clean**

Run: `grep -rn "CMUX\|cmux\|Cmux" src --include='*.ts'`
Expected: **zero hits**.

- [ ] **Step 6: Gate** (full). Also:
`node scripts/dev-cli.js auto --help` → exit 0.
Manually launch `node scripts/dev-cli.js` in a repo with a `.gsd/`, start auto mode far enough to confirm no `CMUX` ReferenceError; Ctrl-C out.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove cmux integration and all auto-mode event emissions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Phase 5 — Web UI

### Task 21: Remove release/Discord readme automation and daemon test script

**Files:**
- Delete: `.github/workflows/release-discord-changelog.yml` (if still present)
- Modify: `README.md` (remove the `<!-- release-highlights:start -->…<!-- release-highlights:end -->` block and the "Latest Release Highlights" heading), `package.json` (`release:update-readme-highlights`, `test:daemon` scripts), `scripts/` (delete the readme-highlights generator if one exists, e.g. `scripts/release/*readme*`, `scripts/*highlights*`)

- [ ] **Step 1: Grep for the highlights tooling**

Run: `grep -rln "release-highlights\|readme-highlights\|release:update-readme" scripts package.json .github`

- [ ] **Step 2: Delete generator script(s) and workflow**

`git rm` each script file found, plus `.github/workflows/release-discord-changelog.yml` if present.

- [ ] **Step 3: Edit `README.md`**

Remove the `## Latest Release Highlights` section including the HTML comment markers and the bullet list between them.

- [ ] **Step 4: Edit `package.json`**

Delete the `release:update-readme-highlights` and `test:daemon` script entries.

- [ ] **Step 5: Gate** (build:core, test:unit, `--help`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove readme release-highlights automation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 22: Delete the web workspace package and web source

**Files:**
- Delete: `web/`, `src/web/`
- Modify: `pnpm-workspace.yaml` (remove the `- 'web'` entry)
- Do **not** gate until Task 24 (imports in `cli.ts` still reference web modules).

- [ ] **Step 1: Confirm the web package name**

Run: `node -e "console.log(require('./web/package.json').name)"`
Record it (e.g. `gsd-web`) for the Task 24 dependency grep.

- [ ] **Step 2: Delete**

```bash
git rm -r web src/web
```

- [ ] **Step 3: `pnpm-workspace.yaml`**

Delete the `  - 'web'` line under `packages:`.

Proceed to Task 23.

### Task 23: Remove web build scripts and package.json wiring

**Files:**
- Delete: `scripts/build-web-if-stale.cjs`, `scripts/stage-web-standalone.cjs`, `scripts/copy-export-html.cjs` (verify it is web-only first)
- Modify: `package.json` scripts

- [ ] **Step 1: Check `copy-export-html` usage**

Run: `grep -rn "copy-export-html\|export-html\|export.html" src scripts --include='*.ts' --include='*.cjs' | grep -v node_modules`
If it only stages files for the web host, delete it. If `src/` runtime code reads an exported HTML template, keep the script and its `copy-export-html` call in `build:core`.

- [ ] **Step 2: Delete web scripts**

```bash
git rm scripts/build-web-if-stale.cjs scripts/stage-web-standalone.cjs
```
(plus `scripts/copy-export-html.cjs` if Step 1 cleared it — and then also remove `copy-export-html` from the `build:core` script string.)

- [ ] **Step 3: Edit `package.json` scripts**

- Delete: `stage:web-host`, `build:web-host`, `gsd:web`, `gsd:web:stop`, `gsd:web:stop:all`.
- Change `"build": "pnpm run build:core && node scripts/build-web-if-stale.cjs"` to `"build": "pnpm run build:core"`.
- Grep the remaining scripts for `web` and remove any leftover reference.

- [ ] **Step 4: Gate deferred to Task 24.**

### Task 24: Remove the `--web` / `web` branch from `src/cli.ts` and helpers

**Files:**
- Delete: `src/web-mode.ts`, `src/cli-web-branch.ts`
- Modify: `src/cli.ts`, `src/help-text.ts`, `src/onboarding.ts`, `src/welcome-screen.ts`, `src/rtk.ts` / `src/rtk-shared.ts` (only if they reference web)

**Interfaces:**
- `parseCliArgs`, `buildHeadlessCommandArgs`, `migrateLegacyFlatSessions` are imported from `./cli-web-branch.js` today. Before deleting that file, confirm whether those three are web-specific or general. Run: `grep -n "parseCliArgs\|buildHeadlessCommandArgs\|migrateLegacyFlatSessions" src/cli-web-branch.ts src/cli.ts`.
  - If `parseCliArgs` / `buildHeadlessCommandArgs` / `migrateLegacyFlatSessions` are defined in `cli-web-branch.ts` but used by non-web paths (headless, sessions), **move** them to a new `src/cli-args.ts` instead of deleting them with the file.

- [ ] **Step 1: Triage the shared exports**

Read `src/cli-web-branch.ts`. Classify each export as web-only (`runWebCliBranch`, anything touching `web-mode`) or general (`parseCliArgs`, `buildHeadlessCommandArgs`, `migrateLegacyFlatSessions` — likely general).

- [ ] **Step 2: Relocate general helpers**

Create `src/cli-args.ts` and move the general helpers there verbatim (with their imports). Export them from the new file.

- [ ] **Step 3: Rewrite the `cli.ts` import block (lines ~25–31)**

From:
```ts
import {
  buildHeadlessCommandArgs,
  parseCliArgs,
  runWebCliBranch,
  migrateLegacyFlatSessions,
} from './cli-web-branch.js'
import { stopWebMode } from './web-mode.js'
```
To:
```ts
import {
  buildHeadlessCommandArgs,
  parseCliArgs,
  migrateLegacyFlatSessions,
} from './cli-args.js'
```

- [ ] **Step 4: Delete the web files**

```bash
git rm src/web-mode.ts src/cli-web-branch.ts
```

- [ ] **Step 5: Remove the `web` subcommand branches in `cli.ts`**

- Delete the `// gsd web stop [path|all]` block (`if (cliFlags.messages[0] === 'web' && cliFlags.messages[1] === 'stop') { … }`, ~lines 459–471).
- Delete the `// gsd --web [path] or gsd web …` block (`if (cliFlags.web || (cliFlags.messages[0] === 'web' && …)) { … }`, ~lines 472–483).
- In `subcommandsExemptFromEarlyTtyCheck` set literal, delete the `'web'` element (~line 398).
- In the early TTY guard `if (!process.stdin.isTTY && … && !cliFlags.web) {` (~line 403) drop the `&& !cliFlags.web` clause.
- In `printNonTtyErrorAndExit`, delete the two `if (includeWebHint) { … --web … }` blocks and the `includeWebHint` parameter; update the one caller that passed `true`/`false` (grep `printNonTtyErrorAndExit(`).

- [ ] **Step 6: Remove `--web` from arg parsing**

In `src/cli-args.ts` (moved `parseCliArgs`) and any `CliFlags` type: remove the `web` boolean flag, its `--web` case, and the `web` field on the flags type. Grep `cliFlags.web` across `src/` — expected zero after this step.

- [ ] **Step 7: Copy edits**

- `src/help-text.ts`: delete every line documenting `gsd --web` / `gsd web`.
- `src/onboarding.ts`, `src/welcome-screen.ts`: delete lines that advertise web mode.

- [ ] **Step 8: Full grep**

Run: `grep -rn "web-mode\|cli-web-branch\|runWebCliBranch\|stopWebMode\|--web\|cliFlags.web" src --include='*.ts'`
Expected: **zero hits**.

- [ ] **Step 9: Gate** (full). Also run `node scripts/dev-cli.js --help` and confirm no `--web` line and no crash. Launch the TUI to the prompt and exit.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: remove web UI (web/ package, src/web, --web branch)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 25: Drop web-only dependencies

**Files:**
- Modify: `package.json` (`dependencies` / `devDependencies`), `pnpm-lock.yaml`

- [ ] **Step 1: Identify orphans**

Run: `pnpm dedupe --check` then, for each suspected web dep (anything React/Vite/Tailwind/`@opengsd/rpc-client` consumers unique to web), `grep -rn "<dep-name>" src packages --include='*.ts'`.
`@opengsd/rpc-client` is also used by the TUI RPC child — **keep it**. Only remove deps with zero remaining `src/` or kept-package references.

- [ ] **Step 2: Remove and relock**

Edit `package.json` to delete the orphaned entries, then `pnpm install`.

- [ ] **Step 3: Gate** (full).

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: drop web-only dependencies

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Phase 6 — MCP server, cloud gateway, daemon, `gsd graph`

### Task 26: Remove `gsd graph` and the MCP-mode server from `cli.ts`

**Files:**
- Delete: `src/mcp-server.ts`, `src/mcp-mode-tools.ts`
- Modify: `src/cli.ts`, `src/help-text.ts`

- [ ] **Step 1: Remove the graph subcommand**

In `src/cli.ts` delete the entire `// Graph subcommand` block: `if (cliFlags.messages[0] === 'graph') { … }` (starts ~line 277, ends at its closing brace — read forward to find it; it includes the `await import('@opengsd/mcp-server')` and `openExistingWorkflowDatabase` usage). Remove `'graph'` from the `subcommandsExemptFromEarlyTtyCheck` set literal (~line 387).

- [ ] **Step 2: Remove the MCP mode branch**

Delete the `if (mode === 'mcp') { … }` block (~lines 833–860) including the `await import('./mcp-server.js')` and `await import('./mcp-mode-tools.js')` lines and the `startMcpServer(...)` call and its trailing `await new Promise(() => {})`.

- [ ] **Step 3: Handle the `mode` type**

Grep `'mcp'` in `src/cli.ts` and the `--mode` parser. Remove `mcp` from the allowed `--mode` values / union type. Update `printNonTtyErrorAndExit` to drop the `gsd --mode mcp` line.

- [ ] **Step 4: Delete the files**

```bash
git rm src/mcp-server.ts src/mcp-mode-tools.ts
```

- [ ] **Step 5: Check `register-agent-bundles.ts` / `tool-bootstrap.ts`**

Run: `grep -n "mcp-mode-tools\|mcp-server\|buildMcpModeTools\|startMcpServer" src/*.ts`
Remove any remaining import/registration.

- [ ] **Step 6: `help-text.ts`** — remove `gsd graph …` and `gsd --mode mcp` documentation.

- [ ] **Step 7: Gate** (full). `node scripts/dev-cli.js graph` → expected: unknown-command handling, not a crash.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: remove gsd graph subcommand and MCP server mode

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 27: Delete `packages/mcp-server` and `packages/cloud-mcp-gateway`

**Files:**
- Delete: `packages/mcp-server/`, `packages/cloud-mcp-gateway/`
- Modify: `package.json` (`bin.gsd-mcp-server`, `build:mcp-server` script, `build:core` chain, `files[]` if it names these), `pnpm-lock.yaml`

- [ ] **Step 1: Confirm no kept import**

Run: `grep -rn "@opengsd/mcp-server\|@opengsd/cloud-mcp-gateway\|cloud-mcp-gateway" src packages --include='*.ts' --include='*.json' | grep -v "packages/mcp-server/" | grep -v "packages/cloud-mcp-gateway/"`
Expected: **zero hits** (Task 26 removed the last `src/` import). If a kept package still imports mcp-server, stop and report.

- [ ] **Step 2: Delete**

```bash
git rm -r packages/mcp-server packages/cloud-mcp-gateway
```

- [ ] **Step 3: Edit `package.json`**

- Delete `"gsd-mcp-server": "packages/mcp-server/bin/gsd-mcp-server.js"` from `bin`.
- Delete the `build:mcp-server` script.
- In `build:core`, remove the `&& pnpm run build:mcp-server` segment.
- Remove `mcp-server` / `cloud-mcp-gateway` from `files[]` if present.

- [ ] **Step 4: Relock**

Run: `pnpm install`

- [ ] **Step 5: Gate** (full).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove mcp-server and cloud-mcp-gateway packages

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 28: Remove `packages/daemon` if unreferenced by the CLI

**Files:**
- Delete (conditional): `packages/daemon/`
- Modify: `package.json` (`build:daemon` script, `build:core` chain), `pnpm-lock.yaml`, `pnpm-workspace.yaml` comments

- [ ] **Step 1: Reference check**

Run: `grep -rn "@opengsd/daemon\|gsd-daemon\|packages/daemon" src packages --include='*.ts' --include='*.json' | grep -v "packages/daemon/"`

- [ ] **Step 2: Decide**

- **Zero hits** → proceed to delete.
- **Hits only in `packages/cloud-mcp-gateway`** → already deleted in Task 27; treat as zero, proceed.
- **Hits in a kept package or `src/`** → do NOT delete. Record the reference in the commit body and skip Steps 3–5 (just remove the `build:daemon` script and `test:daemon` if still present).

- [ ] **Step 3: Delete**

```bash
git rm -r packages/daemon
```

- [ ] **Step 4: Edit `package.json`** — delete `build:daemon` and remove `&& pnpm run build:daemon` from `build:core`; delete `test:daemon` if not already gone.

- [ ] **Step 5: Relock** — `pnpm install`.

- [ ] **Step 6: Prune `discord.js`**

Run: `grep -rn "discord" package.json packages/*/package.json`
If no hits remain, remove `discord.js` from root `dependencies` and re-run `pnpm install`. Also drop the `discord.js>undici` and `@discordjs/rest>undici` entries from the `overrides` block in `pnpm-workspace.yaml` and their explanatory comment.

- [ ] **Step 7: Gate** (full).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: remove daemon package (Discord/monitoring, unused by CLI)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 29: Update `.mcp.json` and remaining MCP references

**Files:**
- Modify or delete: `.mcp.json`
- Modify: `CONTEXT.md` is deleted in Task 31 — ignore it here

- [ ] **Step 1: Inspect `.mcp.json`**

Read `.mcp.json`. It configures MCP servers the agent connects to *as a client* (kept `mcp-client` extension). If it lists the now-removed `gsd-mcp-server` as an entry, delete that entry. If the file only existed to register gsd's own server, `git rm .mcp.json`.

- [ ] **Step 2: Grep leftovers**

Run: `grep -rn "gsd-mcp-server\|mcp-server" . --include='*.json' --include='*.md' | grep -v node_modules | grep -v pnpm-lock`
Fix or note each.

- [ ] **Step 3: Gate** (build:core, test:unit, `--help`).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: drop gsd's own MCP server from .mcp.json

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Phase 7 — Identity and final sweep

### Task 30: Rewrite README and package identity

**Files:**
- Modify: `README.md`, `package.json`, `.npmrc`, `.npmignore`
- Delete: `docs/superpowers/plans/strip-to-cli-baseline.md`

**Decision (settled):** package `name` → unscoped **`gsd-pi`**.

- [ ] **Step 1: `package.json` metadata**

- `name`: `gsd-pi` (unscoped).
- `repository.url`: `git+https://github.com/eagle27272/gsd-pi.git`
- `homepage`: `https://github.com/eagle27272/gsd-pi#readme`
- `bugs.url`: `https://github.com/eagle27272/gsd-pi/issues`
- `publishConfig`: delete the `provenance: true` line (keep `access` if you still want `pnpm pack` sane, or delete the whole block — nothing publishes).
- Leave `version`, `bin.gsd`, `bin.gsd-cli`, `engines`, `packageManager` unchanged.

- [ ] **Step 2: Rewrite `README.md`**

Replace the badge block, the npm install instructions, the "Migrate From Older Installs" section, and the upstream-status paragraph with a short personal-fork README: one-paragraph description, "Build from source" (`pnpm install && pnpm run build:core`), "Run" (`node scripts/dev-cli.js` or the linked `gsd` bin), and a link to `docs/`. Keep `VISION.md` reference if still accurate. Do not keep Discord/stars/downloads badges.

- [ ] **Step 3: `.npmrc` / `.npmignore`**

`.npmrc`: keep only settings that affect local installs (e.g. `engine-strict`). Remove registry-auth / publish lines.
`.npmignore`: leave as-is or delete — irrelevant if not publishing. If deleting, `git rm .npmignore`.

- [ ] **Step 4: Remove the baseline scratch file**

```bash
git rm docs/superpowers/plans/strip-to-cli-baseline.md
```

- [ ] **Step 5: Gate** — build:core, test:unit, `node scripts/dev-cli.js --version` (prints the version), `--help`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: personal-fork identity for README and package.json

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 31: Reset the long history files

**Files:**
- Overwrite: `CHANGELOG.md`
- Delete: `CONTEXT.md`
- Modify: any `package.json` script or `src/` code that reads `CONTEXT.md`

- [ ] **Step 1: Check `CONTEXT.md` consumers**

Run: `grep -rn "CONTEXT.md" src scripts package.json .github --include='*.ts' --include='*.cjs' --include='*.mjs' --include='*.json' --include='*.yml' | grep -v node_modules`
If a script generates or validates it, delete that script/step too. If `src/` runtime reads it, stop and report (unexpected).

- [ ] **Step 2: Overwrite `CHANGELOG.md`**

Replace entire contents with:
```markdown
# Changelog

Personal fork of [open-gsd/gsd-pi](https://github.com/open-gsd/gsd-pi),
detached at upstream **v1.18.0**. Subsequent changes are tracked in git
history on this repository.
```

- [ ] **Step 3: Delete `CONTEXT.md`**

```bash
git rm CONTEXT.md
```

- [ ] **Step 4: Gate** (build:core, test:unit, `--help`). If a `secret-scan` or `markdownlint` hook trips on the new `CHANGELOG.md`, fix formatting.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: reset CHANGELOG to a fork stub, drop CONTEXT.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 32: Final sweep

**Files:**
- Modify: `tsconfig.json`, `tsconfig.extensions.json`, `tsconfig.resources.json`, `tsconfig.test.json`, `pnpm-workspace.yaml`, `.gitattributes`, `.secretscanignore`, `.markdownlint-cli2.jsonc` — only entries pointing at deleted trees

- [ ] **Step 1: Regenerate lockfile cleanly**

```bash
pnpm install
pnpm dedupe
```
Commit any `pnpm-lock.yaml` churn separately if large.

- [ ] **Step 2: Dangling-reference sweep**

Run each; every hit must be in a comment, a deleted-path ignore rule to be removed, or genuinely absent:
```bash
grep -rn "web-mode\|cli-web-branch\|runWebCliBranch" src --include='*.ts'
grep -rn "mcp-server\|cloud-mcp-gateway\|startMcpServer\|buildGraph\|graphQuery" src --include='*.ts'
grep -rn "remote-questions\|isRemoteConfigured\|handleRemote" src --include='*.ts'
grep -rn "CMUX\|cmux-events\|initCmuxEventListeners" src --include='*.ts'
grep -rn "hermes\|vscode-extension" src package.json --include='*.ts' --include='*.json'
grep -rn "extensions/voice\|extensions/ttsr\|extensions/google-search\|extensions/aws-auth\|extensions/google-cli\|extensions/cursor-cli\|extensions/context7" src --include='*.ts'
```
Expected: no live-code hits.

- [ ] **Step 3: Fix config files**

Remove `references` / `paths` / `include` entries in `tsconfig*.json` that point at `web/`, `packages/mcp-server`, `packages/cloud-mcp-gateway`, `packages/daemon`, or `vscode-extension/`. Remove `.gitattributes`, `.secretscanignore`, and `.markdownlint-cli2.jsonc` lines that reference deleted paths. Clean the now-stale `overrides` comments in `pnpm-workspace.yaml` (`discord.js`, etc. removed in Task 28).

- [ ] **Step 4: Full build + full test**

```bash
pnpm run build
pnpm run test:unit
pnpm run test:integration
node --experimental-strip-types tests/smoke/run.ts
```
`test:integration` may have pre-existing failures — compare against the Task 1 baseline notes. `build` must be clean. `test:unit` must be clean (modulo baseline known-failures).

- [ ] **Step 5: Manual TUI acceptance**

In a scratch project dir with a `.gsd/`:
```bash
node /Users/mirogers/git/eagle27272/gsd-pi/scripts/dev-cli.js
```
Confirm: onboarding/welcome renders with no web or remote lines, the composer opens, `/help` lists commands with no `remote` / `cmux` / `graph` entries, start a quick session against Claude or Ollama, Ctrl-C exits cleanly.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: final sweep — configs, lockfile, dangling references

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Report**

Summarize to the user: total files/dirs removed, `node_modules` size before/after (`du -sh node_modules`), build time before/after, dependency count before/after (`node -e "console.log(Object.keys(require('./package.json').dependencies).length)"`), and any tests newly skipped or removed.

---

## Self-Review

**Spec coverage:**
- Stage 0 baseline → Task 1. ✓
- Stage 1 standalone dirs (vscode, docs, docker, orchestrator, hermes, CI) → Tasks 2–5. ✓
- Stage 2 clean leaves (7) → Tasks 6–12. ✓
- Stage 2b remote-questions surgery → Tasks 13–17. ✓
- Stage 2c cmux surgery → Tasks 18–20. ✓
- Stage 3 web UI → Tasks 21–25. ✓
- Stage 4 MCP/gateway/daemon/graph → Tasks 26–29. ✓
- Stage 5 provider trim → folded into Tasks 10, 11 (google-cli, cursor-cli); onboarding provider-list edits covered there. No separate task needed — spec Stage 5 said it "may fold into a Stage 2 commit". ✓
- Stage 6 identity → Tasks 30–31. ✓
- Stage 7 final sweep → Task 32. ✓
- Package name → settled: unscoped `gsd-pi` (Task 30). ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Conditional steps (daemon reference check, copy-export-html usage, shared cli-arg helpers) give explicit branch instructions rather than deferring. ✓

**Type consistency:** `LoopDeps` cmux members named identically in Task 20 Step 3 and the `makeCmuxEmitters` return in Task 20 Step 2 (`syncCmuxSidebar`, `logCmuxEvent`, `clearCmuxSidebar`). `saveRemoteQuestionsConfig` / `isRemoteConfigured` / `tryRemoteQuestions` / `handleRemote` names consistent across Tasks 13–17. `parseCliArgs` / `buildHeadlessCommandArgs` / `migrateLegacyFlatSessions` relocation target `src/cli-args.ts` consistent across Task 24 steps. ✓

**Known soft spots for the executor** (not plan defects — flagged for care):
- Task 17 Step 1 rewrites a ~100-line routing block in `ask-user-questions.ts`; read the whole block before editing.
- Task 20 Step 4 touches ~6 scattered emit sites in a 3,459-line file; grep-driven, delete one at a time, typecheck between.
- Task 24 Step 1–2 hinges on whether `parseCliArgs` lives in `cli-web-branch.ts`; the triage step resolves it.
