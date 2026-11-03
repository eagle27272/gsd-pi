# AI Gateway provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register an `ai-gateway` provider that sends Anthropic Messages requests straight to the AskJack AI Gateway agent saved by the `claude-ai-gw` launcher.

**Architecture:** A bundled extension reads `~/.claude-ai-gw/config.json`, builds the agent's `/anthropic` base URL and model list, and registers the provider on the existing `anthropic-messages` API. The Okta token comes from `claude-ai-gw --token` through the provider's `oauth` hook, which gives a 5-minute TTL and shared refreshes through gsd's own refresh lock. A small branch in the shared Anthropic provider sends Bearer auth only.

**Tech Stack:** TypeScript, node:test for extension tests, vitest for `packages/pi-ai`.

**Spec:** `docs/superpowers/specs/2026-11-02-ai-gateway-provider-design.md`

## Global Constraints

- Provider id is `ai-gateway`, display name `AI Gateway`.
- Every request carries `X-JH-Client: gsd-pi`.
- Route: `<host>/api/ai-gw/v1/<institution id>/agents/<agent id>[/kbs/<kb id>]/anthropic`. Host for env `prod` is `https://askjack.jackhenry.com`. Institution id is `4d5abed5-de03-6d15-8506-c143afc8d1e5`, overridable by `CLAUDE_AI_GW_INSTITUTION_ID` like the launcher.
- Auth is `Authorization: Bearer <token>` and no `x-api-key`.
- Token TTL default is 300 seconds, set by `GSD_AI_GATEWAY_TOKEN_TTL_SECONDS`.
- `GSD_AI_GATEWAY_BASE_URL` overrides the whole base URL. `GSD_AI_GATEWAY_CONFIG_DIR` overrides `~/.claude-ai-gw`.
- A missing or unreadable launcher config means the provider is not registered. Startup never throws.
- Only `claude-*` models from the launcher's `models` list are registered.
- Comments only for non-obvious why. Do not mention Claude or co-authors in commits.
- Branch name before the first push: `feat/ai_gateway_provider`.

## Review Focus

- Malformed or half-written `config.json` (invalid JSON, missing `agent_id`, `models` not an array): provider is skipped, no exception reaches startup.
- `claude-ai-gw` not on PATH, exits non-zero, or prints nothing: the request fails with a message that says to run `claude-ai-gw gw login`.
- Launcher prints progress or a login URL on stderr and the token on stdout, with a trailing newline: only trimmed stdout is used.
- Many requests at the moment the token expires: the launcher is spawned once.
- `GSD_AI_GATEWAY_TOKEN_TTL_SECONDS` set to `abc`, `0` or a negative number: falls back to 300.

---

### Task 1: Bearer-only auth in the Anthropic provider

**Files:**
- Modify: `packages/pi-ai/src/providers/anthropic.ts` (client creation, next to the `github-copilot` branch around line 866)
- Test: `packages/pi-ai/test/anthropic-ai-gateway-auth.test.ts`

**Interfaces:**
- Produces: for `model.provider === "ai-gateway"`, the client is built with `apiKey: null`, `authToken: <key>`, `baseURL: model.baseUrl`, and `model.headers` and request headers merged in.

- [ ] **Step 1: Rename the branch** with `git branch -m feat/ai_gateway_provider`, then commit the spec and this plan on it.
- [ ] **Step 2: Write the failing test.** Mock `@anthropic-ai/sdk` so the constructor options are captured, then call `streamSimple` with a model `{ provider: "ai-gateway", api: "anthropic-messages", headers: { "X-JH-Client": "gsd-pi" } }` and `apiKey: "tok"`. Assert `apiKey === null`, `authToken === "tok"`, and `defaultHeaders["X-JH-Client"] === "gsd-pi"`. Add a second test that a plain `anthropic` model with the same key still gets `apiKey: "tok"` and `authToken: null`.
- [ ] **Step 3: Run it to see it fail.** Run: `cd packages/pi-ai && pnpm exec vitest run test/anthropic-ai-gateway-auth.test.ts`. Expected: the first test fails on `authToken`.
- [ ] **Step 4: Implement the branch** by copying the `github-copilot` branch's shape, with no `anthropic-beta` Claude Code identity headers.
- [ ] **Step 5: Run the test again.** Expected: both pass.
- [ ] **Step 6: Commit** `feat(pi-ai): send bearer-only auth for the ai-gateway provider`.

### Task 2: Launcher config reader and base URL

**Files:**
- Create: `src/resources/extensions/ai-gateway/launcher-config.ts`
- Test: `src/resources/extensions/ai-gateway/tests/launcher-config.test.ts`

**Interfaces:**
- Produces:
  - `type LauncherConfig = { env: string; agentId: string; agentName: string; kbId: string | null; models: string[] }`
  - `readLauncherConfig(dir?: string): LauncherConfig | null`. Returns `null` for a missing, malformed or incomplete file, and never throws.
  - `buildBaseUrl(config: LauncherConfig): string`. Honors `GSD_AI_GATEWAY_BASE_URL`, `CLAUDE_AI_GW_INSTITUTION_ID`, and the prod host. An unknown `env` falls back to prod.

- [ ] **Step 1: Write failing tests** against temp-dir config files: prod URL without a kb; URL with `/kbs/<id>` when `kb_id` is set; the base-URL override; `null` for missing file, invalid JSON, absent `agent_id`, and `models` that is not an array.
- [ ] **Step 2: Run them to see them fail.** Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/ai-gateway/tests/launcher-config.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `readLauncherConfig` and `buildBaseUrl`.** Take non-prod hosts from the launcher's `BUILT_IN_GATEWAYS` and `FORMER_GATEWAYS` tables (prod, dev, staging, local) as a plain constant map.
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai-gateway): read the launcher's saved agent`.

### Task 3: Token source with TTL and single flight

**Files:**
- Create: `src/resources/extensions/ai-gateway/token.ts`
- Test: `src/resources/extensions/ai-gateway/tests/token.test.ts`

**Interfaces:**
- Produces:
  - `resolveTtlSeconds(raw: string | undefined): number`. Returns 300 for undefined, non-numeric, zero or negative input.
  - `fetchLauncherToken(run?: (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>): Promise<string>`. Runs `claude-ai-gw --token`, returns trimmed stdout, and throws `Error("... run \`claude-ai-gw gw login\`")` on non-zero exit, empty output or spawn failure. The `run` parameter exists for tests; the default uses `execFile` with a 60-second timeout, because a sign-in can open a browser.
  - `createTokenRefresher(opts?: { ttlSeconds?: number; fetch?: () => Promise<string>; now?: () => number }): (creds?: unknown) => Promise<{ access: string; refresh: string; expires: number }>`. Concurrent calls share one `fetch`. `expires` is `now() + ttl * 1000`, and `refresh` is the empty string.

- [ ] **Step 1: Write failing tests:** `resolveTtlSeconds("abc" | "0" | "-5" | undefined)` is 300 and `"120"` is 120; stdout with trailing newline and stderr text yields only the token; non-zero exit and empty stdout throw an error containing `gw login`; ten concurrent refresher calls call `fetch` once; `expires` equals the injected `now` plus the TTL.
- [ ] **Step 2: Run to see them fail.** Same command as Task 2 with `token.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the three functions** as specified. Single flight is a shared in-flight promise cleared on settle.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai-gateway): fetch tokens from the launcher with a TTL`.

### Task 4: Models and provider registration

**Files:**
- Create: `src/resources/extensions/ai-gateway/models.ts`, `src/resources/extensions/ai-gateway/index.ts`, `src/resources/extensions/ai-gateway/package.json` (copy the `cursor-cli` one, name `@gsd/ai-gateway`)
- Test: `src/resources/extensions/ai-gateway/tests/index.test.ts`

**Interfaces:**
- Consumes: `readLauncherConfig`, `buildBaseUrl` (Task 2); `createTokenRefresher` (Task 3).
- Produces:
  - `buildGatewayModels(ids: string[]): ProviderModelConfig[]`. Keeps `claude-*` ids only. Takes `reasoning`, `thinkingLevelMap`, `compat`, `input`, `cost`, `contextWindow`, `maxTokens` from the `anthropic` catalog entry with the same id. For ids not in the catalog, uses `reasoning: true`, `input: ["text", "image"]`, zero cost, `contextWindow: 200000`, `maxTokens: 64000`.
  - default export `aiGateway(pi: ExtensionAPI): void`.

Behavior of `aiGateway`:
- Registers `ai-gateway` at load when `readLauncherConfig()` returns a config: `name: "AI Gateway"`, `api: "anthropic-messages"`, `baseUrl`, `headers: { "X-JH-Client": "gsd-pi" }`, `models`, `isReady` (true while the config is readable), and `oauth` with `name`, `login` and `refreshToken` both backed by the refresher, and `getApiKey: (c) => c.access`.
- On `session_start`: unregister then re-register, so a `gw pick` takes effect. Add `X-JH-Session-Id` from `ctx.sessionManager.getSessionId()` only when it matches `^[A-Za-z0-9-]{8,64}$`. If `ctx.modelRegistry.authStorage` has no `oauth` credential for `ai-gateway`, `set` an expired one (`{ type: "oauth", access: "", refresh: "", expires: 0 }`) so the first request refreshes through the launcher.
- Does nothing, and throws nothing, when the config is unreadable.

- [ ] **Step 1: Write failing tests** with the mock-pi pattern from `cursor-cli/tests/index.test.ts` and a temp `GSD_AI_GATEWAY_CONFIG_DIR`: registers one provider with the right `api`, `baseUrl` and `X-JH-Client`; skips `gemini-*` ids; registers nothing for a missing config; `session_start` re-registers with `X-JH-Session-Id` and omits it for an id with illegal characters; seeds an expired credential in `AuthStorage.inMemory()` and does not overwrite an existing one; after seeding, `authStorage.getApiKey("ai-gateway")` returns the injected fetch's token.
- [ ] **Step 2: Run to see them fail.** Same command with `index.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `models.ts` and `index.ts`** as specified.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai-gateway): register the gateway as a provider`.

### Task 5: Wire the provider into gsd

**Files:**
- Modify: `packages/pi-ai/src/types.ts` (add `"ai-gateway"` to `KnownProvider`), `packages/pi-coding-agent/src/core/model-resolver.ts` (default model `claude-sonnet-5-5`), `packages/pi-coding-agent/src/core/provider-display-names.ts` (`"AI Gateway"`), `src/onboarding.ts` (add `'ai-gateway'` to `LLM_PROVIDER_IDS` extras), `src/resources/extensions/gsd/doctor-providers.ts`, `package.json` (add `dist-test/src/resources/extensions/ai-gateway/tests/*.test.js` to `test:unit:compiled` and `test:coverage:unit`)
- Test: `src/resources/extensions/gsd/tests/` doctor test for the new check, following the neighbouring doctor-providers tests

**Interfaces:**
- Consumes: `readLauncherConfig` (Task 2). Export `isAiGatewayReady(): boolean` from `src/resources/extensions/ai-gateway/readiness.ts`, which is true when the config reads and `claude-ai-gw` is on PATH.
- Produces: a doctor entry for `ai-gateway` that reports `ok` when ready, otherwise `error` with detail `Install claude-ai-gw and run claude-ai-gw gw login`.

- [ ] **Step 1: Write the failing doctor test** for both outcomes (ready and not ready) with injected readiness.
- [ ] **Step 2: Run it to see it fail.** Use the doctor test file's own run command from its neighbours. Expected: FAIL.
- [ ] **Step 3: Implement the readiness helper and the doctor entry.** Add the type, display name, default model, onboarding and `package.json` changes. The compiler finds every `Record<KnownProvider, …>` that needs an entry, so fix each one it reports.
- [ ] **Step 4: Run** `pnpm run test:compile` then the new tests. Expected: compiles clean, tests PASS.
- [ ] **Step 5: Commit** `feat(ai-gateway): add readiness, doctor and defaults`.

### Task 6: Live check and docs

**Files:**
- Modify: `packages/pi-coding-agent/docs/providers.md` (short section: prerequisites, `defaultProvider: "ai-gateway"`, the env vars from Global Constraints)

- [ ] **Step 1: Build** with `pnpm run build`, start gsd from this worktree's `dist`, pick `ai-gateway`, and send one prompt. Expected: a normal reply.
- [ ] **Step 2: Confirm the label.** In the AI Gateway history for that call, the client shows `gsd-pi`. Quote the `X-JH-Prompt-Id` in the PR.
- [ ] **Step 3: Confirm caching.** Send a second turn and check the response usage reports cache reads.
- [ ] **Step 4: Confirm the token file.** `~/.gsd` `auth.json` holds the `ai-gateway` entry at mode 0600, and its `expires` is about 5 minutes ahead.
- [ ] **Step 5: Write the docs section and commit** `docs: describe the ai-gateway provider`.
