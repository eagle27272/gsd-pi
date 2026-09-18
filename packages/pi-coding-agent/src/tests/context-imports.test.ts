// @gsd/pi-coding-agent + context-imports.test — coverage for Claude Code style
// `@path` references inside context files (CLAUDE.md / AGENTS.md).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expandContextImports } from "../core/context-imports.js";

function withTempDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "context-imports-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("imports a sibling file referenced with @", () => {
	withTempDir((dir) => {
		const root = join(dir, "CLAUDE.md");
		const imported = join(dir, "RTK.md");
		writeFileSync(root, "Header\n\n@RTK.md\n");
		writeFileSync(imported, "# RTK\n");

		const result = expandContextImports({ path: root, content: "Header\n\n@RTK.md\n" });

		assert.deepEqual(result, [{ path: imported, content: "# RTK\n" }]);
	});
});

test("follows imports transitively, parents before children", () => {
	withTempDir((dir) => {
		writeFileSync(join(dir, "a.md"), "@b.md\n");
		writeFileSync(join(dir, "b.md"), "leaf\n");

		const result = expandContextImports({ path: join(dir, "CLAUDE.md"), content: "@a.md\n" });

		assert.deepEqual(
			result.map((f) => f.path),
			[join(dir, "a.md"), join(dir, "b.md")],
		);
	});
});

test("stops after five levels of imports", () => {
	withTempDir((dir) => {
		const names = ["1.md", "2.md", "3.md", "4.md", "5.md", "6.md"];
		names.forEach((name, index) => {
			const next = names[index + 1];
			writeFileSync(join(dir, name), next ? `@${next}\n` : "deepest\n");
		});

		const result = expandContextImports({ path: join(dir, "CLAUDE.md"), content: "@1.md\n" });

		assert.deepEqual(
			result.map((f) => f.path),
			names.slice(0, 5).map((name) => join(dir, name)),
		);
	});
});

test("emits each file once when imports form a cycle", () => {
	withTempDir((dir) => {
		writeFileSync(join(dir, "a.md"), "@b.md\n");
		writeFileSync(join(dir, "b.md"), "@a.md\n");

		const result = expandContextImports({ path: join(dir, "CLAUDE.md"), content: "@a.md\n" });

		assert.deepEqual(
			result.map((f) => f.path),
			[join(dir, "a.md"), join(dir, "b.md")],
		);
	});
});

test("ignores references inside a fenced code block", () => {
	withTempDir((dir) => {
		writeFileSync(join(dir, "a.md"), "should not load\n");
		const content = ["Example:", "", "```markdown", "@a.md", "```", ""].join("\n");

		const result = expandContextImports({ path: join(dir, "CLAUDE.md"), content });

		assert.deepEqual(result, []);
	});
});

test("ignores references inside an inline code span", () => {
	withTempDir((dir) => {
		writeFileSync(join(dir, "a.md"), "should not load\n");

		const result = expandContextImports({
			path: join(dir, "CLAUDE.md"),
			content: "Write `see @a.md here` to import it.\n",
		});

		assert.deepEqual(result, []);
	});
});

test("imports a reference followed by sentence punctuation", () => {
	withTempDir((dir) => {
		writeFileSync(join(dir, "a.md"), "loaded\n");

		const result = expandContextImports({
			path: join(dir, "CLAUDE.md"),
			content: "Conventions live in @a.md.\n",
		});

		assert.deepEqual(
			result.map((f) => f.path),
			[join(dir, "a.md")],
		);
	});
});

test("skips a file already recorded in the shared seen set", () => {
	withTempDir((dir) => {
		writeFileSync(join(dir, "a.md"), "already loaded\n");

		const result = expandContextImports(
			{ path: join(dir, "CLAUDE.md"), content: "@a.md\n" },
			new Set([join(dir, "a.md")]),
		);

		assert.deepEqual(result, []);
	});
});

test("expands a ~/ reference against the home directory", () => {
	withTempDir((dir) => {
		const home = join(dir, "home");
		mkdirSync(home);
		writeFileSync(join(home, "notes.md"), "from home\n");
		const originalHome = process.env.HOME;
		process.env.HOME = home;

		try {
			const result = expandContextImports({
				path: join(dir, "project", "CLAUDE.md"),
				content: "@~/notes.md\n",
			});

			assert.deepEqual(result, [{ path: join(home, "notes.md"), content: "from home\n" }]);
		} finally {
			process.env.HOME = originalHome;
		}
	});
});

test("leaves an email address alone", () => {
	withTempDir((dir) => {
		const result = expandContextImports({
			path: join(dir, "CLAUDE.md"),
			content: "Ask docs@example.com for access.\n",
		});

		assert.deepEqual(result, []);
	});
});

test("ignores a reference that points at nothing", () => {
	withTempDir((dir) => {
		const result = expandContextImports({ path: join(dir, "CLAUDE.md"), content: "@missing.md\n" });

		assert.deepEqual(result, []);
	});
});

test("ignores a reference that points at a directory", () => {
	withTempDir((dir) => {
		mkdirSync(join(dir, "docs"));

		const result = expandContextImports({ path: join(dir, "CLAUDE.md"), content: "@docs\n" });

		assert.deepEqual(result, []);
	});
});
