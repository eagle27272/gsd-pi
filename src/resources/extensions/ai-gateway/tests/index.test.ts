import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider, unregisterOAuthProvider } from "@gsd/pi-ai/oauth";
import { AuthStorage } from "@gsd/pi-coding-agent";
import aiGateway, { createAiGateway } from "../index.ts";
import { buildGatewayModels } from "../models.ts";
import { createTokenRefresher } from "../token.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type RegisteredProvider = { name: string; config: Record<string, any> };

function makeMockPi() {
	const providers: RegisteredProvider[] = [];
	const handlers: Record<string, Handler> = {};
	const pi = {
		on(event: string, handler: Handler) {
			handlers[event] = handler;
		},
		registerProvider(name: string, config: Record<string, unknown>) {
			providers.push({ name, config });
		},
		unregisterProvider(name: string) {
			for (let i = providers.length - 1; i >= 0; i--) {
				if (providers[i]?.name === name) providers.splice(i, 1);
			}
		},
	};
	return { pi, providers, handlers };
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ai-gateway-index-"));
	process.env.GSD_AI_GATEWAY_CONFIG_DIR = dir;
	delete process.env.GSD_AI_GATEWAY_BASE_URL;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.GSD_AI_GATEWAY_CONFIG_DIR;
	unregisterOAuthProvider("ai-gateway");
});

function writeLauncherConfig(models: string[] = ["claude-sonnet-5-5", "gemini-3.5-flash", "claude-opus-5-5"]): void {
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({ env: "prod", agent_id: "agent-1", agent_name: "Banno-dev", kb_id: null, models }),
	);
}

test("registers one ai-gateway provider on the anthropic-messages API", () => {
	writeLauncherConfig();
	const { pi, providers } = makeMockPi();
	aiGateway(pi as never);

	assert.equal(providers.length, 1);
	assert.equal(providers[0].name, "ai-gateway");
	assert.equal(providers[0].config.name, "AI Gateway");
	assert.equal(providers[0].config.api, "anthropic-messages");
	assert.equal(
		providers[0].config.baseUrl,
		"https://askjack.jackhenry.com/api/ai-gw/v1/4d5abed5-de03-6d15-8506-c143afc8d1e5/agents/agent-1/anthropic",
	);
});

test("sends X-JH-Client: gsd-pi on every request", () => {
	writeLauncherConfig();
	const { pi, providers } = makeMockPi();
	aiGateway(pi as never);

	assert.equal(providers[0].config.headers["X-JH-Client"], "gsd-pi");
});

test("registers only the claude models the launcher lists", () => {
	writeLauncherConfig();
	const { pi, providers } = makeMockPi();
	aiGateway(pi as never);

	const ids = (providers[0].config.models as Array<{ id: string }>).map((m) => m.id);
	assert.deepEqual(ids, ["claude-sonnet-5-5", "claude-opus-5-5"]);
});

test("registers nothing and does not throw when the launcher config is missing", () => {
	const { pi, providers, handlers } = makeMockPi();
	assert.doesNotThrow(() => aiGateway(pi as never));
	assert.equal(providers.length, 0);
	assert.doesNotThrow(() => handlers.session_start?.({}, {}));
	assert.equal(providers.length, 0);
});

test("registers nothing for a half-written launcher config", () => {
	writeFileSync(join(dir, "config.json"), '{"agent_id": "agent-1", "models":');
	const { pi, providers } = makeMockPi();
	assert.doesNotThrow(() => aiGateway(pi as never));
	assert.equal(providers.length, 0);
});

test("isReady follows whether the launcher config is readable", () => {
	writeLauncherConfig();
	const { pi, providers } = makeMockPi();
	aiGateway(pi as never);

	assert.equal(providers[0].config.isReady(), true);
	rmSync(join(dir, "config.json"));
	assert.equal(providers[0].config.isReady(), false);
});

test("session_start re-reads the launcher config so a gw pick takes effect", () => {
	writeLauncherConfig();
	const { pi, providers, handlers } = makeMockPi();
	aiGateway(pi as never);

	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({ env: "prod", agent_id: "agent-2", models: ["claude-haiku-5-5"] }),
	);
	handlers.session_start({}, { sessionManager: { getSessionId: () => "abcd1234-5678" } });

	assert.equal(providers.length, 1);
	assert.ok(String(providers[0].config.baseUrl).includes("/agents/agent-2/"));
	assert.deepEqual((providers[0].config.models as Array<{ id: string }>).map((m) => m.id), ["claude-haiku-5-5"]);
});

test("session_start adds X-JH-Session-Id from the gsd session id", () => {
	writeLauncherConfig();
	const { pi, providers, handlers } = makeMockPi();
	aiGateway(pi as never);

	handlers.session_start({}, { sessionManager: { getSessionId: () => "abcd1234-5678-ef01" } });

	assert.equal(providers[0].config.headers["X-JH-Session-Id"], "abcd1234-5678-ef01");
	assert.equal(providers[0].config.headers["X-JH-Client"], "gsd-pi");
});

test("session_start omits X-JH-Session-Id when the id is not a legal label", () => {
	writeLauncherConfig();
	const { pi, providers, handlers } = makeMockPi();
	aiGateway(pi as never);

	for (const bad of ["short", "has spaces in it!", "x".repeat(65), ""]) {
		handlers.session_start({}, { sessionManager: { getSessionId: () => bad } });
		assert.equal(providers[0].config.headers["X-JH-Session-Id"], undefined, `id=${JSON.stringify(bad)}`);
	}
});

test("session_start seeds an expired credential so the first request refreshes through the launcher", async () => {
	writeLauncherConfig();
	const { pi, providers, handlers } = makeMockPi();
	const refresh = createTokenRefresher({ fetch: async () => "okta-token" });
	createAiGateway(refresh)(pi as never);
	const authStorage = AuthStorage.inMemory();

	handlers.session_start({}, { sessionManager: { getSessionId: () => "abcd1234" }, modelRegistry: { authStorage } });

	const cred = authStorage.get("ai-gateway");
	assert.equal(cred?.type, "oauth");
	assert.equal((cred as { expires: number }).expires, 0);

	registerOAuthProvider({ id: "ai-gateway", ...providers[0].config.oauth });
	assert.equal(await authStorage.getApiKey("ai-gateway"), "okta-token");
});

test("session_start does not overwrite an existing credential", () => {
	writeLauncherConfig();
	const { pi, handlers } = makeMockPi();
	aiGateway(pi as never);
	const authStorage = AuthStorage.inMemory({
		"ai-gateway": { type: "oauth", access: "live", refresh: "", expires: Date.now() + 60_000 },
	});

	handlers.session_start({}, { sessionManager: { getSessionId: () => "abcd1234" }, modelRegistry: { authStorage } });

	assert.equal((authStorage.get("ai-gateway") as { access: string }).access, "live");
});

test("the 5.5 models get 1M context, 128K output and adaptive thinking", () => {
	const models = buildGatewayModels(["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]);

	assert.equal(models.length, 3);
	for (const model of models) {
		assert.equal(model.contextWindow, 1_000_000, model.id);
		assert.equal(model.maxTokens, 128_000, model.id);
		assert.equal((model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking, true, model.id);
		assert.ok(!model.name.includes("Vertex"), `${model.id} name is ${model.name}`);
	}
});

test("a model in both catalogs takes the anthropic entry", () => {
	const [model] = buildGatewayModels(["claude-sonnet-4-6"]);

	assert.equal(model.name, "Claude Sonnet 4.6");
	assert.equal(model.contextWindow, 1_000_000);
});

test("buildGatewayModels takes capabilities from the catalog and defaults the rest", () => {
	const [, unknown] = buildGatewayModels(["claude-sonnet-5-5", "claude-future-9"]);

	assert.equal(unknown.id, "claude-future-9");
	assert.deepEqual(unknown.input, ["text", "image"]);
	assert.equal(unknown.contextWindow, 200000);
	assert.equal(unknown.maxTokens, 64000);
	assert.deepEqual(unknown.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("an expired launcher session pauses the run instead of falling back to another model", async () => {
	const { classifyError } = await import("../../gsd/error-classifier.ts");
	const { streamSimple } = await import("@gsd/pi-ai");
	writeLauncherConfig();
	const { pi, providers } = makeMockPi();
	aiGateway(pi as never);
	const [first] = buildGatewayModels(["claude-sonnet-5-5"]);
	const model = { ...first, provider: "ai-gateway", api: "anthropic-messages", baseUrl: String(providers[0].config.baseUrl) };

	let message = "";
	for await (const event of streamSimple(model as never, { messages: [] }, {})) {
		if (event.type === "error") message = event.error.errorMessage ?? "";
		break;
	}

	assert.match(message, /claude-ai-gw gw login/);
	assert.notEqual(classifyError(message).kind, "model-error");
});
