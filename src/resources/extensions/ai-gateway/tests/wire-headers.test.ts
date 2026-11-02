import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple } from "@gsd/pi-ai";
import { AuthStorage, ModelRegistry } from "@gsd/pi-coding-agent";
import { createAiGateway } from "../index.ts";
import { createTokenRefresher } from "../token.ts";

const SSE_BODY = [
	`event: message_start\ndata: ${JSON.stringify({
		type: "message_start",
		message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
	})}\n`,
	`event: message_delta\ndata: ${JSON.stringify({
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { output_tokens: 5 },
	})}\n`,
	`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
].join("\n");

type Captured = { url: string; headers: IncomingHttpHeaders; body: string };

let server: Server;
let dir: string;
let captured: Captured[] = [];

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "ai-gateway-wire-"));
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			captured.push({ url: req.url ?? "", headers: req.headers, body });
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(SSE_BODY);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({ env: "prod", agent_id: "agent-1", models: ["claude-sonnet-5-5"] }),
	);
	process.env.GSD_AI_GATEWAY_CONFIG_DIR = dir;
	process.env.GSD_AI_GATEWAY_BASE_URL = `http://127.0.0.1:${port}/anthropic`;
});

after(async () => {
	delete process.env.GSD_AI_GATEWAY_CONFIG_DIR;
	delete process.env.GSD_AI_GATEWAY_BASE_URL;
	rmSync(dir, { recursive: true, force: true });
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("a real request carries the gateway headers, bearer auth and cache markers", async () => {
	captured = [];
	const authStorage = AuthStorage.inMemory();
	const registry = ModelRegistry.inMemory(authStorage);
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers[event] = handler;
		},
		registerProvider: (name: string, config: never) => registry.registerProvider(name, config),
		unregisterProvider: (name: string) => registry.unregisterProvider(name),
	};
	createAiGateway(createTokenRefresher({ fetch: async () => "okta-token-abc" }))(pi as never);
	handlers.session_start({}, {
		sessionManager: { getSessionId: () => "0f6e1c1a-8d3b-4c52-9a71-5e2b7c9d4a10" },
		modelRegistry: { authStorage },
	});

	const model = registry.find("ai-gateway", "claude-sonnet-5-5");
	assert.ok(model, "model should be registered");
	const auth = await registry.getApiKeyAndHeaders(model);
	assert.ok(auth.ok, "auth should resolve");

	const stream = streamSimple(
		model,
		{
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		},
		{ apiKey: auth.apiKey, headers: auth.headers },
	);
	for await (const event of stream) {
		if (event.type === "error") assert.fail(event.error.errorMessage);
	}

	assert.equal(captured.length, 1);
	const { url, headers, body } = captured[0];
	assert.equal(url, "/anthropic/v1/messages");
	assert.equal(headers.authorization, "Bearer okta-token-abc");
	assert.equal(headers["x-api-key"], undefined);
	assert.equal(headers["x-jh-client"], "gsd-pi");
	assert.equal(headers["x-jh-session-id"], "0f6e1c1a-8d3b-4c52-9a71-5e2b7c9d4a10");
	assert.equal(headers["anthropic-version"], "2023-06-01");

	const payload = JSON.parse(body);
	assert.equal(payload.model, "claude-sonnet-5-5");
	const marked = JSON.stringify(payload).match(/"cache_control":\{"type":"ephemeral"/g) ?? [];
	assert.ok(marked.length >= 2, `expected cache_control on system and last message, found ${marked.length}`);

});
