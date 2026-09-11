import { applyPatch } from "diff";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyEditsToNormalizedContent,
	computeEditsDiff,
	generateDiffString,
} from "../src/core/tools/edit-diff.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-fuzzy-scope-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

const FILE_WITH_UNICODE = [
	"heading   ",
	"// note — an em dash",
	"const s = ‘curly’;",
	"target line",
	"",
].join("\n");

describe("fuzzy matching stays inside the matched region", () => {
	it("leaves unmatched lines byte-identical when one edit matched fuzzily", () => {
		const { newContent } = applyEditsToNormalizedContent(
			FILE_WITH_UNICODE,
			[
				{ oldText: "const s = 'curly';", newText: "const s = 'straight';" },
				{ oldText: "target line", newText: "TARGET LINE" },
			],
			"unicode.ts",
		);

		expect(newContent).toBe(
			["heading   ", "// note — an em dash", "const s = 'straight';", "TARGET LINE", ""].join("\n"),
		);
	});

	it("diffs against the original content, not a normalized copy", () => {
		const { baseContent } = applyEditsToNormalizedContent(
			FILE_WITH_UNICODE,
			[{ oldText: "const s = 'curly';", newText: "const s = 'straight';" }],
			"unicode.ts",
		);

		expect(baseContent).toBe(FILE_WITH_UNICODE);
	});

	it("keeps trailing whitespace on lines the edit did not target", async () => {
		const dir = await createTempDir();
		const file = join(dir, "unicode.ts");
		await writeFile(file, FILE_WITH_UNICODE, "utf-8");
		const editTool = createEditToolDefinition(dir);

		await editTool.execute("fuzzy-scope-write", {
			path: file,
			edits: [{ oldText: "const s = 'curly';", newText: "const s = 'straight';" }],
		});

		expect(await readFile(file, "utf-8")).toBe(
			["heading   ", "// note — an em dash", "const s = 'straight';", "target line", ""].join("\n"),
		);
	});

	it("shows a preview diff that matches the real change on disk", async () => {
		const dir = await createTempDir();
		const file = join(dir, "unicode.ts");
		await writeFile(file, FILE_WITH_UNICODE, "utf-8");
		const edits = [{ oldText: "const s = 'curly';", newText: "const s = 'straight';" }];

		const preview = await computeEditsDiff(file, edits, dir);
		if ("error" in preview) throw new Error(preview.error);

		const editTool = createEditToolDefinition(dir);
		await editTool.execute("fuzzy-scope-preview", { path: file, edits });
		const truthfulDiff = generateDiffString(FILE_WITH_UNICODE, await readFile(file, "utf-8"));

		expect(preview.diff).toBe(truthfulDiff.diff);
	});

	it("generates a unified patch against the original content", async () => {
		const dir = await createTempDir();
		const file = join(dir, "unicode.ts");
		await writeFile(file, FILE_WITH_UNICODE, "utf-8");
		const editTool = createEditToolDefinition(dir);

		const result = (await editTool.execute("fuzzy-scope-patch", {
			path: file,
			edits: [{ oldText: "const s = 'curly';", newText: "const s = 'straight';" }],
		})) as { details?: { patch?: string } };

		expect(applyPatch(FILE_WITH_UNICODE, result.details?.patch ?? "")).toBe(await readFile(file, "utf-8"));
	});

	it("declines a match that ends partway through an expanded character", () => {
		expect(() =>
			applyEditsToNormalizedContent("ﬁrst call\n", [{ oldText: "f", newText: "F" }], "ligature.txt"),
		).toThrow(/Could not find the exact text/);
	});

	it("keeps the rest of a CRLF file intact when an edit matches fuzzily", async () => {
		const dir = await createTempDir();
		const file = join(dir, "crlf.txt");
		await writeFile(file, "heading   \r\nconst s = ‘curly’;\r\ntail\r\n", "utf-8");
		const editTool = createEditToolDefinition(dir);

		await editTool.execute("fuzzy-scope-crlf", {
			path: file,
			edits: [{ oldText: "const s = 'curly';", newText: "const s = 'straight';" }],
		});

		expect(await readFile(file, "utf-8")).toBe("heading   \r\nconst s = 'straight';\r\ntail\r\n");
	});

	it("preserves the BOM and surrounding bytes when an edit matches fuzzily", async () => {
		const dir = await createTempDir();
		const file = join(dir, "bom.txt");
		await writeFile(file, "﻿heading   \nconst s = ‘curly’;\n", "utf-8");
		const editTool = createEditToolDefinition(dir);

		await editTool.execute("fuzzy-scope-bom", {
			path: file,
			edits: [{ oldText: "const s = 'curly';", newText: "const s = 'straight';" }],
		});

		expect(await readFile(file, "utf-8")).toBe("﻿heading   \nconst s = 'straight';\n");
	});

	it("falls back to exact matching when the source map cannot be derived", () => {
		// U+3131 and U+314F are separate grapheme clusters whose compatibility forms
		// compose into one syllable, so per-cluster normalization cannot be mapped
		// back to source offsets and fuzzy matching has to switch off for this file.
		const content = "ㄱㅏ\nconst s = ‘curly’;\n";

		expect(() =>
			applyEditsToNormalizedContent(content, [{ oldText: "const s = 'curly';", newText: "X" }], "jamo.txt"),
		).toThrow(/Could not find the exact text/);

		expect(
			applyEditsToNormalizedContent(content, [{ oldText: "const s = ‘curly’;", newText: "X" }], "jamo.txt")
				.newContent,
		).toBe("ㄱㅏ\nX\n");
	});

	it("declines a match that starts partway through an expanded character", () => {
		// The file's "ﬁ" ligature normalizes to "fi"; oldText only covers the "i" half,
		// so honouring the match would silently drop the "f".
		expect(() =>
			applyEditsToNormalizedContent("ﬁrst call\n", [{ oldText: "irst", newText: "IRST" }], "ligature.txt"),
		).toThrow(/Could not find the exact text/);
	});

	it("replaces a fuzzily matched region spanning normalized characters, leaving the rest alone", () => {
		const { newContent } = applyEditsToNormalizedContent(
			"ＡＢＣ\ncafé\nkeep me   \n",
			[{ oldText: "ABC\ncafé\n", newText: "XYZ\ncoffee\n" }],
			"compat.txt",
		);

		expect(newContent).toBe("XYZ\ncoffee\nkeep me   \n");
	});
});

describe("ambiguity detection counts overlapping occurrences", () => {
	it("rejects an oldText that overlaps itself", () => {
		expect(() => applyEditsToNormalizedContent("foofoofoo", [{ oldText: "foofoo", newText: "X" }], "dup.txt")).toThrow(
			/Found 2 occurrences/,
		);
	});

	it("rejects an overlapping multi-line oldText", () => {
		expect(() =>
			applyEditsToNormalizedContent("a\na\na\n", [{ oldText: "a\na\n", newText: "b\n" }], "dup.txt"),
		).toThrow(/Found 2 occurrences/);
	});

	it("rejects an ambiguous oldText that normalizes to nothing", () => {
		// "   " survives as an exact match but vanishes under fuzzy normalization,
		// so the uniqueness check has to fall back to counting the raw text.
		expect(() => applyEditsToNormalizedContent("a   b   c", [{ oldText: "   ", newText: "_" }], "ws.txt")).toThrow(
			/Found 2 occurrences/,
		);
	});
});
