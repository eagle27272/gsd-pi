/**
 * Ollama's /api/pull reports failure in-stream as `{"error": "..."}` under
 * HTTP 200. Nothing about the response status or the closed stream says the
 * pull failed, so the client has to read the payload to know.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import * as client from "./ollama-client.js";
import { registerOllamaCommands } from "./ollama-commands.js";
import { registerOllamaTool } from "./ollama-tool.js";

/** NDJSON lines the fake server replies with, set per test. */
let pullResponseLines: string[] = [];
let showResponseBody = "{}";

let server: Server;
let savedHost: string | undefined;

before(async () => {
	server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("Ollama is running");
			return;
		}
		if (req.method === "POST" && req.url === "/api/pull") {
			res.writeHead(200, { "Content-Type": "application/x-ndjson" });
			res.end(pullResponseLines.map((line) => `${line}\n`).join(""));
			return;
		}
		if (req.method === "POST" && req.url === "/api/show") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(showResponseBody);
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	savedHost = process.env.OLLAMA_HOST;
	process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
});

after(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (savedHost === undefined) delete process.env.OLLAMA_HOST;
	else process.env.OLLAMA_HOST = savedHost;
});

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
	details?: { error?: string };
}

function makeOllamaTool() {
	let captured: any;
	registerOllamaTool({ registerTool: (spec: unknown) => (captured = spec) } as any);
	return (args: Record<string, unknown>) =>
		captured.execute("call-1", args, undefined, undefined, {}) as Promise<ToolResult>;
}

test("pullModel rejects when the stream carries an error object", async () => {
	pullResponseLines = [
		JSON.stringify({ status: "pulling manifest" }),
		JSON.stringify({ error: "pull model manifest: file does not exist" }),
	];

	await assert.rejects(
		() => client.pullModel("does-not-exist:latest"),
		/pull model manifest: file does not exist/,
	);
});

test("pullModel resolves when the stream completes without an error", async () => {
	pullResponseLines = [
		JSON.stringify({ status: "pulling manifest" }),
		JSON.stringify({ status: "downloading", total: 100, completed: 100 }),
		JSON.stringify({ status: "success" }),
	];

	const seen: string[] = [];
	await client.pullModel("llama3:latest", (progress) => seen.push(progress.status));

	assert.deepEqual(seen, ["pulling manifest", "downloading", "success"]);
});

test("ollama_manage pull reports an error instead of claiming success", async () => {
	pullResponseLines = [
		JSON.stringify({ status: "pulling manifest" }),
		JSON.stringify({ error: "pull model manifest: file does not exist" }),
	];
	const execute = makeOllamaTool();

	const result = await execute({ action: "pull", model: "does-not-exist:latest" });

	assert.equal(result.isError, true, "a failed pull must be reported as an error");
	assert.match(result.content[0]?.text ?? "", /file does not exist/);
});

test("/ollama pull notifies failure instead of success", async () => {
	pullResponseLines = [
		JSON.stringify({ status: "pulling manifest" }),
		JSON.stringify({ error: "pull model manifest: file does not exist" }),
	];
	let handler: any;
	registerOllamaCommands({ registerCommand: (_name: string, spec: any) => (handler = spec.handler) } as any);
	const notifications: Array<[string, string]> = [];
	const ctx = {
		ui: {
			notify: (message: string, level: string) => notifications.push([message, level]),
			setWidget: () => {},
		},
	};

	await handler("pull does-not-exist:latest", ctx);

	assert.deepEqual(
		notifications.filter(([, level]) => level === "success"),
		[],
		"a failed pull must not be announced as a success",
	);
	assert.equal(notifications.at(-1)?.[1], "error");
	assert.match(notifications.at(-1)?.[0] ?? "", /file does not exist/);
});

test("ollama_manage show reports an actionable error when details are missing", async () => {
	showResponseBody = JSON.stringify({ modelfile: "", parameters: "", template: "" });
	const execute = makeOllamaTool();

	const result = await execute({ action: "show", model: "llama3:latest" });

	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /details/i);
	assert.doesNotMatch(result.content[0]?.text ?? "", /undefined/);
});
