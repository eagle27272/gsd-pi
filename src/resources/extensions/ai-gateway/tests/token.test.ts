import { test } from "node:test";
import assert from "node:assert/strict";
import { createTokenRefresher, fetchLauncherToken, LAUNCHER_TIMEOUT_MS, resolveTtlSeconds } from "../token.ts";

test("resolveTtlSeconds defaults to 300 seconds", () => {
	assert.equal(resolveTtlSeconds(undefined), 300);
});

test("resolveTtlSeconds falls back to 300 for non-numeric, zero and negative values", () => {
	for (const raw of ["abc", "", "0", "-5", "NaN", "Infinity"]) {
		assert.equal(resolveTtlSeconds(raw), 300, `raw=${JSON.stringify(raw)}`);
	}
});

test("resolveTtlSeconds honors a positive number", () => {
	assert.equal(resolveTtlSeconds("120"), 120);
});

test("fetchLauncherToken returns only trimmed stdout", async () => {
	const token = await fetchLauncherToken(async () => ({ stdout: "tok-123\n", stderr: "opening browser...", code: 0 }));
	assert.equal(token, "tok-123");
});

test("fetchLauncherToken runs claude-ai-gw --token", async () => {
	let seen: { cmd: string; args: string[] } | undefined;
	await fetchLauncherToken(async (cmd, args) => {
		seen = { cmd, args };
		return { stdout: "tok", stderr: "", code: 0 };
	});
	assert.deepEqual(seen, { cmd: "claude-ai-gw", args: ["--token"] });
});

test("fetchLauncherToken points at gw login when the launcher exits non-zero", async () => {
	await assert.rejects(
		fetchLauncherToken(async () => ({ stdout: "", stderr: "boom", code: 1 })),
		/claude-ai-gw gw login/,
	);
});

test("fetchLauncherToken points at gw login when the launcher prints nothing", async () => {
	await assert.rejects(
		fetchLauncherToken(async () => ({ stdout: "  \n", stderr: "", code: 0 })),
		/claude-ai-gw gw login/,
	);
});

test("fetchLauncherToken points at gw login when the launcher cannot be started", async () => {
	await assert.rejects(
		fetchLauncherToken(async () => {
			throw new Error("spawn claude-ai-gw ENOENT");
		}),
		/claude-ai-gw gw login/,
	);
});

test("the refresher sets expires to now plus the TTL and no refresh token", async () => {
	const refresh = createTokenRefresher({ ttlSeconds: 300, fetch: async () => "tok", now: () => 1_000 });
	assert.deepEqual(await refresh(), { access: "tok", refresh: "", expires: 1_000 + 300_000 });
});

test("concurrent refreshes share one launcher call", async () => {
	let calls = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const refresh = createTokenRefresher({
		fetch: async () => {
			calls++;
			await gate;
			return "tok";
		},
	});

	const pending = Array.from({ length: 10 }, () => refresh());
	release();
	const results = await Promise.all(pending);

	assert.equal(calls, 1);
	assert.ok(results.every((r) => r.access === "tok"));
});

test("a later refresh calls the launcher again", async () => {
	let calls = 0;
	const refresh = createTokenRefresher({
		fetch: async () => `tok-${++calls}`,
	});
	assert.equal((await refresh()).access, "tok-1");
	assert.equal((await refresh()).access, "tok-2");
});

test("a failed refresh does not poison the next one", async () => {
	let calls = 0;
	const refresh = createTokenRefresher({
		fetch: async () => {
			if (++calls === 1) throw new Error("claude-ai-gw gw login");
			return "tok";
		},
	});
	await assert.rejects(refresh(), /gw login/);
	assert.equal((await refresh()).access, "tok");
});

test("the refresher reads the TTL from GSD_AI_GATEWAY_TOKEN_TTL_SECONDS by default", async () => {
	process.env.GSD_AI_GATEWAY_TOKEN_TTL_SECONDS = "60";
	try {
		const refresh = createTokenRefresher({ fetch: async () => "tok", now: () => 0 });
		assert.equal((await refresh()).expires, 60_000);
	} finally {
		delete process.env.GSD_AI_GATEWAY_TOKEN_TTL_SECONDS;
	}
});

test("the launcher timeout outlasts the launcher's own five minute sign-in window", () => {
	assert.ok(LAUNCHER_TIMEOUT_MS > 300_000, `timeout is ${LAUNCHER_TIMEOUT_MS}ms`);
});

test("fetchLauncherToken includes the launcher's last stderr line in the error", async () => {
	await assert.rejects(
		fetchLauncherToken(async () => ({
			stdout: "",
			stderr: "opening browser\nAI Gateway sign-in expired; a sign-in tab opened 3 min ago.\n",
			code: 1,
		})),
		/sign-in tab opened 3 min ago/,
	);
});
