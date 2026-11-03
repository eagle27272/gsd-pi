import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LauncherConfig = {
	env: string;
	agentId: string;
	agentName: string;
	kbId: string | null;
	models: string[];
};

const DEFAULT_INSTITUTION_ID = "4d5abed5-de03-6d15-8506-c143afc8d1e5";
const PROD_HOST = "https://askjack.jackhenry.com";

const BUILT_IN_HOSTS: Record<string, string> = {
	prod: PROD_HOST,
	dev: "https://dev.askjack.jackhenry.com",
	staging: "https://staging.askjack.jackhenry.com",
	local: "http://localhost:5050",
};

// Same shape the launcher accepts for `gw env add`; anything else is ignored.
const ENV_NAME_RE = /^[a-z0-9-]{1,20}$/;
const ENV_ORIGIN_RE = /^https?:\/\/[^\s/]+(:\d+)?$/;

export function launcherDir(): string {
	return process.env.GSD_AI_GATEWAY_CONFIG_DIR || join(homedir(), ".claude-ai-gw");
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

export function readLauncherConfig(dir: string = launcherDir()): LauncherConfig | null {
	const raw = readJson(join(dir, "config.json"));
	if (typeof raw !== "object" || raw === null) return null;
	const config = raw as Record<string, unknown>;

	if (typeof config.agent_id !== "string" || config.agent_id.length === 0) return null;
	if (!Array.isArray(config.models)) return null;

	return {
		env: typeof config.env === "string" ? config.env : "prod",
		agentId: config.agent_id,
		agentName: typeof config.agent_name === "string" ? config.agent_name : config.agent_id,
		kbId: typeof config.kb_id === "string" && config.kb_id.length > 0 ? config.kb_id : null,
		models: config.models.filter((model): model is string => typeof model === "string"),
	};
}

function userAddedHosts(dir: string): Record<string, string> {
	const raw = readJson(join(dir, "environments.json"));
	if (typeof raw !== "object" || raw === null) return {};
	const hosts: Record<string, string> = {};
	for (const [name, url] of Object.entries(raw)) {
		if (typeof url !== "string") continue;
		const origin = url.replace(/\/+$/, "");
		if (ENV_NAME_RE.test(name) && ENV_ORIGIN_RE.test(origin)) hosts[name] = origin;
	}
	return hosts;
}

export function buildBaseUrl(config: LauncherConfig, dir: string = launcherDir()): string {
	const override = process.env.GSD_AI_GATEWAY_BASE_URL;
	if (override) return override;

	const host = { ...BUILT_IN_HOSTS, ...userAddedHosts(dir) }[config.env] ?? PROD_HOST;
	const institution = process.env.CLAUDE_AI_GW_INSTITUTION_ID || DEFAULT_INSTITUTION_ID;
	const kbSegment = config.kbId ? `/kbs/${config.kbId}` : "";
	return `${host}/api/ai-gw/v1/${institution}/agents/${config.agentId}${kbSegment}/anthropic`;
}
