# AI Gateway provider

Size: small change (one bundled extension plus a few lines in the shared Anthropic provider).

## Intent

Use the AskJack AI Gateway as a gsd provider (`ai-gateway`), so gsd talks to the gateway directly instead of through Claude Code or `anthropic-vertex`. The existing `claude-ai-gw` launcher stays installed and acts only as the credential helper and the source of truth for which agent to use.

## Goals

- gsd sends Anthropic Messages requests to the saved agent's gateway route.
- Every request carries `X-JH-Client: gsd-pi`.
- The agent, environment, knowledge base and model list come from the launcher's saved config, so `claude-ai-gw gw pick` also switches gsd.
- The Okta token comes from `claude-ai-gw --token`, cached in process for 5 minutes by default.

## Non-goals and anti-goals

- No Okta sign-in, token storage or refresh logic in gsd. The launcher owns it.
- No per-agent setting inside gsd.
- Not a failure case: the gateway being unreachable or the launcher missing must never crash gsd startup. The provider just does not register.
- No change to what other users get by default. Making this your primary provider is a settings choice (`defaultProvider: "ai-gateway"`), not a global default flip.

## Constraints

- The gateway Anthropic route is `<base>/agents/<agent id>[/kbs/<kb id>]/anthropic`, auth is `Authorization: Bearer <Okta token>`, and only the agent's allowed models work.
- The gateway caches prompts only where the request marks `cache_control`. The Anthropic provider already marks the system prompt and the newest message; the builder must confirm that still happens for this provider.
- gsd's Anthropic provider sends `x-api-key` for any key that is not an `sk-ant-oat` token. This provider needs Bearer only.

## Approaches

1. User config only (`models.json` with `!claude-ai-gw --token`). Rejected: it cannot follow the launcher's saved agent, and the key command runs uncached on every request.
2. Bundled extension on the `anthropic-messages` API with a small provider tweak. Chosen.
3. Extension with its own wrapping stream function. Rejected: it duplicates tested Anthropic stream code.

You chose approach 2 with a 5-minute token TTL.

## Design

New extension `src/resources/extensions/ai-gateway/`, modelled on `ollama` and `cursor-cli`.

- **Launcher config reader.** Reads `~/.claude-ai-gw/config.json` (`env`, `agent_id`, `kb_id`, `models`, `agent_name`). Builds the base URL from those. `GSD_AI_GATEWAY_BASE_URL` overrides the whole URL. The launcher's config path can be overridden with `GSD_AI_GATEWAY_CONFIG_DIR`, mainly for tests.
- **Provider registration.** `pi.registerProvider("ai-gateway", { name, api: "anthropic-messages", baseUrl, headers: { "X-JH-Client": "gsd-pi" }, models, oauth })`. Registered at extension load if the launcher config exists, and re-read on `session_start` so a `gw pick` takes effect on the next session.
- **Token and the 5-minute TTL.** Uses the provider `oauth` hook. `login` and `refreshToken` run `claude-ai-gw --token` and return `{ access, refresh: "", expires: now + ttl }`. `getApiKey` returns `access`. The default TTL is 300 seconds, set by `GSD_AI_GATEWAY_TOKEN_TTL_SECONDS`. Concurrent refreshes share one launcher call.
- **Auth failures.** If the launcher is missing or exits non-zero, the error says to run `claude-ai-gw gw login`.
- **Bearer auth.** `packages/pi-ai/src/providers/anthropic.ts` gets a branch for `model.provider === "ai-gateway"` that sets `authToken` and no `apiKey`, like the `github-copilot` branch.
- **Session label.** `X-JH-Session-Id` is sent from the gsd session id when the provider has one. My addition, easy to drop.
- **Models.** Built from the launcher's `models` list. Claude entries get reasoning and adaptive-thinking flags from the existing catalog data. Gemini entries are registered only if the builder can map them cleanly; otherwise they are skipped.
- **Wiring.** Display name in `provider-display-names.ts`, a default model entry in `model-resolver.ts`, `doctor-providers.ts` readiness check (launcher present, config readable, token obtainable), and the extension added to the compiled test globs in `package.json`.
- **Tests.** Cover the base URL from config (with and without a knowledge base), header presence, TTL cache hit and expiry, single-flight refresh, launcher-missing error, and the Bearer-only client.

## Left to the builder

- The environment-to-host mapping. The README only documents prod; read the launcher's `GATEWAYS` table and the institution id from the launcher source, and fall back to prod.
- Whether stored OAuth credentials are persisted to gsd's `auth.json`. If so the Okta token lands on disk there too, so confirm it is acceptable or keep it in memory only.
- Whether the gateway tolerates both `x-api-key` and `Authorization`. The Bearer-only tweak makes this moot, but verify with one real call.

## My calls, for you to check

- No default flip for other users; you opt in with `defaultProvider`.
- Optional `X-JH-Session-Id`.
- The `GSD_AI_GATEWAY_*` env var names.
- The OAuth hook as the cache mechanism.
