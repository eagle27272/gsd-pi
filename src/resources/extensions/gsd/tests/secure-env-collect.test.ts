/**
 * Tests for secure_env_collect utility functions:
 * - checkExistingEnvKeys: detects keys already present in .env file or process.env
 * - detectDestination: infers write destination from project files
 *
 * Uses temp directories for filesystem isolation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkExistingEnvKeys, detectDestination } from "../../get-secrets-from-user.ts";

function makeTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	// resolveProjectEnvFilePath refuses a projectDir with no project marker.
	writeFileSync(join(dir, "package.json"), "{}");
	return dir;
}

// ─── checkExistingEnvKeys ─────────────────────────────────────────────────────

test("secure_env_collect: checkExistingEnvKeys — key found in .env file", async () => {
	const tmp = makeTempDir("sec-env-test");
	try {
		const envPath = join(tmp, ".env");
		writeFileSync(envPath, "API_KEY=secret123\nOTHER=val\n");
		const result = await checkExistingEnvKeys(["API_KEY"], envPath);
		assert.deepStrictEqual(result, ["API_KEY"]);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: checkExistingEnvKeys — key found in process.env", async () => {
	const tmp = makeTempDir("sec-env-test");
	const savedVal = process.env.GSD_TEST_ENV_KEY_12345;
	try {
		process.env.GSD_TEST_ENV_KEY_12345 = "some-value";
		const envPath = join(tmp, ".env"); // file doesn't exist
		const result = await checkExistingEnvKeys(["GSD_TEST_ENV_KEY_12345"], envPath);
		assert.deepStrictEqual(result, ["GSD_TEST_ENV_KEY_12345"]);
	} finally {
		delete process.env.GSD_TEST_ENV_KEY_12345;
		if (savedVal !== undefined) process.env.GSD_TEST_ENV_KEY_12345 = savedVal;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: checkExistingEnvKeys — key found in both .env and process.env", async () => {
	const tmp = makeTempDir("sec-env-test");
	const savedVal = process.env.GSD_TEST_BOTH_KEY;
	try {
		process.env.GSD_TEST_BOTH_KEY = "from-env";
		const envPath = join(tmp, ".env");
		writeFileSync(envPath, "GSD_TEST_BOTH_KEY=from-file\n");
		const result = await checkExistingEnvKeys(["GSD_TEST_BOTH_KEY"], envPath);
		assert.deepStrictEqual(result, ["GSD_TEST_BOTH_KEY"]);
	} finally {
		delete process.env.GSD_TEST_BOTH_KEY;
		if (savedVal !== undefined) process.env.GSD_TEST_BOTH_KEY = savedVal;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: checkExistingEnvKeys — key not found anywhere", async () => {
	const tmp = makeTempDir("sec-env-test");
	try {
		const envPath = join(tmp, ".env");
		writeFileSync(envPath, "OTHER_KEY=val\n");
		// Ensure it's not in process.env
		delete process.env.DEFINITELY_NOT_SET_KEY_XYZ;
		const result = await checkExistingEnvKeys(["DEFINITELY_NOT_SET_KEY_XYZ"], envPath);
		assert.deepStrictEqual(result, []);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: checkExistingEnvKeys — .env file doesn't exist (ENOENT), still checks process.env", async () => {
	const tmp = makeTempDir("sec-env-test");
	const savedVal = process.env.GSD_TEST_ENOENT_KEY;
	try {
		process.env.GSD_TEST_ENOENT_KEY = "exists-in-process";
		const envPath = join(tmp, "nonexistent.env");
		const result = await checkExistingEnvKeys(["GSD_TEST_ENOENT_KEY", "MISSING_KEY_XYZ"], envPath);
		assert.deepStrictEqual(result, ["GSD_TEST_ENOENT_KEY"]);
	} finally {
		delete process.env.GSD_TEST_ENOENT_KEY;
		if (savedVal !== undefined) process.env.GSD_TEST_ENOENT_KEY = savedVal;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: checkExistingEnvKeys — empty-string value in process.env counts as existing", async () => {
	const tmp = makeTempDir("sec-env-test");
	const savedVal = process.env.GSD_TEST_EMPTY_KEY;
	try {
		process.env.GSD_TEST_EMPTY_KEY = "";
		const envPath = join(tmp, ".env");
		writeFileSync(envPath, "");
		const result = await checkExistingEnvKeys(["GSD_TEST_EMPTY_KEY"], envPath);
		assert.deepStrictEqual(result, ["GSD_TEST_EMPTY_KEY"]);
	} finally {
		delete process.env.GSD_TEST_EMPTY_KEY;
		if (savedVal !== undefined) process.env.GSD_TEST_EMPTY_KEY = savedVal;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: checkExistingEnvKeys — returns only existing keys from input list", async () => {
	const tmp = makeTempDir("sec-env-test");
	const saved1 = process.env.GSD_TEST_EXISTS_A;
	const saved2 = process.env.GSD_TEST_EXISTS_B;
	try {
		process.env.GSD_TEST_EXISTS_A = "val-a";
		delete process.env.GSD_TEST_EXISTS_B;
		const envPath = join(tmp, ".env");
		writeFileSync(envPath, "FILE_KEY=val\n");
		const result = await checkExistingEnvKeys(
			["GSD_TEST_EXISTS_A", "GSD_TEST_EXISTS_B", "FILE_KEY", "NOPE_KEY"],
			envPath,
		);
		assert.deepStrictEqual(result.sort(), ["FILE_KEY", "GSD_TEST_EXISTS_A"]);
	} finally {
		delete process.env.GSD_TEST_EXISTS_A;
		delete process.env.GSD_TEST_EXISTS_B;
		if (saved1 !== undefined) process.env.GSD_TEST_EXISTS_A = saved1;
		if (saved2 !== undefined) process.env.GSD_TEST_EXISTS_B = saved2;
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── detectDestination ────────────────────────────────────────────────────────

test("secure_env_collect: detectDestination — returns 'vercel' when vercel.json exists", () => {
	const tmp = makeTempDir("sec-dest-test");
	try {
		writeFileSync(join(tmp, "vercel.json"), "{}");
		assert.equal(detectDestination(tmp), "vercel");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: detectDestination — returns 'convex' when convex/ dir exists", () => {
	const tmp = makeTempDir("sec-dest-test");
	try {
		mkdirSync(join(tmp, "convex"));
		assert.equal(detectDestination(tmp), "convex");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: detectDestination — returns 'dotenv' when neither exists", () => {
	const tmp = makeTempDir("sec-dest-test");
	try {
		assert.equal(detectDestination(tmp), "dotenv");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: detectDestination — vercel takes priority when both exist", () => {
	const tmp = makeTempDir("sec-dest-test");
	try {
		writeFileSync(join(tmp, "vercel.json"), "{}");
		mkdirSync(join(tmp, "convex"));
		assert.equal(detectDestination(tmp), "vercel");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: detectDestination — convex file (not dir) does not trigger convex", () => {
	const tmp = makeTempDir("sec-dest-test");
	try {
		writeFileSync(join(tmp, "convex"), "not a directory");
		assert.equal(detectDestination(tmp), "dotenv");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── Bug #2997: undefined vs null handling ──────────────────────────────────

/**
 * When ctx.ui.custom() returns undefined (e.g. noOpUIContext, component
 * disposal, abort), the strict null checks (=== null / !== null) let
 * undefined slip through as a "provided" value, crashing writeEnvKey
 * which calls .replace() on it.
 *
 * These tests verify the fix: loose equality (== null / != null) so that
 * both null AND undefined are treated as "skipped".
 */

// Helper to dynamically load the orchestrator
async function loadOrchestrator(): Promise<{
	collectSecretsFromManifest: Function;
}> {
	const mod = await import("../../get-secrets-from-user.ts");
	return { collectSecretsFromManifest: mod.collectSecretsFromManifest };
}

// Helper to dynamically load files.ts functions
async function loadFilesExports(): Promise<{
	formatSecretsManifest: (m: any) => string;
}> {
	const mod = await import("../files.ts");
	return { formatSecretsManifest: mod.formatSecretsManifest };
}

function makeManifest(entries: Array<{ key: string; status?: string; formatHint?: string; guidance?: string[] }>): any {
	return {
		milestone: "M001",
		generatedAt: "2026-03-12T00:00:00Z",
		entries: entries.map((e) => ({
			key: e.key,
			service: "TestService",
			dashboardUrl: "",
			guidance: e.guidance ?? [],
			formatHint: e.formatHint ?? "",
			status: e.status ?? "pending",
			destination: "dotenv",
		})),
	};
}

async function writeManifestFile(dir: string, manifest: any): Promise<string> {
	const { formatSecretsManifest } = await loadFilesExports();
	const milestoneDir = join(dir, ".gsd", "phases", "01-m001");
	mkdirSync(milestoneDir, { recursive: true });
	const filePath = join(milestoneDir, "M001-SECRETS.md");
	writeFileSync(filePath, formatSecretsManifest(manifest));
	return filePath;
}

test("secure_env_collect #2997: undefined from ctx.ui.custom() is treated as skipped, not provided", async (t) => {
	const { collectSecretsFromManifest } = await loadOrchestrator();

	const tmp = makeTempDir("sec-undefined-test");
	t.after(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const manifest = makeManifest([
		{ key: "SECRET_THAT_RETURNS_UNDEFINED", status: "pending" },
	]);
	await writeManifestFile(tmp, manifest);

	let callIndex = 0;
	const mockCtx = {
		cwd: tmp,
		hasUI: true,
		ui: {
			// First call is summary screen, second is collect — return undefined
			// to simulate noOpUIContext or component disposal
			custom: async (_factory: any) => {
				callIndex++;
				if (callIndex <= 1) return null; // summary screen dismiss
				return undefined; // BUG TRIGGER: should be treated as skipped
			},
		},
	};

	// Before the fix, this crashes with:
	// "Cannot read properties of undefined (reading 'replace')"
	const result = await collectSecretsFromManifest(tmp, "M001", mockCtx as any);

	// The undefined-returning key must appear in skipped, not in applied
	assert.ok(
		result.skipped.includes("SECRET_THAT_RETURNS_UNDEFINED"),
		"Key returning undefined should be in skipped list",
	);
	assert.ok(
		!result.applied.includes("SECRET_THAT_RETURNS_UNDEFINED"),
		"Key returning undefined must NOT be in applied list",
	);
});

test("secure_env_collect #2997: null from ctx.ui.custom() is still treated as skipped (regression guard)", async (t) => {
	const { collectSecretsFromManifest } = await loadOrchestrator();

	const tmp = makeTempDir("sec-null-test");
	t.after(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const manifest = makeManifest([
		{ key: "SECRET_THAT_RETURNS_NULL", status: "pending" },
	]);
	await writeManifestFile(tmp, manifest);

	let callIndex = 0;
	const mockCtx = {
		cwd: tmp,
		hasUI: true,
		ui: {
			custom: async (_factory: any) => {
				callIndex++;
				if (callIndex <= 1) return null; // summary screen dismiss
				return null; // explicit null skip
			},
		},
	};

	const result = await collectSecretsFromManifest(tmp, "M001", mockCtx as any);

	assert.ok(
		result.skipped.includes("SECRET_THAT_RETURNS_NULL"),
		"Key returning null should be in skipped list",
	);
	assert.ok(
		!result.applied.includes("SECRET_THAT_RETURNS_NULL"),
		"Key returning null must NOT be in applied list",
	);
});

test("secure_env_collect: falls back to secure input prompt when custom UI is unavailable", async (t) => {
	const { collectSecretsFromManifest } = await loadOrchestrator();

	const tmp = makeTempDir("sec-input-fallback-test");
	t.after(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const manifest = makeManifest([
		{ key: "SECRET_FROM_INPUT_FALLBACK", status: "pending", formatHint: "starts with sk-" },
	]);
	await writeManifestFile(tmp, manifest);

	let callIndex = 0;
	const inputCalls: Array<{ title: string; placeholder?: string; opts?: { secure?: boolean } }> = [];
	const mockCtx = {
		cwd: tmp,
		hasUI: true,
		ui: {
			custom: async (_factory: any) => {
				callIndex++;
				if (callIndex <= 1) return null; // summary screen dismiss
				return undefined; // collect screen unavailable on this surface
			},
			input: async (title: string, placeholder?: string, opts?: { secure?: boolean }) => {
				inputCalls.push({ title, placeholder, opts });
				return "  sk-test-fallback-value  ";
			},
		},
	};

	const result = await collectSecretsFromManifest(tmp, "M001", mockCtx as any);

	assert.ok(
		result.applied.includes("SECRET_FROM_INPUT_FALLBACK"),
		"Fallback input should collect and apply the key",
	);
	assert.ok(
		!result.skipped.includes("SECRET_FROM_INPUT_FALLBACK"),
		"Fallback input should not mark the key as skipped",
	);
	assert.equal(inputCalls.length, 1, "Fallback input should be requested once");
	assert.equal(inputCalls[0]?.opts?.secure, true, "Fallback input should request secure entry when supported");
});

// ─── Issue #10: applySecrets hardening ───────────────────────────────────────

/**
 * The extension and the MCP server make the same promise to the user — values
 * are written straight to the project and never shown to the AI. These verify
 * the extension's applySecrets keeps the guarantees the MCP copy already had:
 * a runtime-key blocklist, key validation on the dotenv branch, no plaintext
 * secret on a child's argv, and no hydration of remotely-pushed secrets.
 */

async function loadApplySecrets(): Promise<Function> {
	const mod = await import("../../get-secrets-from-user.ts");
	return mod.applySecrets;
}

function recordingExec(code = 0) {
	const calls: Array<{ cmd: string; args: string[]; stdin?: string }> = [];
	const exec = async (cmd: string, args: string[], opts?: { stdin?: string }) => {
		calls.push({ cmd, args, stdin: opts?.stdin });
		return { code, stderr: "" };
	};
	return { calls, exec };
}

test("secure_env_collect #10: dotenv branch refuses a security-sensitive key", async (t) => {
	const applySecrets = await loadApplySecrets();
	const tmp = makeTempDir("sec-blocklist");
	const saved = process.env.NODE_OPTIONS;
	t.after(() => {
		if (saved === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = saved;
		rmSync(tmp, { recursive: true, force: true });
	});
	delete process.env.NODE_OPTIONS;

	const envFilePath = join(tmp, ".env");
	const { applied, errors } = await applySecrets(
		[{ key: "NODE_OPTIONS", value: "--require /tmp/evil.js" }],
		"dotenv",
		{ envFilePath },
	);

	assert.deepStrictEqual(applied, [], "Blocklisted key must not be reported as applied");
	assert.equal(errors.length, 1);
	assert.match(errors[0] as string, /NODE_OPTIONS/);
	assert.equal(existsSync(envFilePath), false, "Blocklisted key must not create the env file");
	assert.equal(process.env.NODE_OPTIONS, undefined, "Blocklisted key must not be hydrated into process.env");
});

test("secure_env_collect #10: dotenv branch rejects a key that would inject a second pair", async (t) => {
	const applySecrets = await loadApplySecrets();
	const tmp = makeTempDir("sec-injection");
	t.after(() => rmSync(tmp, { recursive: true, force: true }));

	const envFilePath = join(tmp, ".env");
	const { applied, errors } = await applySecrets(
		[{ key: "KEY=v\nOTHER", value: "secret" }],
		"dotenv",
		{ envFilePath },
	);

	assert.deepStrictEqual(applied, []);
	assert.equal(errors.length, 1);
	assert.match(errors[0] as string, /invalid environment variable name/);
	assert.equal(existsSync(envFilePath), false, "Injected key must not reach the file");
});

test("secure_env_collect #10: dotenv branch still writes and hydrates a valid key", async (t) => {
	const applySecrets = await loadApplySecrets();
	const tmp = makeTempDir("sec-valid");
	const saved = process.env.GSD_TEST_ISSUE10_KEY;
	t.after(() => {
		if (saved === undefined) delete process.env.GSD_TEST_ISSUE10_KEY;
		else process.env.GSD_TEST_ISSUE10_KEY = saved;
		rmSync(tmp, { recursive: true, force: true });
	});

	const envFilePath = join(tmp, ".env");
	const { applied, errors } = await applySecrets(
		[{ key: "GSD_TEST_ISSUE10_KEY", value: "sk-value" }],
		"dotenv",
		{ envFilePath },
	);

	assert.deepStrictEqual(errors, []);
	assert.deepStrictEqual(applied, ["GSD_TEST_ISSUE10_KEY"]);
	assert.match(readFileSync(envFilePath, "utf8"), /GSD_TEST_ISSUE10_KEY='sk-value'/);
	assert.equal(process.env.GSD_TEST_ISSUE10_KEY, "sk-value");
});

test("secure_env_collect #10: vercel push keeps the secret off the argument list", async () => {
	const applySecrets = await loadApplySecrets();
	const { calls, exec } = recordingExec();

	const { applied } = await applySecrets(
		[{ key: "STRIPE_KEY", value: "sk-live-supersecret" }],
		"vercel",
		{ envFilePath: "unused", environment: "production", exec },
	);

	assert.deepStrictEqual(applied, ["STRIPE_KEY"]);
	assert.equal(calls.length, 1);
	const call = calls[0]!;
	assert.equal(call.cmd, "vercel", "Must invoke vercel directly, not through a shell");
	assert.deepStrictEqual(call.args, ["env", "add", "STRIPE_KEY", "production"]);
	assert.equal(call.stdin, "sk-live-supersecret", "Secret must travel over stdin");
	assert.equal(
		call.args.some((a) => a.includes("sk-live-supersecret")),
		false,
		"Secret must not appear in any argv element",
	);
});

test("secure_env_collect #10: convex push keeps the secret off the argument list", async () => {
	const applySecrets = await loadApplySecrets();
	const { calls, exec } = recordingExec();

	const { applied } = await applySecrets(
		[{ key: "CONVEX_KEY", value: "cx-supersecret" }],
		"convex",
		{ envFilePath: "unused", exec },
	);

	assert.deepStrictEqual(applied, ["CONVEX_KEY"]);
	const call = calls[0]!;
	assert.deepStrictEqual(call.args, ["convex", "env", "set", "CONVEX_KEY"]);
	assert.equal(call.stdin, "cx-supersecret");
	assert.equal(
		call.args.some((a) => a.includes("cx-supersecret")),
		false,
		"Secret must not appear in any argv element",
	);
});

test("secure_env_collect #10: remote push does not hydrate the secret into process.env", async (t) => {
	const applySecrets = await loadApplySecrets();
	const saved = process.env.GSD_TEST_ISSUE10_REMOTE;
	t.after(() => {
		if (saved === undefined) delete process.env.GSD_TEST_ISSUE10_REMOTE;
		else process.env.GSD_TEST_ISSUE10_REMOTE = saved;
	});
	delete process.env.GSD_TEST_ISSUE10_REMOTE;

	const { exec } = recordingExec();
	await applySecrets(
		[{ key: "GSD_TEST_ISSUE10_REMOTE", value: "remote-only" }],
		"convex",
		{ envFilePath: "unused", exec },
	);

	assert.equal(
		process.env.GSD_TEST_ISSUE10_REMOTE,
		undefined,
		"A secret pushed to a remote must not leak into every spawned child's env",
	);
});

test("secure_env_collect #10: remote branch refuses a security-sensitive key before spawning", async () => {
	const applySecrets = await loadApplySecrets();
	const { calls, exec } = recordingExec();

	const { applied, errors } = await applySecrets(
		[{ key: "LD_PRELOAD", value: "/tmp/evil.so" }],
		"vercel",
		{ envFilePath: "unused", environment: "production", exec },
	);

	assert.deepStrictEqual(applied, []);
	assert.equal(errors.length, 1);
	assert.deepStrictEqual(calls, [], "Blocklisted key must never reach a child process");
});

// ─── Issue #10: envFilePath containment ──────────────────────────────────────

/** Register the extension against a stub pi and hand back the tool definition. */
async function loadTool(): Promise<any> {
	const mod = await import("../../get-secrets-from-user.ts");
	let tool: any;
	mod.default({
		registerTool: (t: any) => { tool = t; },
		exec: async () => ({ code: 0, stderr: "" }),
	} as any);
	return tool;
}

function ctxAnsweringWith(cwd: string, value: string) {
	let callIndex = 0;
	return {
		cwd,
		hasUI: true,
		ui: {
			custom: async () => {
				callIndex++;
				return callIndex === 1 ? value : null;
			},
		},
	};
}

test("secure_env_collect #10: an absolute envFilePath outside the project is refused", async (t) => {
	const tool = await loadTool();
	const tmp = makeTempDir("sec-contain");
	const outside = makeTempDir("sec-contain-outside");
	t.after(() => {
		rmSync(tmp, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	const escapeTarget = join(outside, "stolen.env");
	const result = await tool.execute(
		"call-1",
		{ destination: "dotenv", keys: [{ key: "API_KEY" }], envFilePath: escapeTarget },
		undefined,
		undefined,
		ctxAnsweringWith(tmp, "sk-secret"),
	);

	assert.equal(result.isError, true, "An out-of-project envFilePath must be an error");
	assert.equal(existsSync(escapeTarget), false, "Secret must not be written outside the project");
});

test("secure_env_collect #10: a ../ envFilePath escape is refused", async (t) => {
	const tool = await loadTool();
	const parent = makeTempDir("sec-contain-parent");
	const tmp = join(parent, "project");
	mkdirSync(tmp, { recursive: true });
	t.after(() => rmSync(parent, { recursive: true, force: true }));

	const result = await tool.execute(
		"call-1",
		{ destination: "dotenv", keys: [{ key: "API_KEY" }], envFilePath: "../escaped.env" },
		undefined,
		undefined,
		ctxAnsweringWith(tmp, "sk-secret"),
	);

	assert.equal(result.isError, true);
	assert.equal(existsSync(join(parent, "escaped.env")), false, "Secret must not escape to the parent directory");
});

test("secure_env_collect #10: an envFilePath inside the project still writes", async (t) => {
	const tool = await loadTool();
	const tmp = makeTempDir("sec-contain-ok");
	t.after(() => rmSync(tmp, { recursive: true, force: true }));

	const result = await tool.execute(
		"call-1",
		{ destination: "dotenv", keys: [{ key: "API_KEY" }], envFilePath: ".env.local" },
		undefined,
		undefined,
		ctxAnsweringWith(tmp, "sk-secret"),
	);

	assert.equal(result.isError, false);
	assert.match(readFileSync(join(tmp, ".env.local"), "utf8"), /API_KEY='sk-secret'/);
	delete process.env.API_KEY;
});

test("secure_env_collect #20: a failed provider command reports its exit code, not its stderr", async (t) => {
	const applySecrets = await loadApplySecrets();
	const tmp = makeTempDir("sec-stderr");
	t.after(() => rmSync(tmp, { recursive: true, force: true }));

	const secret = "sk-supersecret-value";
	const { applied, errors } = await applySecrets(
		[{ key: "REMOTE_KEY", value: secret }],
		"vercel",
		{
			envFilePath: join(tmp, ".env"),
			environment: "production",
			// Providers routinely echo the rejected value back in validation errors.
			exec: async () => ({ code: 2, stderr: `Error: value "${secret}" is too long` }),
		},
	);

	assert.deepStrictEqual(applied, []);
	assert.equal(errors.length, 1);
	assert.equal(errors[0].includes(secret), false, `provider stderr leaked the secret: ${errors[0]}`);
	assert.match(errors[0], /REMOTE_KEY/);
	assert.match(errors[0], /\b2\b/);
});
