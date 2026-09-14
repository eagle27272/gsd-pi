import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createFindToolDefinition } from "./find.js";

/**
 * These tests replace fd with a stub on PATH so the failure modes a real fd
 * only reaches under memory pressure (dying mid-traversal) are reproducible.
 */
let binDir: string;
let savedPath: string | undefined;

function installFakeFd(body: string): void {
	const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "fd 10.5.0"; exit 0; fi
for arg in "$@"; do searchPath="$arg"; done
${body}
`;
	const target = join(binDir, "fd");
	writeFileSync(target, script);
	chmodSync(target, 0o755);
}

before(() => {
	binDir = mkdtempSync(join(tmpdir(), "pi-find-bin-"));
	savedPath = process.env.PATH;
	process.env.PATH = `${binDir}:${savedPath ?? ""}`;
});

after(() => {
	if (savedPath === undefined) delete process.env.PATH;
	else process.env.PATH = savedPath;
	rmSync(binDir, { recursive: true, force: true });
});

function runFind(args: { pattern: string; path?: string }): Promise<{ content: Array<{ text?: string }> }> {
	const def = createFindToolDefinition(process.cwd());
	const ctx = {} as Parameters<typeof def.execute>[4];
	return def.execute("call-1", args, undefined, undefined, ctx) as Promise<{ content: Array<{ text?: string }> }>;
}

test("returns the listing when fd exits cleanly", async () => {
	installFakeFd('printf "%s\\n" "${searchPath}/alpha.ts" "${searchPath}/beta.ts"; exit 0');

	const result = await runFind({ pattern: "*.ts", path: "/srv/project" });

	assert.equal(result.content[0]?.text, "alpha.ts\nbeta.ts");
});

test("rejects when fd dies from a signal after emitting a partial listing", async () => {
	installFakeFd('printf "%s\\n" "${searchPath}/alpha.ts"; kill -TERM $$');

	await assert.rejects(() => runFind({ pattern: "*.ts", path: "/srv/project" }));
});

test("rejects when fd exits non-zero after emitting a partial listing", async () => {
	installFakeFd('printf "%s\\n" "${searchPath}/alpha.ts"; echo "fd: traversal aborted" >&2; exit 2');

	await assert.rejects(() => runFind({ pattern: "*.ts", path: "/srv/project" }), /traversal aborted/);
});

test("relativizes results against the filesystem root without dropping a character", async () => {
	installFakeFd('printf "%s\\n" "/etc/hosts"; exit 0');

	const result = await runFind({ pattern: "hosts", path: "/" });

	assert.equal(result.content[0]?.text, "etc/hosts");
});
