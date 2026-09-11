/**
 * Regression tests for getToolPath's managed-binary probe.
 *
 * A managed binary can be present but unusable — an interrupted extract or a
 * restrictive umask leaves ~/.gsd/agent/bin/rg as mode 0644. Returning that
 * path makes every grep/find tool call die with EACCES even when a perfectly
 * good rg/fd is on PATH, so existence alone is not enough to select it.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ENV_AGENT_DIR } from "../config.js";

// The executable bit is a POSIX concept; on Windows the managed binary is an
// .exe selected by existence alone, so there is nothing to assert here.
const skipOnWindows = process.platform === "win32" ? "POSIX executable-bit semantics" : false;

const agentDir = mkdtempSync(join(tmpdir(), "gsd-tools-manager-"));
const binDir = join(agentDir, "bin");
const pathStubDir = join(agentDir, "path-stubs");
mkdirSync(binDir, { recursive: true });
mkdirSync(pathStubDir, { recursive: true });

function writeStub(path: string, mode: number): string {
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, mode);
	return path;
}

const managedRg = writeStub(join(binDir, "rg"), 0o644);
const managedFd = writeStub(join(binDir, "fd"), 0o755);
writeStub(join(pathStubDir, "rg"), 0o755);

const originalAgentDir = process.env[ENV_AGENT_DIR];
const originalPath = process.env.PATH;

// TOOLS_DIR is captured when tools-manager is first imported, so the agent dir
// has to be redirected before the dynamic import below.
process.env[ENV_AGENT_DIR] = agentDir;
process.env.PATH = pathStubDir + delimiter + (originalPath ?? "");

const { getToolPath } = await import("./tools-manager.js");

after(() => {
	if (originalAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = originalAgentDir;
	}
	process.env.PATH = originalPath;
	rmSync(agentDir, { recursive: true, force: true });
});

test("falls back to PATH when the managed binary is not executable", { skip: skipOnWindows }, () => {
	const resolved = getToolPath("rg");
	assert.notEqual(resolved, managedRg, "non-executable managed binary must not be selected");
	assert.equal(resolved, "rg");
});

test("returns the managed binary when it is executable", { skip: skipOnWindows }, () => {
	assert.equal(getToolPath("fd"), managedFd);
});

test("returns null rather than an unusable managed binary when PATH has no fallback", { skip: skipOnWindows }, () => {
	const emptyDir = join(agentDir, "empty-path");
	mkdirSync(emptyDir, { recursive: true });
	process.env.PATH = emptyDir;
	try {
		assert.equal(getToolPath("rg"), null);
	} finally {
		process.env.PATH = pathStubDir + delimiter + (originalPath ?? "");
	}
});
