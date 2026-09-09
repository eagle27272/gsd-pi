// gsd-pi -- Herdr CLI reporter.
//
// Wraps `$HERDR_BIN_PATH pane {report-agent,report-agent-session,report-metadata,
// release-agent}`. Every call is async, time-boxed, and best-effort: a stalled or
// missing Herdr server must never surface as an error or block a turn.

import { execFile } from "node:child_process";
import type { HerdrEnv } from "./env.js";
import { normalizeDisplay } from "./state-mapping.js";

export type HerdrState = "working" | "idle" | "blocked" | "unknown";
export type HerdrRunner = (file: string, args: string[]) => void;

export interface HerdrReporterOptions {
  env: HerdrEnv;
  source?: string;
  agent?: string;
  runner?: HerdrRunner;
}

const DEFAULT_SOURCE = "custom:gsd";
const DEFAULT_AGENT = "gsd";

const defaultRunner: HerdrRunner = (file, args) => {
  try {
    const child = execFile(file, args, { timeout: 2000, windowsHide: true }, () => {
      /* ignore stdout/stderr/exit -- best effort */
    });
    child.on("error", () => {
      /* ENOENT / spawn failure -- best effort */
    });
  } catch {
    /* synchronous spawn failure -- best effort */
  }
};

export class HerdrReporter {
  private readonly env: HerdrEnv;
  private readonly source: string;
  private readonly agent: string;
  private readonly runner: HerdrRunner;
  private seq = 0;
  private lastStateKey: string | null = null;
  private lastMetaKey: string | null = null;

  constructor(opts: HerdrReporterOptions) {
    this.env = opts.env;
    this.source = opts.source ?? DEFAULT_SOURCE;
    this.agent = opts.agent ?? DEFAULT_AGENT;
    this.runner = opts.runner ?? defaultRunner;
  }

  private run(tail: string[], trailing: string[] = []): void {
    this.seq += 1;
    // tail is [verb, subverb, paneId, ...rest]; identity goes right after paneId,
    // --seq is emitted last, and any trailing args (e.g. --message) follow it.
    const args = [
      ...tail.slice(0, 3),
      ...this.identity(),
      ...tail.slice(3),
      "--seq",
      String(this.seq),
      ...trailing,
    ];
    try {
      this.runner(this.env.binPath, args);
    } catch {
      /* a throwing injected runner must not escape */
    }
  }

  private identity(): string[] {
    return ["--source", this.source, "--agent", this.agent];
  }

  reportState(state: HerdrState, opts: { message?: string } = {}): void {
    const key = JSON.stringify([state, opts.message ?? null]);
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    const trailing = opts.message ? ["--message", normalizeDisplay(opts.message)] : [];
    this.run(["pane", "report-agent", this.env.paneId, "--state", state], trailing);
  }

  reportSession(opts: { sessionId?: string; sessionPath?: string }): void {
    if (!opts.sessionId && !opts.sessionPath) return;
    const rest: string[] = [];
    if (opts.sessionId) rest.push("--agent-session-id", opts.sessionId);
    if (opts.sessionPath) rest.push("--agent-session-path", opts.sessionPath);
    this.run(["pane", "report-agent-session", this.env.paneId, ...rest]);
  }

  reportMetadata(opts: { title?: string | null; stateLabels?: Partial<Record<string, string>> }): void {
    const key = JSON.stringify({ t: opts.title ?? null, l: opts.stateLabels ?? {} });
    if (key === this.lastMetaKey) return;
    this.lastMetaKey = key;

    const rest: string[] = [];
    if (opts.title === null) rest.push("--clear-title");
    else if (typeof opts.title === "string") rest.push("--title", normalizeDisplay(opts.title));

    const labels = opts.stateLabels ?? {};
    const entries = Object.entries(labels).filter(([, v]) => typeof v === "string");
    if (entries.length === 0 && opts.stateLabels !== undefined) rest.push("--clear-state-labels");
    for (const [status, text] of entries) {
      rest.push("--state-label", `${status}=${normalizeDisplay(String(text))}`);
    }
    this.run(["pane", "report-metadata", this.env.paneId, ...rest]);
  }

  release(): void {
    this.lastStateKey = null;
    this.lastMetaKey = null;
    this.run(["pane", "release-agent", this.env.paneId]);
  }
}
