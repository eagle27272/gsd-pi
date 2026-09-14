// Barrel file — re-exports consumed by external modules.
//
// Nothing reachable from here may import @gsd/pi-tui: extensions are also
// loaded outside jiti's alias resolution (e.g. HTML report generation via
// dynamic import in auto-loop), where that bare specifier cannot resolve.
// TUI-dependent exports live in ./tui.ts. Guarded by
// gsd/tests/lazy-pi-tui-import.test.ts.

export {
	GLYPH,
	INDENT,
	STATUS_GLYPH,
	STATUS_COLOR,
} from "./glyphs.js";
export type { ProgressStatus } from "./glyphs.js";

export {
	stripAnsi,
	formatTokenCount,
	formatDuration,
	sparkline,
	normalizeStringArray,
	fileLink,
} from "./format-utils.js";

export { shortcutDesc } from "./terminal.js";
export { toPosixPath } from "./path-display.js";
export { sanitizeError } from "./sanitize.js";
export { formatDateShort, truncateWithEllipsis } from "./format-utils.js";
export { splitFrontmatter, parseFrontmatterMap } from "./frontmatter.js";
