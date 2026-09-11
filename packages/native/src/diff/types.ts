/** Result of unified diff generation. */
export interface DiffResult {
  /** The unified diff string with line numbers. */
  diff: string;
  /** Line number of the first change in the new file (undefined if no changes). */
  firstChangedLine: number | undefined;
}
