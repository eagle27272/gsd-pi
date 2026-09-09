// gsd-pi — Herdr environment detection.
//
// A GSD session running inside a Herdr pane inherits HERDR_ENV=1 plus
// HERDR_PANE_ID / HERDR_BIN_PATH / HERDR_SOCKET_PATH. Everything the herdr
// extension does is gated on detectHerdrEnv() returning non-null.

export interface HerdrEnv {
  /** e.g. "w1:p2" — the pane to report against. */
  paneId: string;
  /** Absolute path to the `herdr` binary to invoke. */
  binPath: string;
  /** Unix socket for the equivalent IPC API. Captured but unused by this extension. */
  socketPath?: string;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Returns the Herdr env, or null unless we are demonstrably inside a Herdr pane. */
export function detectHerdrEnv(env: NodeJS.ProcessEnv = process.env): HerdrEnv | null {
  if (env.HERDR_ENV !== "1") return null;
  if (!nonEmpty(env.HERDR_PANE_ID) || !nonEmpty(env.HERDR_BIN_PATH)) return null;
  return {
    paneId: env.HERDR_PANE_ID.trim(),
    binPath: env.HERDR_BIN_PATH.trim(),
    socketPath: nonEmpty(env.HERDR_SOCKET_PATH) ? env.HERDR_SOCKET_PATH.trim() : undefined,
  };
}

/** True when the current process is running inside a Herdr pane. */
export function isHerdrTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return detectHerdrEnv(env) !== null;
}
