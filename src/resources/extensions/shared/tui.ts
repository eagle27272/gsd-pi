// Barrel — TUI-dependent exports.
// Everything here has a transitive dependency on @gsd/pi-tui and so must not
// be re-exported from shared/mod. Import from here when your code needs
// makeUI, the ANSI-aware layout helpers, or an interactive dialog.

export { makeUI } from "./ui.js";
export type { UI } from "./ui.js";
export { showInterviewRound } from "./interview-ui.js";
export type { Question, QuestionOption, RoundResult } from "./interview-ui.js";
export { showNextAction } from "./next-action-ui.js";
export { showConfirm } from "./confirm-ui.js";
export { maskEditorLine } from "./mask-editor-line.js";

export {
	padRight,
	joinColumns,
	centerLine,
	fitColumns,
} from "./layout-utils.js";
