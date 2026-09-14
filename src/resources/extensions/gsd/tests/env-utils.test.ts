/**
 * Hardening tests for the extension-side env write primitives.
 *
 * These mirror packages/mcp-server/src/env-writer.test.ts — both sides back the
 * same secure_env_collect promise ("written directly to the project, never
 * shown to the AI"), so both need the same guarantees (#10).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	isSafeEnvVarKey,
	isSecuritySensitiveEnvKey,
	resolveProjectEnvFilePath,
	writeEnvKey,
} from "../env-utils.ts";

function makeTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ─── isSafeEnvVarKey ──────────────────────────────────────────────────────────

test("env-utils: isSafeEnvVarKey accepts conventional env var names", () => {
	assert.equal(isSafeEnvVarKey("OPENAI_API_KEY"), true);
	assert.equal(isSafeEnvVarKey("_private"), true);
	assert.equal(isSafeEnvVarKey("A1"), true);
});

test("env-utils: isSafeEnvVarKey rejects a key carrying a newline-injected second pair", () => {
	assert.equal(isSafeEnvVarKey("KEY=v\nOTHER"), false);
});

test("env-utils: isSafeEnvVarKey rejects leading digits, spaces, and empty keys", () => {
	assert.equal(isSafeEnvVarKey("1KEY"), false);
	assert.equal(isSafeEnvVarKey("MY KEY"), false);
	assert.equal(isSafeEnvVarKey(""), false);
});

// ─── isSecuritySensitiveEnvKey ────────────────────────────────────────────────

test("env-utils: isSecuritySensitiveEnvKey flags the module-loading RCE chain", () => {
	for (const key of ["GSD_WORKFLOW_EXECUTORS_MODULE", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]) {
		assert.equal(isSecuritySensitiveEnvKey(key), true, `${key} should be blocked`);
	}
});

test("env-utils: isSecuritySensitiveEnvKey is case-insensitive", () => {
	assert.equal(isSecuritySensitiveEnvKey("path"), true);
	assert.equal(isSecuritySensitiveEnvKey("Node_Options"), true);
});

test("env-utils: isSecuritySensitiveEnvKey allows ordinary secrets", () => {
	assert.equal(isSecuritySensitiveEnvKey("OPENAI_API_KEY"), false);
	assert.equal(isSecuritySensitiveEnvKey("DATABASE_URL"), false);
});

// ─── resolveProjectEnvFilePath ────────────────────────────────────────────────

test("env-utils: resolveProjectEnvFilePath allows .env under the project root", () => {
	const tmp = makeTempDir("env-path");
	try {
		assert.equal(resolveProjectEnvFilePath(tmp, ".env"), join(realpathSync.native(tmp), ".env"));
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: resolveProjectEnvFilePath rejects a relative path escaping the project root", () => {
	const tmp = makeTempDir("env-path");
	try {
		assert.throws(() => resolveProjectEnvFilePath(tmp, "../outside.env"), /inside the project directory/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: resolveProjectEnvFilePath rejects an absolute path outside the project root", () => {
	const tmp = makeTempDir("env-path");
	const outside = makeTempDir("env-path-outside");
	try {
		assert.throws(
			() => resolveProjectEnvFilePath(tmp, join(outside, "stolen.env")),
			/inside the project directory/,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("env-utils: resolveProjectEnvFilePath rejects a symlinked parent directory that escapes", () => {
	const tmp = makeTempDir("env-path");
	const outside = makeTempDir("env-path-outside");
	try {
		symlinkSync(outside, join(tmp, "linked-outside"), "dir");
		assert.throws(
			() => resolveProjectEnvFilePath(tmp, "linked-outside/.env"),
			/inside the project directory/,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("env-utils: resolveProjectEnvFilePath rejects an existing .env symlinked outside the root", () => {
	const tmp = makeTempDir("env-path");
	const outside = makeTempDir("env-path-outside");
	try {
		writeFileSync(join(outside, ".env"), "SECRET=outside\n");
		symlinkSync(join(outside, ".env"), join(tmp, ".env"));
		assert.throws(() => resolveProjectEnvFilePath(tmp, ".env"), /inside the project directory/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

// ─── writeEnvKey ──────────────────────────────────────────────────────────────

test("env-utils: writeEnvKey creates the .env file owner-readable only", async () => {
	const tmp = makeTempDir("write");
	try {
		const envPath = join(tmp, ".env");
		await writeEnvKey(envPath, "NEW_KEY", "new-value");
		assert.equal(readFileSync(envPath, "utf8").includes("NEW_KEY=new-value"), true);
		assert.equal(statSync(envPath).mode & 0o777, 0o600);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: writeEnvKey updates an existing key in place", async () => {
	const tmp = makeTempDir("write");
	try {
		const envPath = join(tmp, ".env");
		writeFileSync(envPath, "EXISTING=old\nOTHER=keep\n");
		await writeEnvKey(envPath, "EXISTING", "new");
		const content = readFileSync(envPath, "utf8");
		assert.equal(content.includes("EXISTING=new"), true);
		assert.equal(content.includes("OTHER=keep"), true);
		assert.equal(content.includes("old"), false);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: writeEnvKey escapes newlines in values", async () => {
	const tmp = makeTempDir("write");
	try {
		const envPath = join(tmp, ".env");
		await writeEnvKey(envPath, "MULTI", "line1\nline2");
		assert.equal(readFileSync(envPath, "utf8").includes("MULTI=line1\\nline2"), true);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: writeEnvKey rejects non-string values", async () => {
	const tmp = makeTempDir("write");
	try {
		await assert.rejects(
			() => writeEnvKey(join(tmp, ".env"), "KEY", undefined as unknown as string),
			/expects a string value/,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: writeEnvKey refuses to follow a symlinked env file", async () => {
	const tmp = makeTempDir("write");
	const outside = makeTempDir("write-outside");
	try {
		const outsideEnv = join(outside, ".env");
		writeFileSync(outsideEnv, "SECRET=outside\n");
		symlinkSync(outsideEnv, join(tmp, ".env"));

		await assert.rejects(
			() => writeEnvKey(join(tmp, ".env"), "SECRET", "inside"),
			/ELOOP|symbolic link|symlink/i,
		);
		assert.equal(readFileSync(outsideEnv, "utf8"), "SECRET=outside\n");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});
