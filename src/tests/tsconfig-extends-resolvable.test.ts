// Project/App: gsd-pi
// File Purpose: Regression coverage that no tracked tsconfig extends a file missing from the repo.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function findRepoRoot(start: string): string {
	let dir = start;
	for (let i = 0; i < 10; i++) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			if (pkg.name === "gsd-pi" && existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
		} catch {
			// Keep walking.
		}
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`Could not locate repo root from ${start}`);
}

const projectRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

function trackedTsconfigs(): string[] {
	const out = execFileSync("git", ["ls-files", "*tsconfig*.json"], {
		cwd: projectRoot,
		encoding: "utf8",
	});
	return out.split("\n").filter(Boolean);
}

// tsc allows `//` line comments and trailing commas in tsconfig; JSON.parse does not.
function parseTsconfig(text: string): { extends?: string | string[] } {
	const stripped = text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(stripped);
}

test("every tracked tsconfig extends a file that exists", () => {
	const dangling: string[] = [];

	for (const file of trackedTsconfigs()) {
		const config = parseTsconfig(readFileSync(join(projectRoot, file), "utf8"));
		if (!config.extends) continue;

		const targets = Array.isArray(config.extends) ? config.extends : [config.extends];
		for (const target of targets) {
			// Bare specifiers resolve through node_modules, which this check does not model.
			if (!target.startsWith(".")) continue;
			const resolved = resolve(projectRoot, dirname(file), target);
			const candidates = resolved.endsWith(".json") ? [resolved] : [resolved, `${resolved}.json`];
			if (!candidates.some((candidate) => existsSync(candidate))) {
				dangling.push(`${file} -> ${target}`);
			}
		}
	}

	assert.deepEqual(
		dangling,
		[],
		`tsconfigs extend files that do not exist; creating those filenames would silently activate stale configs:\n  ${dangling.join("\n  ")}`,
	);
});
