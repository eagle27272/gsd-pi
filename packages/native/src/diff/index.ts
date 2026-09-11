/**
 * Native diff generation for the edit tool.
 *
 * Uses the `similar` Rust crate (Myers' algorithm) for O(n+d) diffing.
 */

import { native } from "../native.js";
import type { DiffResult } from "./types.js";

export type { DiffResult };

/**
 * Generate a unified diff string with line numbers and context.
 *
 * Uses Myers' diff algorithm via the `similar` Rust crate.
 *
 * @param oldContent  Original text
 * @param newContent  Modified text
 * @param contextLines  Number of context lines around changes (default: 4)
 */
export function generateDiff(
  oldContent: string,
  newContent: string,
  contextLines?: number,
): DiffResult {
  return (native as Record<string, Function>).generateDiff(
    oldContent,
    newContent,
    contextLines,
  ) as DiffResult;
}
