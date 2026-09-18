import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { resolvePath } from "../utils/paths.js";

export interface ContextFile {
	path: string;
	content: string;
}

/** Matches Claude Code's import depth limit. */
const MAX_IMPORT_DEPTH = 5;

const IMPORT_PATTERN = /(^|\s)@(\S+)/g;
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;
const INLINE_CODE_PATTERN = /(`+)[^\n]*?\1/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]$/;

/** Blanks out fenced blocks and inline spans so code samples never import. */
function stripCode(content: string): string {
	let openFence: string | null = null;

	return content
		.split("\n")
		.map((line) => {
			const fence = FENCE_PATTERN.exec(line)?.[1];
			if (openFence) {
				if (fence && fence[0] === openFence[0] && fence.length >= openFence.length) {
					openFence = null;
				}
				return "";
			}
			if (fence) {
				openFence = fence;
				return "";
			}
			return line.replace(INLINE_CODE_PATTERN, " ");
		})
		.join("\n");
}

function readImportTarget(reference: string, baseDir: string): ContextFile | null {
	const resolved = resolvePath(reference, baseDir);
	try {
		if (!statSync(resolved).isFile()) return null;
		return { path: resolved, content: readFileSync(resolved, "utf-8") };
	} catch {
		return null;
	}
}

/** Retries without trailing punctuation so `see @notes.md.` still resolves. */
function resolveReference(reference: string, baseDir: string): ContextFile | null {
	let candidate = reference;
	while (candidate.length > 0) {
		const target = readImportTarget(candidate, baseDir);
		if (target) return target;
		if (!TRAILING_PUNCTUATION.test(candidate)) return null;
		candidate = candidate.slice(0, -1);
	}
	return null;
}

/**
 * Resolves Claude Code style `@path` references in a context file and returns
 * the imported files in depth-first order. `seenPaths` is shared with the
 * caller so a file already loaded as a context file is never emitted twice.
 */
export function expandContextImports(file: ContextFile, seenPaths: Set<string> = new Set()): ContextFile[] {
	const imported: ContextFile[] = [];
	seenPaths.add(file.path);

	const visit = (parent: ContextFile, depth: number): void => {
		if (depth > MAX_IMPORT_DEPTH) return;
		const baseDir = dirname(parent.path);

		for (const match of stripCode(parent.content).matchAll(IMPORT_PATTERN)) {
			const target = resolveReference(match[2], baseDir);
			if (!target || seenPaths.has(target.path)) continue;
			seenPaths.add(target.path);
			imported.push(target);
			visit(target, depth + 1);
		}
	};

	visit(file, 1);
	return imported;
}
