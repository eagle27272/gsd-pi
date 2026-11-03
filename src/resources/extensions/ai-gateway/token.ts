import { execFile } from "node:child_process";

const DEFAULT_TTL_SECONDS = 300;
// Killing the launcher mid sign-in closes its callback server, and it then refuses another tab for 10 minutes.
// Its own sign-in window is 300 seconds, so this has to outlast that.
export const LAUNCHER_TIMEOUT_MS = 330_000;
const LOGIN_HINT = "run `claude-ai-gw gw login`";

export type RunResult = { stdout: string; stderr: string; code: number };
export type RunCommand = (cmd: string, args: string[]) => Promise<RunResult>;

export type TokenCredentials = { access: string; refresh: string; expires: number };

export function resolveTtlSeconds(raw: string | undefined): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

const runCommand: RunCommand = (cmd, args) =>
	new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: LAUNCHER_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (error && typeof error.code !== "number") {
				reject(error);
				return;
			}
			resolve({ stdout, stderr, code: error ? (error.code as number) : 0 });
		});
	});

export async function fetchLauncherToken(run: RunCommand = runCommand): Promise<string> {
	let result: RunResult;
	try {
		result = await run("claude-ai-gw", ["--token"]);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not run claude-ai-gw (${reason}); install it and ${LOGIN_HINT}`);
	}

	const token = result.stdout.trim();
	if (result.code !== 0 || token.length === 0) {
		const reason = result.stderr.trim().split("\n").pop();
		const detail = reason ? `: ${reason}` : "";
		throw new Error(`claude-ai-gw did not return a token (exit ${result.code})${detail}; ${LOGIN_HINT}`);
	}
	return token;
}

export function createTokenRefresher(opts: {
	ttlSeconds?: number;
	fetch?: () => Promise<string>;
	now?: () => number;
} = {}): (credentials?: unknown) => Promise<TokenCredentials> {
	const fetchToken = opts.fetch ?? (() => fetchLauncherToken());
	const now = opts.now ?? Date.now;
	let inFlight: Promise<TokenCredentials> | undefined;

	return () => {
		inFlight ??= (async () => {
			try {
				const ttlSeconds = opts.ttlSeconds ?? resolveTtlSeconds(process.env.GSD_AI_GATEWAY_TOKEN_TTL_SECONDS);
				const access = await fetchToken();
				return { access, refresh: "", expires: now() + ttlSeconds * 1000 };
			} finally {
				inFlight = undefined;
			}
		})();
		return inFlight;
	};
}
