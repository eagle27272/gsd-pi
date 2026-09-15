// gsd-pi — Panel scroll keys that survive a terminal multiplexer.
//
// Herdr claims plain PgUp/PgDn for its own pane scrollback and never forwards
// them to the pane process, so a panel bound only to those keys is unreachable
// for anyone running inside it. Every scrollable panel accepts ctrl+u / ctrl+d
// as well, and advertises that chord since it is the one that works in both
// places.

import { Key, matchesKey } from "@gsd/pi-tui";

/** Footer-hint spelling, e.g. "^u/^d scroll preview". */
export const SCROLL_HINT_KEYS = "^u/^d";

/** Scroll-indicator spelling, e.g. "▼ 12 more · ^U/^D". */
export const SCROLL_INDICATOR_KEYS = "^U/^D";

export function isScrollUpKey(data: string): boolean {
	return matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"));
}

export function isScrollDownKey(data: string): boolean {
	return matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"));
}
