/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveToCwd } from "./path-utils.js";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return replaceFuzzyEquivalentChars(stripTrailingWhitespacePerLine(text.normalize("NFKC")));
}

function stripTrailingWhitespacePerLine(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

function replaceFuzzyEquivalentChars(text: string): string {
	return (
		text
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/**
 * The source range behind each code unit of a fuzzy-normalized text. This map is
 * what lets a fuzzy match be spliced back into the *source* text: without it the
 * only way to apply a fuzzy match is to overwrite the source with its normalized
 * form, silently rewriting every unrelated line the normalizer touched.
 */
interface FuzzySourceMap {
	/** Start offset in the source of the region that produced normalized unit i. */
	sourceStart: Int32Array;
	/** End offset (exclusive) in the source of the region that produced normalized unit i. */
	sourceEnd: Int32Array;
}

let graphemeSegmenter: Intl.Segmenter | undefined;

/**
 * NFKC-normalize `source`, recording the source range behind each output code unit.
 *
 * Canonical composition only joins characters inside one grapheme cluster, so
 * normalizing cluster by cluster keeps offsets attributable. It does not always
 * reproduce whole-string `normalize("NFKC")` though: compatibility decomposition
 * can turn characters in *separate* clusters into conjoining Hangul jamo that then
 * compose across the boundary (U+3131 U+314F -> U+AC00). buildFuzzySourceMap's
 * reconstruction check is what catches that.
 *
 * Clusters whose normalized form has a different length map every output unit to
 * the whole cluster.
 */
function nfkcWithSourceRanges(source: string): { text: string; start: number[]; end: number[] } {
	const start: number[] = [];
	const end: number[] = [];

	if (source.normalize("NFKC") === source) {
		for (let i = 0; i < source.length; i++) {
			start.push(i);
			end.push(i + 1);
		}
		return { text: source, start, end };
	}

	graphemeSegmenter ??= new Intl.Segmenter("en", { granularity: "grapheme" });
	const chunks: string[] = [];
	let offset = 0;
	for (const { segment } of graphemeSegmenter.segment(source)) {
		const normalized = segment.normalize("NFKC");
		chunks.push(normalized);
		if (normalized.length === segment.length) {
			for (let i = 0; i < segment.length; i++) {
				start.push(offset + i);
				end.push(offset + i + 1);
			}
		} else {
			for (let i = 0; i < normalized.length; i++) {
				start.push(offset);
				end.push(offset + segment.length);
			}
		}
		offset += segment.length;
	}
	return { text: chunks.join(""), start, end };
}

/**
 * Map every code unit of `normalized` (which must be `normalizeForFuzzyMatch(source)`)
 * back to the source range that produced it.
 *
 * Returns undefined when the reconstruction does not reproduce `normalized`
 * exactly. Fuzzy matching is then disabled for this content rather than splicing
 * against a map that cannot be trusted; exact matching still works.
 */
function buildFuzzySourceMap(source: string, normalized: string): FuzzySourceMap | undefined {
	const nfkc = nfkcWithSourceRanges(source);

	const chars: string[] = [];
	const start: number[] = [];
	const end: number[] = [];
	let lineStart = 0;
	for (;;) {
		const newlineIndex = nfkc.text.indexOf("\n", lineStart);
		const lineEnd = newlineIndex === -1 ? nfkc.text.length : newlineIndex;
		const kept = nfkc.text.slice(lineStart, lineEnd).trimEnd().length;
		for (let i = lineStart; i < lineStart + kept; i++) {
			chars.push(nfkc.text[i]);
			start.push(nfkc.start[i]);
			end.push(nfkc.end[i]);
		}
		if (newlineIndex === -1) break;
		chars.push("\n");
		start.push(nfkc.start[newlineIndex]);
		end.push(nfkc.end[newlineIndex]);
		lineStart = newlineIndex + 1;
	}

	// replaceFuzzyEquivalentChars is one-to-one per code unit, so it leaves the map intact.
	if (replaceFuzzyEquivalentChars(chars.join("")) !== normalized) return undefined;

	return { sourceStart: Int32Array.from(start), sourceEnd: Int32Array.from(end) };
}

/**
 * Lazily-computed fuzzy view of one piece of content. Both parts are expensive on
 * large files and most edits need neither, so nothing is computed until asked for.
 */
interface FuzzyView {
	text(): string;
	sourceMap(): FuzzySourceMap | undefined;
}

function createFuzzyView(content: string): FuzzyView {
	let text: string | undefined;
	const getText = (): string => (text ??= normalizeForFuzzyMatch(content));

	let sourceMap: FuzzySourceMap | undefined;
	let sourceMapBuilt = false;
	const getSourceMap = (): FuzzySourceMap | undefined => {
		if (!sourceMapBuilt) {
			sourceMapBuilt = true;
			sourceMap = buildFuzzySourceMap(content, getText());
		}
		return sourceMap;
	};

	return { text: getText, sourceMap: getSourceMap };
}

interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** Index where the match starts, in the original content */
	index: number;
	/** Length of the matched region, in the original content */
	matchLength: number;
}

const NO_MATCH: FuzzyMatchResult = { found: false, index: -1, matchLength: 0 };

export interface Edit {
	oldText: string;
	newText: string;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

export interface AppliedEditsResult {
	/**
	 * The content the edits were applied to, unchanged. Diff against this so the
	 * preview can never understate what is about to be written.
	 */
	baseContent: string;
	newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * Both kinds of match are reported as offsets into `content` itself, so the
 * caller replaces the matched region of the original text and leaves every
 * other byte alone.
 */
function findTextInContent(content: string, oldText: string, fuzzy: FuzzyView): FuzzyMatchResult {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return { found: true, index: exactIndex, matchLength: oldText.length };
	}

	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	if (fuzzyOldText.length === 0) return NO_MATCH;

	const fuzzyIndex = fuzzy.text().indexOf(fuzzyOldText);
	if (fuzzyIndex === -1) return NO_MATCH;

	const sourceMap = fuzzy.sourceMap();
	if (!sourceMap) return NO_MATCH;

	// Map the normalized match range back onto the original content. A match may
	// begin or end partway through a source character that normalization expanded
	// (the "i" of an "fi" ligature, say); replacing it would drop the half that was
	// not matched, so decline instead and let the caller report not-found.
	const last = fuzzyIndex + fuzzyOldText.length - 1;
	const { sourceStart, sourceEnd } = sourceMap;
	const startsOnBoundary = fuzzyIndex === 0 || sourceStart[fuzzyIndex] !== sourceStart[fuzzyIndex - 1];
	const endsOnBoundary = last === fuzzy.text().length - 1 || sourceEnd[last] !== sourceEnd[last + 1];
	if (!startsOnBoundary || !endsOnBoundary) return NO_MATCH;

	const index = sourceStart[fuzzyIndex];
	return { found: true, index, matchLength: sourceEnd[last] - index };
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function countSubstring(haystack: string, needle: string): number {
	let count = 0;
	// Advance by one so overlapping occurrences are counted; the caller rejects
	// any oldText that appears more than once.
	for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
		count++;
	}
	return count;
}

/**
 * Count how many places `oldText` could match, in the same space the match was
 * found. Whitespace-only oldText disappears under normalization, so it can only
 * ever match exactly and has to be counted against the raw content.
 */
function countOccurrences(content: string, fuzzy: FuzzyView, oldText: string): number {
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyOldText.length === 0 ? countSubstring(content, oldText) : countSubstring(fuzzy.text(), fuzzyOldText);
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content, and every match --
 * exact or fuzzy -- is expressed as a range in that original content, so only
 * the matched regions change. Replacements are applied in reverse order so
 * offsets remain stable.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const fuzzy = createFuzzyView(normalizedContent);

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = findTextInContent(normalizedContent, edit.oldText, fuzzy);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		const occurrences = countOccurrences(normalizedContent, fuzzy, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	let newContent = normalizedContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.substring(0, edit.matchIndex) +
			edit.newText +
			newContent.substring(edit.matchIndex + edit.matchLength);
	}

	if (normalizedContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent: normalizedContent, newContent };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
