/**
 * Hardening tests for the extension-side env write primitives.
 *
 * These mirror packages/mcp-server/src/env-writer.test.ts — both sides back the
 * same secure_env_collect promise ("written directly to the project, never
 * shown to the AI"), so both need the same guarantees (#10).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";

import {
	checkExistingEnvKeys,
	hydrateProcessEnv,
	isSafeEnvVarKey,
	isSecuritySensitiveEnvKey,
	resolveProjectEnvFilePath,
	writeEnvKey,
} from "../env-utils.ts";

/** A temp dir that looks like a real project — resolveProjectEnvFilePath requires a marker. */
function makeTempDir(prefix: string): string {
	const dir = makeBareTempDir(prefix);
	writeFileSync(join(dir, "package.json"), "{}");
	return dir;
}

/** A temp dir with no project marker, for the cases that must be refused. */
function makeBareTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Read a key back the way a `set -a; source .env` consumer would. */
function sourceEnvValue(envPath: string, key: string): string {
	const script = `set -a; . "$1"; set +a; printf %s "$${key}"`;
	return execFileSync("/bin/sh", ["-c", script, "sh", envPath], { encoding: "utf8" });
}

const posixOnly = { skip: process.platform === "win32" ? "POSIX shell only" : false };

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

test("env-utils: resolveProjectEnvFilePath rejects a destination that is not a .env-family file", () => {
	const tmp = makeTempDir("env-path");
	try {
		for (const name of [".bashrc", ".envrc", "profile", "src/index.ts"]) {
			assert.throws(() => resolveProjectEnvFilePath(tmp, name), /\.env/, name);
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: resolveProjectEnvFilePath refuses a symlink whose target is not a .env file", () => {
	const tmp = makeTempDir("env-path");
	try {
		// `.envrc` is executed by direnv on `cd`, and the name check only ever
		// sees the link.
		writeFileSync(join(tmp, ".envrc"), "export FOO=1\n");
		symlinkSync(join(tmp, ".envrc"), join(tmp, ".env"));
		assert.throws(() => resolveProjectEnvFilePath(tmp, ".env"), /\.env/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: resolveProjectEnvFilePath refuses git-tracked placeholder env files", () => {
	const tmp = makeTempDir("env-path");
	try {
		for (const name of [".env.example", ".env.sample", ".env.template", ".env.dist", ".env.EXAMPLE"]) {
			assert.throws(() => resolveProjectEnvFilePath(tmp, name), /\.env/, name);
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: resolveProjectEnvFilePath refuses an alternate-data-stream suffix", () => {
	const tmp = makeTempDir("env-path");
	try {
		for (const name of [".env.local:evil", ".env::$DATA"]) {
			assert.throws(() => resolveProjectEnvFilePath(tmp, name), /\.env/, name);
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: resolveProjectEnvFilePath refuses a filesystem root as the project root", () => {
	assert.throws(() => resolveProjectEnvFilePath(parse(process.cwd()).root, ".env"), /filesystem root/i);
});

test("env-utils: resolveProjectEnvFilePath refuses a directory with no project marker above it", () => {
	const parent = makeBareTempDir("no-marker");
	const savedHome = process.env.HOME;
	const savedProfile = process.env.USERPROFILE;
	try {
		const proj = join(parent, "proj");
		mkdirSync(proj);
		// Pin HOME to the parent so the upward search terminates here rather than
		// at whatever happens to sit above the system temp directory.
		process.env.HOME = parent;
		process.env.USERPROFILE = parent;
		assert.throws(() => resolveProjectEnvFilePath(proj, ".env"), /project/i);
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = savedProfile;
		rmSync(parent, { recursive: true, force: true });
	}
});

test("env-utils: resolveProjectEnvFilePath accepts a subdirectory of a marked project", () => {
	const tmp = makeTempDir("env-path");
	try {
		const nested = join(tmp, "apps", "web");
		mkdirSync(nested, { recursive: true });
		assert.equal(
			resolveProjectEnvFilePath(nested, ".env"),
			join(realpathSync.native(tmp), "apps", "web", ".env"),
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: resolveProjectEnvFilePath accepts a git worktree, whose .git is a file", () => {
	const tmp = makeBareTempDir("worktree");
	try {
		writeFileSync(join(tmp, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
		assert.equal(resolveProjectEnvFilePath(tmp, ".env"), join(realpathSync.native(tmp), ".env"));
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: resolveProjectEnvFilePath accepts the .env family inside a subdirectory", () => {
	const tmp = makeTempDir("env-path");
	try {
		mkdirSync(join(tmp, "config"));
		const root = realpathSync.native(tmp);
		assert.equal(resolveProjectEnvFilePath(tmp, ".env.local"), join(root, ".env.local"));
		assert.equal(
			resolveProjectEnvFilePath(tmp, "config/.env.production"),
			join(root, "config", ".env.production"),
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: resolveProjectEnvFilePath refuses the home directory as a project root", () => {
	const tmp = makeTempDir("env-path");
	const savedHome = process.env.HOME;
	const savedProfile = process.env.USERPROFILE;
	try {
		process.env.HOME = tmp;
		process.env.USERPROFILE = tmp;
		assert.throws(() => resolveProjectEnvFilePath(tmp, ".env"), /home directory/i);
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = savedProfile;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: resolveProjectEnvFilePath resolves an in-root symlink to its target", async () => {
	const tmp = makeTempDir("env-path");
	try {
		mkdirSync(join(tmp, "config"));
		const target = join(tmp, "config", ".env.local");
		writeFileSync(target, "EXISTING=1\n");
		symlinkSync(target, join(tmp, ".env"));

		const resolved = resolveProjectEnvFilePath(tmp, ".env");
		assert.equal(resolved, realpathSync.native(target));

		await writeEnvKey(resolved, "ADDED", "value");
		assert.equal(readFileSync(target, "utf8").includes("ADDED="), true);
		assert.equal(lstatSync(join(tmp, ".env")).isSymbolicLink(), true);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── checkExistingEnvKeys ─────────────────────────────────────────────────────

test("env-utils: checkExistingEnvKeys rethrows read errors other than ENOENT", async () => {
	const tmp = makeTempDir("env-check");
	try {
		await assert.rejects(() => checkExistingEnvKeys(["ANY_KEY"], tmp), /EISDIR|EPERM|EACCES/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: checkExistingEnvKeys ignores process.env entries this process hydrated", async () => {
	const tmp = makeTempDir("env-check");
	const key = "GSD_EXT_HYDRATED_ONLY_KEY";
	try {
		hydrateProcessEnv(key, "v1");
		assert.deepStrictEqual(await checkExistingEnvKeys([key], join(tmp, ".env")), []);
	} finally {
		delete process.env[key];
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── writeEnvKey ──────────────────────────────────────────────────────────────

test("env-utils: writeEnvKey creates the .env file owner-readable only", async () => {
	const tmp = makeTempDir("write");
	try {
		const envPath = join(tmp, ".env");
		await writeEnvKey(envPath, "NEW_KEY", "new-value");
		assert.equal(readFileSync(envPath, "utf8").includes("NEW_KEY='new-value'"), true);
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
		assert.equal(content.includes("EXISTING='new'"), true);
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
		assert.equal(readFileSync(envPath, "utf8").includes("MULTI='line1\\nline2'"), true);
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

test("env-utils: writeEnvKey updates every definition of a duplicated key", async () => {
	const tmp = makeTempDir("write");
	try {
		const envPath = join(tmp, ".env");
		writeFileSync(envPath, "DUP=first\nOTHER=keep\nDUP=last\n");
		await writeEnvKey(envPath, "DUP", "fresh");
		const content = readFileSync(envPath, "utf8");
		// dotenv and `source` both honour the last definition.
		assert.equal(content.includes("last"), false, content);
		assert.equal(content.includes("first"), false, content);
		assert.equal(content.includes("OTHER=keep"), true);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: writeEnvKey writes a value containing a replacement pattern literally", async () => {
	const tmp = makeTempDir("write");
	try {
		const envPath = join(tmp, ".env");
		writeFileSync(envPath, "TOKEN=old\n");
		await writeEnvKey(envPath, "TOKEN", "a$&b$`c");
		assert.equal(readFileSync(envPath, "utf8").includes("a$&b$`c"), true);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: writeEnvKey round-trips a password with $ and a backtick through `source`", posixOnly, async () => {
	const tmp = makeTempDir("quote");
	try {
		const envPath = join(tmp, ".env");
		const password = 'pa$$w`ord!x';
		await writeEnvKey(envPath, "DB_PASSWORD", password);
		assert.equal(sourceEnvValue(envPath, "DB_PASSWORD"), password);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: writeEnvKey round-trips a value containing a single quote", posixOnly, async () => {
	const tmp = makeTempDir("quote");
	try {
		const envPath = join(tmp, ".env");
		const value = "it's-a-token";
		await writeEnvKey(envPath, "TOKEN", value);
		assert.equal(sourceEnvValue(envPath, "TOKEN"), value);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("env-utils: writeEnvKey single-quotes ordinary values so dotenv reads them verbatim", async () => {
	const tmp = makeTempDir("quote");
	try {
		const envPath = join(tmp, ".env");
		await writeEnvKey(envPath, "API_KEY", "sk-abc$123");
		assert.equal(readFileSync(envPath, "utf8"), "API_KEY='sk-abc$123'\n");
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
