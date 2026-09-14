import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createGrepToolDefinition } from "./grep.js";

let searchDir: string;

before(() => {
	searchDir = mkdtempSync(join(tmpdir(), "pi-grep-"));
	writeFileSync(join(searchDir, "haystack.txt"), "needle\n");
});

after(() => {
	rmSync(searchDir, { recursive: true, force: true });
});

function runGrep(signal?: AbortSignal): Promise<unknown> {
	const def = createGrepToolDefinition(searchDir);
	const ctx = {} as Parameters<typeof def.execute>[4];
	return def.execute("call-1", { pattern: "needle" }, signal, undefined, ctx);
}

test("finds matches in the search path", async () => {
	const result = (await runGrep()) as { content: Array<{ text?: string }> };

	assert.match(result.content[0]?.text ?? "", /haystack\.txt:1: needle/);
});

test("honours an abort raised before ripgrep is resolved", async () => {
	const controller = new AbortController();

	const promise = runGrep(controller.signal);
	controller.abort();

	await assert.rejects(() => promise, /aborted/i);
});

test("honours an abort raised before execute is called", async () => {
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(() => runGrep(controller.signal), /aborted/i);
});
