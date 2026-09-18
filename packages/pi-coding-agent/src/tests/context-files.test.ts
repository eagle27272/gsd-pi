// @gsd/pi-coding-agent + context-files.test — coverage for which context files
// loadProjectContextFiles() discovers and in what order.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadProjectContextFiles } from "../core/resource-loader.js";

function withTempEnv(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "context-files-"));
	const originalHome = process.env.HOME;
	const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
	// The ancestor walk would otherwise reach the real home directory's files.
	process.env.HOME = join(dir, "home");
	mkdirSync(process.env.HOME, { recursive: true });
	delete process.env.CLAUDE_CONFIG_DIR;

	try {
		fn(dir);
	} finally {
		process.env.HOME = originalHome;
		if (originalConfigDir === undefined) {
			delete process.env.CLAUDE_CONFIG_DIR;
		} else {
			process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
		}
		rmSync(dir, { recursive: true, force: true });
	}
}

function makeFile(path: string, content: string): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
	return path;
}

test("loads the user CLAUDE.md from CLAUDE_CONFIG_DIR before project files", () => {
	withTempEnv((dir) => {
		const userFile = makeFile(join(dir, "claude-config", "CLAUDE.md"), "user memory\n");
		process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
		const projectFile = makeFile(join(dir, "project", "AGENTS.md"), "project rules\n");

		const files = loadProjectContextFiles({ cwd: join(dir, "project") });

		assert.deepEqual(
			files.map((f) => f.path),
			[userFile, projectFile],
		);
	});
});

test("defaults the user context file to ~/.claude/CLAUDE.md", () => {
	withTempEnv((dir) => {
		const userFile = makeFile(join(dir, "home", ".claude", "CLAUDE.md"), "user memory\n");

		const files = loadProjectContextFiles({ cwd: join(dir, "project") });

		assert.deepEqual(
			files.map((f) => f.path),
			[userFile],
		);
	});
});

test("places each file's imports directly after it", () => {
	withTempEnv((dir) => {
		const userFile = makeFile(join(dir, "home", ".claude", "CLAUDE.md"), "@RTK.md\n");
		const userImport = makeFile(join(dir, "home", ".claude", "RTK.md"), "rtk\n");
		const projectFile = makeFile(join(dir, "project", "AGENTS.md"), "@style.md\n");
		const projectImport = makeFile(join(dir, "project", "style.md"), "style\n");

		const files = loadProjectContextFiles({ cwd: join(dir, "project") });

		assert.deepEqual(
			files.map((f) => f.path),
			[userFile, userImport, projectFile, projectImport],
		);
	});
});

test("does not repeat a context file that another file also imports", () => {
	withTempEnv((dir) => {
		const parentFile = makeFile(join(dir, "project", "CLAUDE.md"), "parent rules\n");
		const childFile = makeFile(join(dir, "project", "nested", "CLAUDE.md"), "@../CLAUDE.md\n");

		const files = loadProjectContextFiles({ cwd: join(dir, "project", "nested") });

		assert.deepEqual(
			files.map((f) => f.path),
			[parentFile, childFile],
		);
	});
});
