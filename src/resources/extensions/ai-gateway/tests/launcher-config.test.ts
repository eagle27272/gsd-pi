import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseUrl, readLauncherConfig, type LauncherConfig } from "../launcher-config.ts";

const INSTITUTION = "4d5abed5-de03-6d15-8506-c143afc8d1e5";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ai-gateway-config-"));
	delete process.env.GSD_AI_GATEWAY_BASE_URL;
	delete process.env.CLAUDE_AI_GW_INSTITUTION_ID;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.GSD_AI_GATEWAY_BASE_URL;
	delete process.env.CLAUDE_AI_GW_INSTITUTION_ID;
});

function writeConfig(value: unknown): void {
	writeFileSync(join(dir, "config.json"), typeof value === "string" ? value : JSON.stringify(value));
}

const base: LauncherConfig = {
	env: "prod",
	agentId: "agent-1",
	agentName: "Banno-dev",
	kbId: null,
	models: ["claude-sonnet-5-5"],
};

test("reads the saved agent from the launcher config", () => {
	writeConfig({
		env: "prod",
		agent_id: "agent-1",
		agent_name: "Banno-dev",
		kb_id: null,
		models: ["claude-sonnet-5-5", "gemini-3.5-flash"],
	});

	assert.deepEqual(readLauncherConfig(dir), {
		env: "prod",
		agentId: "agent-1",
		agentName: "Banno-dev",
		kbId: null,
		models: ["claude-sonnet-5-5", "gemini-3.5-flash"],
	});
});

test("returns null when the config file is missing", () => {
	assert.equal(readLauncherConfig(dir), null);
});

test("returns null for invalid JSON", () => {
	writeConfig("{not json");
	assert.equal(readLauncherConfig(dir), null);
});

test("returns null when agent_id is absent", () => {
	writeConfig({ env: "prod", models: ["claude-sonnet-5-5"] });
	assert.equal(readLauncherConfig(dir), null);
});

test("returns null when models is not an array", () => {
	writeConfig({ env: "prod", agent_id: "agent-1", models: "claude-sonnet-5-5" });
	assert.equal(readLauncherConfig(dir), null);
});

test("builds the prod route without a knowledge base", () => {
	assert.equal(
		buildBaseUrl(base, dir),
		`https://askjack.jackhenry.com/api/ai-gw/v1/${INSTITUTION}/agents/agent-1/anthropic`,
	);
});

test("adds the knowledge base to the route when one is saved", () => {
	assert.equal(
		buildBaseUrl({ ...base, kbId: "kb-9" }, dir),
		`https://askjack.jackhenry.com/api/ai-gw/v1/${INSTITUTION}/agents/agent-1/kbs/kb-9/anthropic`,
	);
});

test("GSD_AI_GATEWAY_BASE_URL overrides the whole URL", () => {
	process.env.GSD_AI_GATEWAY_BASE_URL = "http://localhost:9999/anthropic";
	assert.equal(buildBaseUrl(base, dir), "http://localhost:9999/anthropic");
});

test("CLAUDE_AI_GW_INSTITUTION_ID changes the institution segment", () => {
	process.env.CLAUDE_AI_GW_INSTITUTION_ID = "inst-2";
	assert.equal(buildBaseUrl(base, dir), "https://askjack.jackhenry.com/api/ai-gw/v1/inst-2/agents/agent-1/anthropic");
});

test("maps the built-in non-prod environments", () => {
	assert.ok(buildBaseUrl({ ...base, env: "staging" }, dir).startsWith("https://staging.askjack.jackhenry.com/"));
	assert.ok(buildBaseUrl({ ...base, env: "local" }, dir).startsWith("http://localhost:5050/"));
});

test("uses an environment the launcher user added with gw env", () => {
	writeFileSync(join(dir, "environments.json"), JSON.stringify({ sandbox: "https://sandbox.example.com/" }));
	assert.ok(buildBaseUrl({ ...base, env: "sandbox" }, dir).startsWith("https://sandbox.example.com/api/ai-gw/"));
});

test("ignores an added environment whose URL is not a bare origin", () => {
	writeFileSync(join(dir, "environments.json"), JSON.stringify({ evil: "https://x.example.com/path?a=b" }));
	assert.ok(buildBaseUrl({ ...base, env: "evil" }, dir).startsWith("https://askjack.jackhenry.com/"));
});

test("falls back to prod for an unknown environment", () => {
	assert.ok(buildBaseUrl({ ...base, env: "nowhere" }, dir).startsWith("https://askjack.jackhenry.com/"));
});
