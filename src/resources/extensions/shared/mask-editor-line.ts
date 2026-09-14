/**
 * Mask sensitive TUI editor input.
 *
 * Split from sanitize.ts because CURSOR_MARKER comes from @gsd/pi-tui, which
 * shared/mod.ts must not resolve — sanitizeError is pure and stays there.
 */

import { CURSOR_MARKER } from "@gsd/pi-tui";

/**
 * Replace editor visible text with masked characters while preserving
 * ANSI cursor/sequencer codes. Keeps border/metadata lines readable.
 */
export function maskEditorLine(line: string): string {
  if (line.startsWith("─")) {
    return line;
  }

  let output = "";
  let i = 0;
  while (i < line.length) {
    if (line.startsWith(CURSOR_MARKER, i)) {
      output += CURSOR_MARKER;
      i += CURSOR_MARKER.length;
      continue;
    }

    const ansiMatch = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
    if (ansiMatch) {
      output += ansiMatch[0];
      i += ansiMatch[0].length;
      continue;
    }

    const ch = line[i] as string;
    output += ch === " " ? " " : "*";
    i += 1;
  }

  return output;
}
