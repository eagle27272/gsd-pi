// gsd-pi — Herdr extension.
//
// Reports GSD lifecycle state, session identity, and auto-mode context to the
// Herdr pane this session runs in. A no-op unless detectHerdrEnv() is non-null.
// See docs/superpowers/specs/2026-09-09-herdr-extension-design.md.

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { detectHerdrEnv } from "./env.js";
import { HerdrReporter } from "./reporter.js";
import { buildHerdrTitle, buildStateLabels } from "./state-mapping.js";
import {
  HERDR_CHANNELS,
  type HerdrClearEvent,
  type HerdrSyncEvent,
} from "../shared/herdr-events.js";
import { loadEffectiveGSDPreferences } from "../gsd/preferences.js";

interface ResolvedHerdrPrefs {
  enabled: boolean;
  notifications: boolean;
  title: boolean;
}

export function readHerdrPrefs(): ResolvedHerdrPrefs {
  try {
    const p = loadEffectiveGSDPreferences()?.preferences?.herdr ?? {};
    return {
      enabled: p.enabled !== false,
      notifications: p.notifications !== false,
      title: p.title !== false,
    };
  } catch {
    return { enabled: true, notifications: true, title: true };
  }
}

export function isBlockedNotification(kind: string): boolean {
  return kind === "blocked" || kind === "input_needed";
}

type ReporterLike = Pick<
  HerdrReporter,
  "reportState" | "reportSession" | "reportMetadata" | "release"
>;

/** Testable wiring seam — see tests/lifecycle.test.ts. */
export function __wire(
  pi: ExtensionAPI,
  reporter: ReporterLike,
  prefs: () => ResolvedHerdrPrefs,
): void {
  let released = false;

  if (prefs().enabled) {
    pi.on("agent_start", () => reporter.reportState("working"));
    pi.on("turn_start", () => reporter.reportState("working"));
    pi.on("turn_end", () => reporter.reportState("idle"));
    pi.on("stop", (event) => {
      const e = event as { reason?: string };
      reporter.reportState(e.reason === "blocked" ? "blocked" : "idle");
    });
    pi.on("notification", (event) => {
      const e = event as { kind?: string; message?: string };
      if (e.kind && isBlockedNotification(e.kind)) {
        reporter.reportState("blocked", { message: e.message });
      }
    });
    pi.on("session_start", (_event, ctx) => {
      // Register the agent with Herdr immediately so it is listed and shows a
      // status dot before the first turn. `report-agent-session` alone only
      // updates native session identity, not lifecycle state, so without this
      // the pane has no `gsd` agent until the first `turn_start`.
      reporter.reportState("idle");
      const sm = (ctx as { sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined } })?.sessionManager;
      reporter.reportSession({ sessionId: sm?.getSessionId?.(), sessionPath: sm?.getSessionFile?.() });
    });
    const release = (): void => {
      if (released) return;
      released = true;
      reporter.release();
    };
    pi.on("session_shutdown", release);
    pi.on("session_end", release);
  }

  // Auto-mode context. Registered synchronously so a SYNC emitted in the same
  // event-loop turn as extension load is not dropped (Node EventEmitter does not
  // buffer for late subscribers).
  pi.events.on(HERDR_CHANNELS.SYNC, (payload) => {
    const data = payload as HerdrSyncEvent;
    const p = prefs();
    const perEvent = data.preferences?.herdr;
    const enabled = perEvent?.enabled ?? p.enabled;
    const showTitle = (perEvent?.title ?? p.title) !== false;
    if (!enabled || !showTitle) return;
    reporter.reportMetadata({
      title: buildHerdrTitle(data.state),
      stateLabels: buildStateLabels(data.state),
    });
  });
  pi.events.on(HERDR_CHANNELS.CLEAR, (payload) => {
    const data = payload as HerdrClearEvent;
    const enabled = data.preferences?.herdr?.enabled ?? prefs().enabled;
    if (!enabled) return;
    reporter.reportMetadata({ title: null, stateLabels: {} });
  });
}

export default function (pi: ExtensionAPI): void {
  const env = detectHerdrEnv();
  if (!env) return; // hard no-op outside Herdr

  const reporter = new HerdrReporter({ env });
  __wire(pi, reporter, readHerdrPrefs);
}
