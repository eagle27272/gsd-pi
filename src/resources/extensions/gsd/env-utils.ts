// GSD Extension — Environment variable utilities
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
//
// Pure utilities for reading and writing env vars: checking existing keys,
// validating key names, containing env file paths to the project, and writing
// values to a .env file. Extracted from get-secrets-from-user.ts to avoid
// pulling in @gsd/pi-tui when only env handling is needed (e.g. from files.ts
// during report generation).
//
// The write path here must stay in step with the MCP server's
// packages/mcp-server/src/env-writer.ts — both back the same secure_env_collect
// promise to the user, so both need the same guarantees (#10).

import { open, readFile, rename, rm } from "node:fs/promises";
import { constants, existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Check which keys already exist in a .env file or process.env.
 * Returns the subset of `keys` that are already set.
 */
export async function checkExistingEnvKeys(keys: string[], envFilePath: string): Promise<string[]> {
	let fileContent = "";
	try {
		fileContent = await readFile(envFilePath, "utf8");
	} catch {
		// ENOENT or other read error — proceed with empty content
	}

	const existing: string[] = [];
	for (const key of keys) {
		const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`^${escaped}\\s*=`, "m");
		if (regex.test(fileContent) || key in process.env) {
			existing.push(key);
		}
	}
	return existing;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function isSafeEnvVarKey(key: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/**
 * Keys that influence the agent's own runtime — module loading, project
 * sandbox, CLI resolution. Allowing the LLM to set these via secure_env_collect
 * would let a misbehaving caller swap the workflow executor module mid-session
 * (RCE chain) or escape the project sandbox. We refuse to write or hydrate
 * these keys even when isSafeEnvVarKey() would otherwise accept them.
 */
const SECURITY_SENSITIVE_KEYS = new Set<string>([
	"GSD_WORKFLOW_EXECUTORS_MODULE",
	"GSD_WORKFLOW_WRITE_GATE_MODULE",
	"GSD_WORKFLOW_PROJECT_ROOT",
	"GSD_CLI_PATH",
	"NODE_OPTIONS",
	"NODE_PATH",
	"PATH",
	"LD_PRELOAD",
	"DYLD_INSERT_LIBRARIES",
]);

export function isSecuritySensitiveEnvKey(key: string): boolean {
	return SECURITY_SENSITIVE_KEYS.has(key.toUpperCase());
}

export function isSupportedDeploymentEnvironment(env: string): boolean {
	return env === "development" || env === "preview" || env === "production";
}

// ─── Path containment ─────────────────────────────────────────────────────────

function isWithinProjectRoot(projectRoot: string, candidatePath: string): boolean {
	const rel = relative(projectRoot, candidatePath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a caller-supplied env file path against the project directory,
 * refusing anything that lands outside it. Checks the real path of the target
 * when it exists and of its parent when it does not, so neither an absolute
 * path, a `../` escape, nor a symlink can redirect the write.
 */
export function resolveProjectEnvFilePath(projectDir: string, envFilePath = ".env"): string {
	const projectRoot = realpathSync.native(resolve(projectDir));
	const candidate = resolve(projectRoot, envFilePath);
	if (!isWithinProjectRoot(projectRoot, candidate)) {
		throw new Error("envFilePath must resolve inside the project directory");
	}
	if (existsSync(candidate)) {
		if (isWithinProjectRoot(projectRoot, realpathSync.native(candidate))) {
			return candidate;
		}
		throw new Error("envFilePath must resolve inside the project directory");
	}
	if (isWithinProjectRoot(projectRoot, realpathSync.native(dirname(candidate)))) {
		return candidate;
	}
	throw new Error("envFilePath must resolve inside the project directory");
}

// ─── writeEnvKey ──────────────────────────────────────────────────────────────

function assertWritableEnvFileTarget(filePath: string): void {
	try {
		if (lstatSync(filePath).isSymbolicLink()) {
			throw new Error("Refusing to write symlinked env file");
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw err;
	}
}

/**
 * Write a single key=value pair to a .env file.
 * Updates existing keys in-place, appends new ones at the end.
 *
 * The file is staged in a 0600 temp file and renamed into place so a secret is
 * never briefly world-readable, and both the read and the rename refuse to
 * follow a symlink planted at the target path.
 */
export async function writeEnvKey(filePath: string, key: string, value: string): Promise<void> {
	if (typeof value !== "string") {
		throw new TypeError(`writeEnvKey expects a string value for key "${key}", got ${typeof value}`);
	}
	assertWritableEnvFileTarget(filePath);
	let content = "";
	try {
		const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			content = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw err;
		}
		content = "";
	}
	const escaped = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "");
	const line = `${key}=${escaped}`;
	const regex = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`, "m");
	if (regex.test(content)) {
		content = content.replace(regex, line);
	} else {
		if (content.length > 0 && !content.endsWith("\n")) content += "\n";
		content += `${line}\n`;
	}
	const tempPath = join(
		dirname(filePath),
		`.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		await handle.writeFile(content, "utf8");
		await handle.close();
		handle = undefined;
		assertWritableEnvFileTarget(filePath);
		await rename(tempPath, filePath);
	} catch (err) {
		if (handle) {
			try {
				await handle.close();
			} catch {
				// Best-effort cleanup.
			}
		}
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw err;
	}
}
