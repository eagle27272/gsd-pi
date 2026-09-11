import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeEditsDiff, generateDiffString } from "../src/core/tools/edit-diff.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-line-ending-scope-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function editFile(content: string, edits: { oldText: string; newText: string }[]): Promise<string> {
	const dir = await createTempDir();
	const file = join(dir, "mixed.txt");
	await writeFile(file, content, "utf-8");
	await createEditToolDefinition(dir).execute("line-ending-scope", { path: file, edits });
	return readFile(file, "utf-8");
}

/** Line numbers a rendered diff marks as added or removed. */
function changedLines(diff: string): number[] {
	const numbers = new Set<number>();
	for (const line of diff.split("\n")) {
		const match = /^[+-]\s*(\d+) /.exec(line);
		if (match) numbers.add(Number(match[1]));
	}
	return [...numbers].sort((a, b) => a - b);
}

// CRLF first, so detectLineEnding reports CRLF and a blanket restore rewrites line 2.
const MIXED = "a\r\nb\nc\r\n";

describe("line ending restoration stays inside the edited region", () => {
	it("leaves an untouched lone LF alone in a mostly-CRLF file", async () => {
		expect(await editFile(MIXED, [{ oldText: "c\n", newText: "C\n" }])).toBe("a\r\nb\nC\r\n");
	});

	it("keeps the edited line's own terminator", async () => {
		expect(await editFile(MIXED, [{ oldText: "b\n", newText: "B\n" }])).toBe("a\r\nB\nc\r\n");
	});

	it("preserves lone CR terminators on untouched lines", async () => {
		expect(await editFile("a\rb\rc\r", [{ oldText: "b\n", newText: "B\n" }])).toBe("a\rB\rc\r");
	});

	it("leaves a CRLF file entirely on CRLF", async () => {
		expect(await editFile("a\r\nb\r\nc\r\n", [{ oldText: "b\n", newText: "B\n" }])).toBe("a\r\nB\r\nc\r\n");
	});

	it("leaves an LF file entirely on LF", async () => {
		expect(await editFile("a\nb\nc\n", [{ oldText: "b\n", newText: "B\n" }])).toBe("a\nB\nc\n");
	});

	it("gives lines the edit introduced the file's prevailing ending", async () => {
		expect(await editFile("a\r\nb\r\nc\r\n", [{ oldText: "b\n", newText: "B\nX\n" }])).toBe("a\r\nB\r\nX\r\nc\r\n");
	});

	it("restores each terminator around several disjoint edits", async () => {
		expect(
			await editFile("a\r\nb\nc\r\nd\ne\r\n", [
				{ oldText: "a\n", newText: "A\n" },
				{ oldText: "e\n", newText: "E\n" },
			]),
		).toBe("A\r\nb\nc\r\nd\nE\r\n");
	});

	it("keeps surrounding terminators when an edit matches fuzzily", async () => {
		expect(
			await editFile("a\r\nconst s = ‘curly’;\nc\r\n", [
				{ oldText: "const s = 'curly';", newText: "const s = 'straight';" },
			]),
		).toBe("a\r\nconst s = 'straight';\nc\r\n");
	});

	it("preserves the BOM while restoring per-line endings", async () => {
		expect(await editFile("﻿a\r\nb\nc\r\n", [{ oldText: "c\n", newText: "C\n" }])).toBe("﻿a\r\nb\nC\r\n");
	});

	it("shows a preview diff that changes the same lines as the real write", async () => {
		const dir = await createTempDir();
		const file = join(dir, "mixed.txt");
		await writeFile(file, MIXED, "utf-8");
		const edits = [{ oldText: "c\n", newText: "C\n" }];

		const preview = await computeEditsDiff(file, edits, dir);
		if ("error" in preview) throw new Error(preview.error);

		await createEditToolDefinition(dir).execute("line-ending-preview", { path: file, edits });
		const truthful = generateDiffString(MIXED, await readFile(file, "utf-8"));

		expect(changedLines(truthful.diff)).toEqual(changedLines(preview.diff));
	});
});
