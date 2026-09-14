import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function tsFilesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsFilesUnder(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

const SUPPRESSION = ["@ts", "nocheck"].join("-");
const SELF = fileURLToPath(import.meta.url);

test("no @ts-nocheck under modes/interactive", () => {
	const offenders = tsFilesUnder(HERE)
		.filter((f) => f !== SELF)
		.filter((f) => readFileSync(f, "utf8").includes(SUPPRESSION));
	assert.deepEqual(
		offenders.map((f) => f.slice(HERE.length + 1)),
		[],
		"the delegate seam is type-checked; suppressing it hides real defects (see #89)",
	);
});

test("the delegate host type is derived from InteractiveMode, not `any`", () => {
	const src = readFileSync(join(HERE, "interactive-mode-delegate-host.ts"), "utf8");
	assert.match(src, /export type InteractiveModeDelegateHost = InteractiveMode;/);
	assert.doesNotMatch(src, /=\s*any\s*;/);
});
