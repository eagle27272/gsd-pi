import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Built from parts so this file is not its own counterexample. The test runs
 * both from source and from the dist-test copy, which holds .ts and .js side
 * by side, so self-exclusion matches on the stem rather than the extension.
 */
const SUPPRESSION = ["@ts", "nocheck"].join("-");
const SELF_STEM = basename(fileURLToPath(import.meta.url)).replace(/\.(ts|js)$/, "");

function tsFilesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsFilesUnder(full));
		else if (entry.name.endsWith(".ts") && !entry.name.startsWith(SELF_STEM)) out.push(full);
	}
	return out;
}

test("the interactive delegate modules are all type-checked", () => {
	const offenders = tsFilesUnder(HERE).filter((f) => readFileSync(f, "utf8").includes(SUPPRESSION));
	assert.deepEqual(
		offenders.map((f) => f.slice(HERE.length + 1)),
		[],
		`suppressing type checking here hides real defects; see #89`,
	);
});

test("the delegate host type is derived from InteractiveMode, not `any`", () => {
	const src = readFileSync(join(HERE, "interactive-mode-delegate-host.ts"), "utf8");
	assert.match(src, /export type InteractiveModeDelegateHost = InteractiveMode;/);
	assert.doesNotMatch(src, /=\s*any\s*;/);
});
