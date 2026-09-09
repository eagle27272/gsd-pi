/**
 * Terminal capability detection for keyboard shortcut support.
 *
 * Ctrl+Alt shortcuts require the Kitty keyboard protocol or modifyOtherKeys.
 * Terminals that lack this support silently swallow the key combos.
 */

const UNSUPPORTED_TERMS = ["apple_terminal", "warpterm"];

export function isCmuxTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CMUX_WORKSPACE_ID && env.CMUX_SURFACE_ID);
}

/** True when running inside a Herdr pane (HERDR_ENV=1 + pane/bin vars). */
export function isHerdrTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV === "1"
    && Boolean(env.HERDR_PANE_ID && env.HERDR_PANE_ID.trim())
    && Boolean(env.HERDR_BIN_PATH && env.HERDR_BIN_PATH.trim());
}

export function supportsCtrlAltShortcuts(): boolean {
  const term = (process.env.TERM_PROGRAM || "").toLowerCase();
  const jetbrains = (process.env.TERMINAL_EMULATOR || "").toLowerCase().includes("jetbrains");
  if (isCmuxTerminal() || isHerdrTerminal()) return true;
  return !UNSUPPORTED_TERMS.some((t) => term.includes(t)) && !jetbrains;
}

/**
 * Returns a shortcut description that includes a slash-command fallback hint
 * when the current terminal likely can't fire Ctrl+Alt combos.
 */
export function shortcutDesc(base: string, fallbackCmd: string): string {
  if (supportsCtrlAltShortcuts()) return base;
  return `${base} — shortcut may not work in this terminal, use ${fallbackCmd}`;
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
