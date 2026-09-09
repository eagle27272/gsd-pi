# Herdr Extension — Design

**Status:** Draft for review
**Date:** 2026-09-09
**Author:** Mike Rogers (with Claude)

## 1. Summary

Add a bundled `herdr` extension that makes GSD Pi a first-class citizen of
[Herdr](https://github.com/herdrdev/herdr) — "the runtime your coding agents live
on," a Rust terminal multiplexer with a CLI + socket API for agent orchestration.

When GSD runs inside a Herdr pane, the extension:

1. **Reports lifecycle state** (`working` / `idle` / `blocked`) to Herdr so the
   pane's status dot and workspace rollups are accurate, and releases that
   authority when the session exits.
2. **Reports native session identity** so Herdr can restore the pane after a
   server restart.
3. **Surfaces GSD auto-mode context** (active milestone / slice / task + phase)
   as the pane's title and state-label metadata.
4. **Routes "blocked" / attention notifications** through Herdr instead of the
   native desktop toast when running inside Herdr.

Outside Herdr the extension is a total no-op.

This restores — against a documented, stable API — the class of integration the
removed `cmux` extension provided (commit `9b5c992c`), scoped to *reporting +
GSD context*. It deliberately does **not** spawn panes/splits for parallel
subagent execution (the old `createGridLayout` behavior).

## 2. Background

### 2.1 Herdr's integration contract

An agent running in a Herdr pane inherits these environment variables:

| Var | Meaning |
| --- | --- |
| `HERDR_ENV=1` | Set iff running inside a Herdr pane. Gate all behavior on this. |
| `HERDR_PANE_ID` | e.g. `w1:p2` — the pane to report against. |
| `HERDR_BIN_PATH` | Absolute path to the `herdr` binary to invoke. |
| `HERDR_SOCKET_PATH` | Unix socket for the equivalent IPC API (not used by this design). |

Herdr's own recommendation (docs: *Integrate your own agent*) is to shell out to
`"$HERDR_BIN_PATH"` with the CLI wrappers for portable integrations, reporting
only when `HERDR_ENV=1` and the required vars are present, keeping `--source`
stable and unique, and including a strictly increasing `--seq` so out-of-order
reports are ignored. Herdr already ships a Pi integration
(`herdr integration install pi` → `~/.pi/agent/extensions/herdr-agent-state.ts`);
this design is the bundled, GSD-aware equivalent that needs no separate install
step. [Prime Agent's `herdr-agent-state.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/src/core/extensions/builtin/herdr-agent-state.ts)
is a reference implementation of the same pattern.

### 2.2 Relevant Herdr CLI surface

```bash
# Lifecycle state (working | idle | blocked | unknown)
herdr pane report-agent <pane_id> \
  --source ID --agent LABEL --state STATE \
  [--message TEXT] [--seq N] [--agent-session-id ID] [--agent-session-path PATH]

# Native session identity only (no lifecycle change)
herdr pane report-agent-session <pane_id> \
  --source ID --agent LABEL [--seq N] [--agent-session-id ID] [--agent-session-path PATH]

# End this source's lifecycle authority (agent process exiting)
herdr pane release-agent <pane_id> --source ID --agent LABEL [--seq N]

# Presentation-only metadata (title, per-state label, tokens); does NOT take
# over lifecycle/session authority
herdr pane report-metadata <pane_id> \
  --source ID [--agent LABEL] \
  [--title TEXT | --clear-title] \
  [--state-label STATUS=TEXT] [--clear-state-labels] \
  [--seq N] [--ttl-ms N]
```

Constraints from the CLI reference:

- `--source` / `--applies-to-source`: ≤ 80 chars, ASCII letters, digits, `:`,
  `.`, `_`, `-` only.
- `--title`, `--display-agent`, each `--state-label`, token values: normalized
  (trimmed, control chars removed) and capped at 80 chars by Herdr.
- `--ttl-ms`: 1 – 86_400_000.
- Agent `LABEL` / name: must match `[a-z][a-z0-9_-]{0,31}`.
- A pane accepts sequenced reports from at most 32 distinct sources for its
  lifetime — so we use exactly one stable source.

### 2.3 How bundled extensions load in this repo

- Source lives in `src/resources/extensions/<id>/`, compiled into the package's
  `resources/extensions/`, and copied to `~/.gsd/agent/extensions/<id>/` by
  `initResources()` in `src/resource-loader.ts` on version/hash change. New
  subdirectories are picked up automatically (`currentSourceDirs`); no central
  allowlist.
- `src/extension-registry.ts` auto-creates an enabled-by-default registry entry
  (`ensureRegistryEntries`). The only way it stops loading is
  `gsd extensions disable herdr`.
- `src/loader.ts` / `src/extension-discovery.ts` resolve each directory's entry
  and invoke its default-export factory `(pi: ExtensionAPI) => void`.
- A directory whose `package.json` carries a `pi` manifest with no extensions
  (e.g. `src/resources/extensions/shared/` siblings, the old `cmux/`) is treated
  as a *library*, not an extension, and never factory-called.
- `src/resources/extensions/shared/` is a bag of plain `.ts` modules imported by
  sibling extensions as `../shared/<name>.js`. It has no `package.json` and is
  not itself an extension.

### 2.4 Pi lifecycle events available (`ExtensionAPI.on`)

From `@gsd/pi-coding-agent` `extension-upstream-types.d.ts`:
`session_start`, `session_shutdown`, `session_end`, `agent_start`, `agent_end`,
`turn_start`, `turn_end`, `stop`, `notification`, `milestone_start`,
`milestone_end`, `unit_start`, `unit_end`, and many more. `pi.events` is a shared
`EventBus` — the same bus the GSD extension emits on — so a second extension can
subscribe to channels the GSD extension publishes.

## 3. Goals / Non-goals

### Goals

- Accurate `working` / `idle` / `blocked` in Herdr for both plain interactive
  sessions and GSD auto-mode.
- Pane title reflects GSD auto-mode progress when auto-mode is running.
- Blocked/attention notifications reach the user through Herdr.
- Native session identity reported for Herdr restore.
- Zero behavior and zero measurable overhead outside Herdr.
- Independently toggleable via the standard extension registry.
- GSD extension changes limited to the same emit points `cmux` already used, plus
  one branch in the notification helper.

### Non-goals

- Spawning panes / splits / grid layouts for parallel subagents.
- Consuming the Herdr **socket** API (CLI wrappers only).
- A preferences wizard step or a first-run "Herdr detected — enable?" prompt.
- Multi-machine coordination, Herdr plugin/marketplace packaging.
- Reading Herdr pane output back into GSD.

## 4. Architecture

```
                    pi.events (shared EventBus)
                            │
  ┌─────────────────────────┼──────────────────────────┐
  │  GSD extension          │      herdr extension     │
  │  (emitter side)         │      (consumer side)     │
  │                         │                          │
  │  auto.ts                │   index.ts (factory)     │
  │   makeHerdrEmitters(pi) │    ├─ detectHerdrEnv()   │
  │   → emit SYNC / CLEAR ──┼──▶ ├─ on(SYNC/CLEAR)     │
  │  pre-dispatch.ts        │    ├─ on(pi lifecycle)   │
  │   emit SYNC per loop    │    └─ HerdrReporter ─────┼──▶ $HERDR_BIN_PATH
  │                         │                          │      pane report-agent
  │  notifications.ts       │   reporter.ts            │      pane report-metadata
  │   sendDesktopNotification│   env.ts                │      pane report-agent-session
  │   → herdr branch ───────┼──▶ (shared helper)      │      pane release-agent
  └─────────────────────────┴──────────────────────────┘
                            │
        src/resources/extensions/shared/herdr-events.ts
             (neutral contract: channels + payload types;
              imported by BOTH sides, neither imports the other)
```

### 4.1 New files

| Path | Purpose |
| --- | --- |
| `src/resources/extensions/herdr/index.ts` | Extension factory: env gate, event subscriptions, wiring. |
| `src/resources/extensions/herdr/env.ts` | `detectHerdrEnv(env)` → `HerdrEnv | null`; pure, tested. |
| `src/resources/extensions/herdr/reporter.ts` | `HerdrReporter` class — CLI wrapper, seq counter, state/title/session/release methods, dedup. |
| `src/resources/extensions/herdr/state-mapping.ts` | `buildHerdrTitle(state)` / `buildStateLabel(state)` from `HerdrStateInput`; pure, tested. |
| `src/resources/extensions/herdr/extension-manifest.json` | Manifest (id `herdr`, tier `bundled`). |
| `src/resources/extensions/herdr/tests/env.test.ts` | env detection matrix. |
| `src/resources/extensions/herdr/tests/reporter.test.ts` | CLI arg construction, seq monotonicity, dedup, no-op when disabled, failure swallowed. |
| `src/resources/extensions/herdr/tests/state-mapping.test.ts` | title/label formatting. |
| `src/resources/extensions/herdr/tests/lifecycle.test.ts` | pi-event → reporter-call mapping via a fake reporter + fake `pi`. |
| `src/resources/extensions/shared/herdr-events.ts` | Neutral channel + payload contract. |

### 4.2 Modified files

| Path | Change |
| --- | --- |
| `src/resources/extensions/gsd/preferences-types.ts` | Add `HerdrPreferences` interface + `herdr?: HerdrPreferences` on `GSDPreferences`. |
| `src/resources/extensions/gsd/preferences-validation.ts` | Validate the `herdr` block (object; three optional booleans). |
| `src/resources/extensions/gsd/preferences.ts` | Deep-merge `herdr` in `mergePreferences` (same pattern as `notifications`). |
| `src/resources/extensions/gsd/templates/PREFERENCES.md` | Document the `herdr` block (commented example). |
| `src/resources/extensions/gsd/docs/preferences-reference.md` | Reference entry for `herdr`. |
| `src/resources/extensions/gsd/auto.ts` | Restore `makeHerdrEmitters(pi)`; emit `SYNC` after start, `CLEAR` in `stopAuto`, `SYNC` on resume, `CLEAR` on lost session lock. |
| `src/resources/extensions/gsd/auto/pre-dispatch.ts` | Emit `SYNC` once per loop iteration (mirrors the removed `deps.syncCmuxSidebar(prefs, state)` call site). |
| `src/resources/extensions/gsd/auto/types.ts` | Add the emitter members back to `LoopDeps` (`syncHerdr`, `clearHerdr`). |
| `src/resources/extensions/gsd/notifications.ts` | Add a Herdr delivery branch to `sendDesktopNotification` — when inside Herdr and `herdr.notifications !== false`, deliver via the reporter and skip the native toast. |

No change to `src/resources/extensions/gsd/bootstrap/register-extension.ts` — the
`herdr` extension self-registers. (The old `cmux` code needed a line there only
because `cmux` was a library with no factory of its own.)

## 5. The neutral contract — `shared/herdr-events.ts`

Mirrors the deleted `shared/cmux-events.ts`. Both the GSD extension and the
`herdr` extension import this module for channel names and payload types; neither
imports the other.

```ts
// gsd-pi — Shared Herdr event channel contracts.
// Neutral module for gsd <-> herdr decoupling: both sides import from here,
// neither imports the other (per the pattern established by the removed
// shared/cmux-events.ts).

export const HERDR_CHANNELS = {
  /** Auto-mode workflow state changed; refresh pane title / state labels. */
  SYNC: "herdr:sync",
  /** Auto-mode ended; clear GSD-owned pane title / state labels. */
  CLEAR: "herdr:clear",
} as const;

/** Structural slice of GSD preferences the herdr side needs. */
export interface HerdrPreferencesInput {
  herdr?: {
    enabled?: boolean;        // default: true
    notifications?: boolean;  // default: true
    title?: boolean;          // default: true
  };
}

/** Structural slice of GSDState the herdr side needs. */
export interface HerdrStateInput {
  phase: string;
  activeMilestone?: { id: string; title?: string };
  activeSlice?: { id: string };
  activeTask?: { id: string };
  progress?: {
    milestones: { done: number; total: number };
    slices?: { done: number; total: number };
    tasks?: { done: number; total: number };
  };
}

export interface HerdrSyncEvent {
  preferences?: HerdrPreferencesInput;
  state: HerdrStateInput;
}

export interface HerdrClearEvent {
  preferences?: HerdrPreferencesInput;
}
```

Rationale for two channels (vs. cmux's three): there is no separate event-log
sink in this design, so the `LOG` channel is dropped. `SYNC` carries the full
state each time (idempotent); the consumer dedups.

## 6. Component detail

### 6.1 `env.ts`

```ts
export interface HerdrEnv {
  paneId: string;
  binPath: string;
  socketPath?: string;
}

/** Returns null unless we are demonstrably inside a Herdr pane. */
export function detectHerdrEnv(env: NodeJS.ProcessEnv = process.env): HerdrEnv | null;
```

Detection rule: **all** of `env.HERDR_ENV === "1"`, non-empty
`env.HERDR_PANE_ID`, non-empty `env.HERDR_BIN_PATH`. `HERDR_SOCKET_PATH` is
captured if present but not required. Any miss → `null` → the extension does
nothing further.

`env.ts` also exports `isHerdrTerminal(env?)` returning `boolean`, and
`src/resources/extensions/shared/terminal.ts` gains a matching guard so
`supportsCtrlAltShortcuts()` treats Herdr panes as capable (parity with the
retained `isCmuxTerminal()`), i.e. `if (isCmuxTerminal() || isHerdrTerminal()) return true;`.

### 6.2 `reporter.ts` — `HerdrReporter`

```ts
export type HerdrState = "working" | "idle" | "blocked" | "unknown";

export interface HerdrReporterOptions {
  env: HerdrEnv;
  source?: string;   // default "custom:gsd"
  agent?: string;    // default "gsd"
  runner?: (file: string, args: string[]) => void;  // seam for tests
}

export class HerdrReporter {
  reportState(state: HerdrState, opts?: { message?: string }): void;
  reportSession(opts: { sessionId?: string; sessionPath?: string }): void;
  reportMetadata(opts: { title?: string | null; stateLabels?: Partial<Record<HerdrState | "done", string>> }): void;
  release(): void;
}
```

Behavior:

- **Source / agent constants.** `--source custom:gsd` (satisfies the charset
  rule and Herdr's "keep `--source` stable and unique" guidance).
  `--agent gsd` (matches `[a-z][a-z0-9_-]{0,31}`).
- **Sequence.** A single process-lifetime monotonic integer, incremented on
  every emitted command, passed as `--seq`. Guarantees Herdr can discard
  out-of-order reports from our source.
- **Transport.** `execFile(env.binPath, args, { timeout: 2000, windowsHide: true })`
  via a non-blocking wrapper (`child_process.execFile` with a callback that
  ignores the result). Never `execFileSync` on the hot path — a stalled Herdr
  server must not block a turn. All failures (non-zero exit, ENOENT, timeout)
  are swallowed; optionally one debug line via the GSD debug logger when
  `GSD_DEBUG` is set. The `runner` option is the test seam.
- **Dedup.** `reportState` and `reportMetadata` remember the last payload they
  sent and skip an identical consecutive call. `reportState` always sends when
  `message` differs. `release()` is never deduped and clears the dedup cache.
- **Argument construction** (exact):
  - state: `["pane", "report-agent", paneId, "--source", src, "--agent", agent, "--state", state, "--seq", n]` then `["--message", msg]` if provided.
  - session: `["pane", "report-agent-session", paneId, "--source", src, "--agent", agent, "--seq", n]` then `--agent-session-id` / `--agent-session-path` when set.
  - metadata: `["pane", "report-metadata", paneId, "--source", src, "--agent", agent, "--seq", n]` then `--title TEXT` or `--clear-title`, then one `--state-label STATUS=TEXT` per entry.
  - release: `["pane", "release-agent", paneId, "--source", src, "--agent", agent, "--seq", n]`.
- **Normalization.** Title / label text: collapse whitespace/newlines to single
  spaces, strip control chars, hard-truncate to 80 chars before passing (Herdr
  also caps, but truncating locally keeps logs readable and avoids surprises).

### 6.3 `state-mapping.ts`

Pure functions over `HerdrStateInput`:

- `buildHerdrTitle(s): string` — e.g. `"M2 S1/T3 · executing"` or, when no
  unit is active, just the phase (`"planning"`). Uses milestone **id** (+ short
  title if it fits within the 80-char budget), slice id, task id. Mirrors the
  removed `buildCmuxStatusLabel`.
- `buildStateLabels(s): Partial<Record<HerdrState, string>>` — a `working`
  label carrying the progress fraction when available
  (`"3/8 tasks"` → `{ working: "M2 · 3/8 tasks" }`), else `{}`. Mirrors the
  removed `buildCmuxProgress`.

### 6.4 `index.ts` — the factory

```ts
export default function (pi: ExtensionAPI): void {
  const env = detectHerdrEnv();
  if (!env) return;                       // hard no-op outside Herdr

  const reporter = new HerdrReporter({ env });
  let released = false;
  const prefs = () => readHerdrPrefs();   // see 6.5

  // ---- lifecycle → state ----
  if (prefs().enabled) {
    pi.on("agent_start", () => reporter.reportState("working"));
    pi.on("turn_start",  () => reporter.reportState("working"));
    pi.on("turn_end",    () => reporter.reportState("idle"));
    pi.on("stop",        () => reporter.reportState("idle"));
    pi.on("notification", (e) => {
      if (isBlockedKind(e)) reporter.reportState("blocked", { message: notifText(e) });
    });
    pi.on("session_start", (e) => reporter.reportSession({
      sessionId: sessionIdOf(e), sessionPath: sessionPathOf(e),
    }));
    const release = () => { if (!released) { released = true; reporter.release(); } };
    pi.on("session_shutdown", release);
    pi.on("session_end", release);
  }

  // ---- GSD auto-mode context → title / labels ----
  // Registered synchronously so early emits are not dropped.
  pi.events.on(HERDR_CHANNELS.SYNC, (data: HerdrSyncEvent) => {
    const p = { ...prefs(), ...(data.preferences?.herdr ?? {}) };
    if (!p.enabled || p.title === false) return;
    reporter.reportMetadata({
      title: buildHerdrTitle(data.state),
      stateLabels: buildStateLabels(data.state),
    });
  });
  pi.events.on(HERDR_CHANNELS.CLEAR, () => {
    reporter.reportMetadata({ title: null, stateLabels: {} });  // --clear-title + --clear-state-labels
  });
}
```

Notes:

- Event-name/payload accessors are thin adapters kept in `index.ts`, typed
  against the `@gsd/pi-coding-agent` event types. Concrete shapes (verified
  against `dist/core/gsd-extension-types.d.ts` /
  `dist/core/extensions/extension-upstream-types.d.ts`):
  - `NotificationEvent = { type: "notification"; kind: "blocked" | "input_needed" | "milestone_ready" | "idle" | "error"; message: string; details?: Record<string, unknown> }`
  - `StopEvent = { type: "stop"; reason: "completed" | "cancelled" | "error" | "blocked"; sessionId?: string; turnId?: string; ... }`
  - `SessionEndEvent = { type: "session_end"; reason; sessionFile?: string }`,
    `SessionShutdownEvent = { type: "session_shutdown"; reason; targetSessionFile?: string }`
  - `SessionStartEvent = { type: "session_start"; reason; previousSessionFile? }`
    — carries **no** session id/path.
- `blocked` classification: a `notification` event with `kind === "blocked"`
  or `kind === "input_needed"`; or a `stop` event with `reason === "blocked"`.
  Everything else resolves to `working` / `idle` from turn events.
- Session identity: `session_start` has no id, so the handler reads it from the
  handler's `ctx` — `ctx.sessionManager.getSessionId()` and
  `ctx.sessionManager.getSessionFile()` (`ReadonlySessionManager`). If both are
  empty, `reportSession` is skipped.
- Subscriptions to `pi.events` channels are added **synchronously** in the
  factory body (not behind an awaited `session_start`) so a `SYNC` emitted in
  the same event-loop turn as extension load is not lost — this is the exact
  footgun called out in the removed `register-extension.ts` comment.

### 6.5 Reading preferences on the consumer side

`readHerdrPrefs()` (in `index.ts` or a tiny `prefs.ts`):

```ts
function readHerdrPrefs(): Required<NonNullable<HerdrPreferencesInput["herdr"]>> {
  try {
    const p = loadEffectiveGSDPreferences()?.preferences?.herdr ?? {};
    return { enabled: p.enabled !== false, notifications: p.notifications !== false, title: p.title !== false };
  } catch {
    return { enabled: true, notifications: true, title: true };
  }
}
```

This imports `loadEffectiveGSDPreferences` from `../gsd/preferences.js`. That is
a one-way dependency `herdr → gsd/preferences` on an already widely-imported
entry point (`src/cli.ts`, `notifications.ts`, …). It does **not** make `herdr`
import GSD workflow internals — auto-mode state still arrives only through the
neutral channel. Accepted tradeoff; the alternative (duplicating preference
resolution) is worse.

Auto-mode `SYNC` events also carry a `preferences.herdr` slice from the emitter;
`index.ts` merges that over the locally-read value so a project-scoped override
active in the running auto session wins without a re-read.

### 6.6 GSD emitter side

Restore, renamed, exactly what commit `9b5c992c` removed — minus the `LOG`
channel:

```ts
// auto.ts
function makeHerdrEmitters(pi: ExtensionAPI) {
  return {
    syncHerdr: (preferences: GSDPreferences | undefined, state: GSDState) =>
      pi.events.emit(HERDR_CHANNELS.SYNC, { preferences, state }),
    clearHerdr: (preferences: GSDPreferences | undefined) =>
      pi.events.emit(HERDR_CHANNELS.CLEAR, { preferences }),
  };
}
```

Wired into `LoopDeps` as `syncHerdr` / `clearHerdr`. Emit sites (all
best-effort, wrapped so a throw never blocks auto-mode — same guard the cmux
code used):

| Site | Call |
| --- | --- |
| `startAuto` after first `deriveState` | `syncHerdr(prefs, state)` |
| `startAuto` resume path after `rebuildState` | `syncHerdr(prefs, state)` |
| `runPreDispatch` once per loop (old `deps.syncCmuxSidebar` line) | `deps.syncHerdr(prefs, state)` |
| `stopAuto` step 9 | `clearHerdr(loadedPreferences)` |
| `buildLoopDeps` → `handleLostSessionLock` | `clearHerdr(prefs)` |

`GSDState` already exposes `phase`, `activeMilestone`, `activeSlice`,
`activeTask`, `progress` (the fields `HerdrStateInput` structurally needs — same
shape `CmuxStateInput` used).

### 6.7 Notification routing

In `notifications.ts` `sendDesktopNotification`, before the native
`buildDesktopNotificationCommand` branch:

```ts
try {
  const herdrEnv = detectHerdrEnv();
  const herdrPrefs = loadedPreferences?.herdr;
  if (herdrEnv && herdrPrefs?.notifications !== false && herdrPrefs?.enabled !== false) {
    new HerdrReporter({ env: herdrEnv }).reportMetadata({
      stateLabels: { blocked: `${title}: ${message}` },
    });
    // Herdr surfaces attention via pane state; skip the native toast.
    return;
  }
} catch { /* fall through to native toast */ }
```

In practice `sendDesktopNotification` is called with `kind === "attention"`
(GSD's `NotificationKind`) for blocked/question events; the Herdr branch keys
off *being inside Herdr* + the `herdr` prefs, not off the pi
`NotificationEvent.kind`. Native toast remains the fallback whenever Herdr
delivery is unavailable or disabled. `detectHerdrEnv` / `HerdrReporter` are
imported from `../herdr/…` — a `gsd → herdr` import that is acceptable because
`reporter.ts` / `env.ts` are leaf modules with no back-import of `gsd`.

> Open question for review: is a `blocked` **state-label** the right Herdr
> surface for a notification, or should we prefer `report-agent --state blocked
> --message` (lifecycle) here? Lifecycle is louder (workspace rollups, waits)
> but risks fighting the turn-event `idle`/`working` reports. Default in this
> spec: state-label only, lifecycle `blocked` comes solely from the
> `notification` handler in 6.4.

## 7. Preferences

### 7.1 Type (`preferences-types.ts`)

```ts
export interface HerdrPreferences {
  /** Master switch for the herdr extension's reporting. Default: true (opt-out). */
  enabled?: boolean;
  /** Route blocked/attention notifications through Herdr instead of the desktop toast. Default: true. */
  notifications?: boolean;
  /** Set the Herdr pane title/state-labels from GSD auto-mode progress. Default: true. */
  title?: boolean;
}
```

Add `herdr?: HerdrPreferences;` to `GSDPreferences`. All effects also require
`HERDR_ENV=1`; the block is inert outside Herdr regardless of values.

### 7.2 Validation (`preferences-validation.ts`)

Following the `notifications` pattern (~line 614):

```ts
if (preferences.herdr !== undefined) {
  if (preferences.herdr && typeof preferences.herdr === "object" && !Array.isArray(preferences.herdr)) {
    for (const key of ["enabled", "notifications", "title"] as const) {
      if (preferences.herdr[key] !== undefined && typeof preferences.herdr[key] !== "boolean") {
        errors.push(`herdr.${key} must be a boolean`);
      }
    }
    validated.herdr = preferences.herdr;
  } else {
    errors.push("herdr must be an object");
  }
}
```

### 7.3 Merge (`preferences.ts` `mergePreferences`, ~line 889)

```ts
herdr: (base.herdr || override.herdr)
  ? { ...(base.herdr ?? {}), ...(override.herdr ?? {}) }
  : undefined,
```

### 7.4 Docs

- `templates/PREFERENCES.md`: a commented block —
  ```yaml
  # herdr:                 # only affects sessions running inside a Herdr pane
  #   enabled: true        # master switch for Herdr reporting
  #   notifications: true  # route blocked/attention alerts through Herdr
  #   title: true          # show milestone/slice/task + phase as the pane title
  ```
- `docs/preferences-reference.md`: one entry describing the three keys, the
  `HERDR_ENV` gate, and that it is opt-out.

No `commands-prefs-wizard.ts` change and no bootstrap first-run prompt (explicit
non-goal).

## 8. Manifest

`src/resources/extensions/herdr/extension-manifest.json`:

```json
{
  "id": "herdr",
  "name": "Herdr",
  "version": "1.0.0",
  "description": "Report GSD lifecycle state and auto-mode context to a Herdr pane",
  "tier": "bundled",
  "requires": { "platform": ">=2.29.0" },
  "provides": {
    "hooks": ["session_start", "session_shutdown", "session_end", "agent_start", "turn_start", "turn_end", "stop", "notification"]
  }
}
```

No `tools`, `commands`, or `shortcuts`. `tier: "bundled"` → disableable via
`gsd extensions disable herdr`.

## 9. Testing

All new pure/seam-covered logic gets `node:test` unit tests under
`src/resources/extensions/herdr/tests/` (matches repo convention):

| Test file | Covers |
| --- | --- |
| `env.test.ts` | `detectHerdrEnv` truth table: all-present → object; each var missing → null; `HERDR_ENV` values `"0"`/`""`/unset → null; socket optional. `isHerdrTerminal` parity. |
| `reporter.test.ts` | exact argv for each of the 4 commands; `--seq` strictly increasing across mixed calls; dedup skips identical consecutive `reportState`/`reportMetadata` but not `release`; `message` change defeats dedup; `runner` throw is swallowed; title/label normalized + truncated to 80. |
| `state-mapping.test.ts` | `buildHerdrTitle` with/without milestone/slice/task; phase-only fallback; `buildStateLabels` progress fraction selection (tasks → slices → milestones) and empty case. |
| `lifecycle.test.ts` | fake `pi` (records `.on` handlers) + fake reporter: `agent_start`/`turn_start` → `working`; `turn_end`/`stop` → `idle`; attention `notification` → `blocked` w/ message; `session_shutdown` → single `release` (idempotent with `session_end`); `enabled:false` registers no lifecycle handlers; `SYNC` with `title:false` → no metadata call; `CLEAR` → clear-title call. |

GSD-side:

- Extend an existing auto-loop test (or add `herdr-emit.test.ts` near the
  removed `cmux.test.ts` location) asserting `pi.events.emit` is called with
  `HERDR_CHANNELS.SYNC` on start and `CLEAR` on `stopAuto`, using a fake `pi`.
- `preferences` validation/merge: add `herdr` cases to the existing
  `preferences.test.ts` (valid block passes; non-boolean key → error;
  base+override deep-merge keeps untouched keys).

Manual / integration (documented in the PR, not automated — no Herdr in CI):

1. `herdr` installed; run `gsd` inside a Herdr pane; `herdr pane get $HERDR_PANE_ID`
   shows `--source custom:gsd`, state flips `working`↔`idle` across a turn.
2. `gsd auto` in a project → pane title shows `M… S…/T… · <phase>`; clears on
   completion/stop.
3. Trigger a blocked state → pane shows blocked; no native desktop toast.
4. `HERDR_ENV` unset → none of the above; no `herdr` subprocess spawned
   (`execFile` never called — assert via a debug counter or strace-free code
   read).
5. `gsd extensions disable herdr` → total no-op even inside Herdr.

## 10. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Subprocess per state change is chatty (several `execFile` per turn). | Dedup consecutive identical reports; `turn_start`/`turn_end` are ~2 spawns/turn; 2 s timeout; fully async. Acceptable, matches Herdr's own CLI-wrapper guidance. Socket API remains a future optimization. |
| Herdr CLI surface drifts (flags renamed). | All argv built in one place (`reporter.ts`); failures are swallowed so drift degrades to "no status in Herdr," never a crash. Pin observed behavior in `reporter.test.ts`. |
| `notification` event shape / `kind` values differ from assumption. | Verified against `gsd-extension-types.d.ts`: allowlist is `kind` ∈ {`blocked`, `input_needed`} plus `stop.reason === "blocked"`. Unknown kinds ignored; lifecycle still driven by turn events. Adapter isolated in `index.ts`. |
| Two extensions racing on `pi.events` load order. | Consumer subscribes synchronously in factory body; emitter only fires on user-triggered `startAuto`, strictly later. |
| `gsd → herdr` import cycle. | `env.ts` / `reporter.ts` are leaf modules (only `node:*` imports). `herdr → gsd/preferences` is the only cross-edge and is one-way. Enforced by a note + the existing `non-extension-library` / discovery tests. |
| Session id not present on `session_start`. | `reportSession` skips when both id and path are absent; restore just won't be available, lifecycle still works. |
| Stale pane title after a crash (no `CLEAR`). | Herdr clears source metadata when the pane closes; also `release()` on `session_shutdown`/`session_end`. A `--ttl-ms` on metadata is a possible hardening (left out v1 to avoid the title vanishing mid-session). |

## 11. Rollout

Single PR. New extension auto-registers enabled on next launch after the
version/hash bump triggers `initResources`. No migration. Revertable by deleting
the `herdr/` dir + `shared/herdr-events.ts` and reverting the ~6 GSD-extension
hunks; `registry.json` tolerates an orphaned `herdr` entry.

## 12. Out-of-scope follow-ups

- Socket-API transport (`HERDR_SOCKET_PATH`) to drop subprocess spawns.
- Spawning Herdr splits for parallel subagents (`parallel` / `slice_parallel`).
- `herdr integration status`-style doctor check.
- Reading Herdr pane output for verification loops.
