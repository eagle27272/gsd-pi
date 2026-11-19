import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadProjectContextFiles } from "./resource-loader.ts";

describe("loadProjectContextFiles inside a linked git worktree nested in its main checkout", () => {
	let root: string;
	let mainCheckout: string;
	let worktree: string;
	let previousConfigDir: string | undefined;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-context-worktree-")));
		mainCheckout = join(root, "repo");
		worktree = join(mainCheckout, ".gsd-worktrees", "M001");
		mkdirSync(join(mainCheckout, ".git", "worktrees", "M001"), { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), `gitdir: ${join(mainCheckout, ".git", "worktrees", "M001")}\n`);

		previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
		const emptyConfigDir = join(root, "claude-config");
		mkdirSync(emptyConfigDir);
		process.env.CLAUDE_CONFIG_DIR = emptyConfigDir;
	});

	afterEach(() => {
		if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
		rmSync(root, { recursive: true, force: true });
	});

	it("loads the worktree's own context file once instead of also loading the main checkout's copy", () => {
		writeFileSync(join(mainCheckout, "CLAUDE.md"), "main copy");
		writeFileSync(join(worktree, "CLAUDE.md"), "worktree copy");

		const files = loadProjectContextFiles({ cwd: worktree });

		assert.deepEqual(
			files.map((file) => file.path),
			[join(worktree, "CLAUDE.md")],
		);
	});

	it("still loads the main checkout's context file when the worktree has none of its own", () => {
		writeFileSync(join(mainCheckout, "CLAUDE.md"), "untracked main copy");

		const files = loadProjectContextFiles({ cwd: worktree });

		assert.deepEqual(
			files.map((file) => file.path),
			[join(mainCheckout, "CLAUDE.md")],
		);
	});

	it("keeps context files that live above the main checkout", () => {
		writeFileSync(join(root, "AGENTS.md"), "workspace-wide rules");
		writeFileSync(join(mainCheckout, "CLAUDE.md"), "main copy");
		writeFileSync(join(worktree, "CLAUDE.md"), "worktree copy");

		const files = loadProjectContextFiles({ cwd: worktree });

		assert.deepEqual(
			files.map((file) => file.path),
			[join(root, "AGENTS.md"), join(worktree, "CLAUDE.md")],
		);
	});

	it("is unchanged for an ordinary checkout whose parent also has a context file", () => {
		writeFileSync(join(root, "CLAUDE.md"), "parent");
		writeFileSync(join(mainCheckout, "CLAUDE.md"), "repo");

		const files = loadProjectContextFiles({ cwd: mainCheckout });

		assert.deepEqual(
			files.map((file) => file.path),
			[join(root, "CLAUDE.md"), join(mainCheckout, "CLAUDE.md")],
		);
	});
});
