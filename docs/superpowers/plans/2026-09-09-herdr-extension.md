# Herdr Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bundled `herdr` extension that reports GSD lifecycle state, session identity, and auto-mode context to a [Herdr](https://github.com/herdrdev/herdr) pane, and routes blocked notifications through Herdr — a total no-op outside Herdr.

**Architecture:** A discrete `src/resources/extensions/herdr/` extension owns env detection, a `HerdrReporter` that shells out to `$HERDR_BIN_PATH` CLI wrappers, lifecycle-event → state mapping, and consumption of a neutral `shared/herdr-events.ts` EventBus contract. The GSD extension emits `sync`/`clear` on that contract at the same auto-mode call sites the removed `cmux` integration used (commit `9b5c992c`), plus a Herdr branch in the desktop-notification helper. A `herdr` preferences block (opt-out) gates it.

**Tech Stack:** TypeScript (ESM, `--experimental-strip-types`), `node:test`, `node:child_process` `execFile`, `@gsd/pi-coding-agent` extension API, esbuild-based test compile (`scripts/compile-tests.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-09-herdr-extension-design.md` — read it alongside this plan. The plan implements the spec; where the plan gives concrete code, it wins over the spec's prose sketches.

## Global Constraints

- **CLI-only fork.** Package name is unscoped `gsd-pi`. Do not add web/daemon/MCP-server surface. `packages/mcp-server/` is load-bearing — do not touch it.
- **No-op outside Herdr.** Every runtime effect requires `detectHerdrEnv()` returning non-null (`HERDR_ENV === "1"` **and** non-empty `HERDR_PANE_ID` **and** non-empty `HERDR_BIN_PATH`). No subprocess may spawn otherwise.
- **Best-effort, never blocking.** All Herdr CLI calls are async (`execFile`, `timeout: 2000`, `windowsHide: true`) and every failure (non-zero exit, ENOENT, timeout, throw) is swallowed. Never `execFileSync` on any turn/event path.
- **One stable source.** `--source custom:gsd`, `--agent gsd` on every Herdr command. Every emitted command carries a strictly increasing `--seq` (process-lifetime monotonic integer).
- **Herdr CLI text limits.** Normalize `--title` / `--state-label` / token text before passing: strip control chars, collapse whitespace, truncate to 80 chars.
- **Extension tier `bundled`** → disable-able via `gsd extensions disable herdr`. No `tools`, `commands`, or `shortcuts` in the manifest.
- **Preferences are opt-out.** `herdr.enabled`, `herdr.notifications`, `herdr.title` all default to effectively `true`; absent block = all on (but still gated on being inside Herdr).
- **Neutral contract stays neutral.** `shared/herdr-events.ts` must not import from `../herdr/` or `../gsd/`. The `herdr` extension may import `../gsd/preferences.js` (one-way) but nothing else from `../gsd/`.
- **Event shapes (verified against `node_modules/@gsd/pi-coding-agent/dist/core/gsd-extension-types.d.ts` and `.../extensions/extension-upstream-types.d.ts`):**
  - `NotificationEvent = { type: "notification"; kind: "blocked" | "input_needed" | "milestone_ready" | "idle" | "error"; message: string; details?: Record<string, unknown> }`
  - `StopEvent = { type: "stop"; reason: "completed" | "cancelled" | "error" | "blocked"; sessionId?: string; turnId?: string }`
  - `SessionStartEvent = { type: "session_start"; reason: "startup" | "reload" | "new" | "resume" | "fork"; previousSessionFile?: string }` — **no** session id/path; read identity from `ctx.sessionManager.getSessionId()` / `.getSessionFile()`.
  - `SessionShutdownEvent = { type: "session_shutdown"; reason; targetSessionFile? }`, `SessionEndEvent = { type: "session_end"; reason; sessionFile? }`
  - `AgentStartEvent = { type: "agent_start" }`, `TurnStartEvent = { type: "turn_start"; turnIndex; timestamp }`, `TurnEndEvent = { type: "turn_end"; ... }`

---

## Setup (do once, before Task 1)

- [ ] **Branch off the fork's main line**

```bash
cd /Users/mirogers/git/eagle27272/gsd-pi
git fetch origin
git switch main
git switch -c personal/herdr-extension
```

If `main` is not the intended base, ask the user first. Do not build on the unrelated `personal/gsd-bug-report` branch.

- [ ] **Confirm the reference material is reachable**

```bash
git show 9b5c992c --stat | head -30        # the cmux removal — the mirror for the GSD-side hunks
sed -n '1,60p' docs/superpowers/specs/2026-09-09-herdr-extension-design.md
```

---

## File Structure

**Create:**

| Path | Responsibility |
| --- | --- |
| `src/resources/extensions/shared/herdr-events.ts` | Neutral EventBus contract: channel constants + payload/structural types. Imported by both sides. |
| `src/resources/extensions/herdr/env.ts` | `detectHerdrEnv()` / `isHerdrTerminal()` — pure env parsing. |
| `src/resources/extensions/herdr/state-mapping.ts` | `buildHerdrTitle()` / `buildStateLabels()` — pure `HerdrStateInput` → display strings. |
| `src/resources/extensions/herdr/reporter.ts` | `HerdrReporter` — CLI-wrapper client: argv construction, seq, dedup, normalization, swallowed async exec. |
| `src/resources/extensions/herdr/index.ts` | Extension factory: env gate, pi lifecycle subscriptions, contract-channel subscriptions, `readHerdrPrefs()`. |
| `src/resources/extensions/herdr/extension-manifest.json` | Manifest (`id: "herdr"`, `tier: "bundled"`). |
| `src/resources/extensions/shared/tests/herdr-events.test.ts` | Contract constants are stable. |
| `src/resources/extensions/herdr/tests/env.test.ts` | Detection truth table. |
| `src/resources/extensions/herdr/tests/state-mapping.test.ts` | Title/label formatting. |
| `src/resources/extensions/herdr/tests/reporter.test.ts` | argv, seq monotonicity, dedup, swallow, normalization. |
| `src/resources/extensions/herdr/tests/lifecycle.test.ts` | pi-event → reporter-call mapping via fakes. |

**Modify:**

| Path | Change |
| --- | --- |
| `package.json` | Add `dist-test/src/resources/extensions/herdr/tests/*.test.js` to `test:unit:compiled` and `test:coverage:unit` globs. |
| `src/resources/extensions/shared/terminal.ts` | Add `isHerdrTerminal()`; `supportsCtrlAltShortcuts()` treats Herdr panes as capable. |
| `src/resources/extensions/gsd/preferences-types.ts` | `HerdrPreferences` interface + `herdr?` on `GSDPreferences`. |
| `src/resources/extensions/gsd/preferences-validation.ts` | Validate the `herdr` block. |
| `src/resources/extensions/gsd/preferences.ts` | Deep-merge `herdr` in `mergePreferences`. |
| `src/resources/extensions/gsd/auto/loop-deps.ts` | Add `syncHerdr` / `clearHerdr` optional members to `LoopDeps`. |
| `src/resources/extensions/gsd/auto.ts` | `makeHerdrEmitters(pi)`; wire into `buildLoopDeps`; emit in `startAuto` (initial + resume), `stopAuto`, `handleLostSessionLock`. |
| `src/resources/extensions/gsd/auto/pre-dispatch.ts` | Emit `syncHerdr(prefs, state)` once per loop (old `deps.syncCmuxSidebar` site). |
| `src/resources/extensions/gsd/notifications.ts` | Herdr delivery branch in `sendDesktopNotification`. |
| `src/resources/extensions/gsd/templates/PREFERENCES.md` | Document the `herdr` block. |
| `src/resources/extensions/gsd/docs/preferences-reference.md` | Reference entry for `herdr`. |

---

## Task 1: Neutral event contract

**Files:**
- Create: `src/resources/extensions/shared/herdr-events.ts`
- Test: `src/resources/extensions/shared/tests/herdr-events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `HERDR_CHANNELS: { readonly SYNC: "herdr:sync"; readonly CLEAR: "herdr:clear" }`
  - `interface HerdrPreferencesInput { herdr?: { enabled?: boolean; notifications?: boolean; title?: boolean } }`
  - `interface HerdrStateInput { phase: string; activeMilestone?: { id: string; title?: string }; activeSlice?: { id: string }; activeTask?: { id: string }; progress?: { milestones: { done: number; total: number }; slices?: { done: number; total: number }; tasks?: { done: number; total: number } } }`
  - `interface HerdrSyncEvent { preferences?: HerdrPreferencesInput; state: HerdrStateInput }`
  - `interface HerdrClearEvent { preferences?: HerdrPreferencesInput }`

- [ ] **Step 1: Write the failing test**

Create `src/resources/extensions/shared/tests/herdr-events.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { HERDR_CHANNELS } from "../herdr-events.ts";

test("HERDR_CHANNELS has stable wire values", () => {
  assert.equal(HERDR_CHANNELS.SYNC, "herdr:sync");
  assert.equal(HERDR_CHANNELS.CLEAR, "herdr:clear");
  assert.deepEqual(Object.keys(HERDR_CHANNELS).sort(), ["CLEAR", "SYNC"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/shared/tests/herdr-events.test.ts`
Expected: FAIL — `Cannot find module '../herdr-events.ts'`.

- [ ] **Step 3: Write the contract module**

Create `src/resources/extensions/shared/herdr-events.ts`:

```ts
// gsd-pi — Shared Herdr event channel contracts.
//
// Neutral module for gsd <-> herdr decoupling: both the GSD extension and the
// herdr extension import from here; neither imports the other. Mirrors the
// pattern of the removed shared/cmux-events.ts (commit 9b5c992c).

export const HERDR_CHANNELS = {
  /** Auto-mode workflow state changed; refresh the Herdr pane title / state labels. */
  SYNC: "herdr:sync",
  /** Auto-mode ended; clear GSD-owned Herdr pane title / state labels. */
  CLEAR: "herdr:clear",
} as const;

/** Structural slice of GSD preferences the herdr side needs. */
export interface HerdrPreferencesInput {
  herdr?: {
    enabled?: boolean; // default: true
    notifications?: boolean; // default: true
    title?: boolean; // default: true
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

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/shared/tests/herdr-events.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck**

Run: `pnpm run typecheck:extensions`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/resources/extensions/shared/herdr-events.ts src/resources/extensions/shared/tests/herdr-events.test.ts
git commit -m "feat(herdr): neutral shared/herdr-events.ts contract

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Env detection + terminal capability

**Files:**
- Create: `src/resources/extensions/herdr/env.ts`
- Create: `src/resources/extensions/herdr/tests/env.test.ts`
- Modify: `package.json` (test globs)
- Modify: `src/resources/extensions/shared/terminal.ts:9-19`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface HerdrEnv { paneId: string; binPath: string; socketPath?: string }`
  - `function detectHerdrEnv(env?: NodeJS.ProcessEnv): HerdrEnv | null`
  - `function isHerdrTerminal(env?: NodeJS.ProcessEnv): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/resources/extensions/herdr/tests/env.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { detectHerdrEnv, isHerdrTerminal } from "../env.ts";

const base = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p2",
  HERDR_BIN_PATH: "/usr/local/bin/herdr",
  HERDR_SOCKET_PATH: "/tmp/herdr.sock",
} as NodeJS.ProcessEnv;

test("detectHerdrEnv returns the env when all required vars are present", () => {
  assert.deepEqual(detectHerdrEnv(base), {
    paneId: "w1:p2",
    binPath: "/usr/local/bin/herdr",
    socketPath: "/tmp/herdr.sock",
  });
});

test("detectHerdrEnv omits socketPath when unset", () => {
  const { HERDR_SOCKET_PATH, ...rest } = base as Record<string, string>;
  assert.deepEqual(detectHerdrEnv(rest), {
    paneId: "w1:p2",
    binPath: "/usr/local/bin/herdr",
    socketPath: undefined,
  });
});

test("detectHerdrEnv returns null when HERDR_ENV is not exactly '1'", () => {
  assert.equal(detectHerdrEnv({ ...base, HERDR_ENV: "0" }), null);
  assert.equal(detectHerdrEnv({ ...base, HERDR_ENV: "" }), null);
  assert.equal(detectHerdrEnv({ ...base, HERDR_ENV: "true" }), null);
});

test("detectHerdrEnv returns null when pane id or bin path is missing/empty", () => {
  assert.equal(detectHerdrEnv({ ...base, HERDR_PANE_ID: "" }), null);
  assert.equal(detectHerdrEnv({ ...base, HERDR_PANE_ID: "   " }), null);
  const { HERDR_BIN_PATH, ...noBin } = base as Record<string, string>;
  assert.equal(detectHerdrEnv(noBin), null);
});

test("detectHerdrEnv returns null on an empty environment", () => {
  assert.equal(detectHerdrEnv({}), null);
});

test("isHerdrTerminal mirrors detectHerdrEnv truthiness", () => {
  assert.equal(isHerdrTerminal(base), true);
  assert.equal(isHerdrTerminal({}), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/herdr/tests/env.test.ts`
Expected: FAIL — cannot find `../env.ts`.

- [ ] **Step 3: Write `env.ts`**

Create `src/resources/extensions/herdr/env.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/herdr/tests/env.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Register the herdr test glob in package.json**

In `package.json`, edit the `test:unit:compiled` script: after the
`"dist-test/src/resources/extensions/shared/tests/*.test.js"` entry, add
`"dist-test/src/resources/extensions/herdr/tests/*.test.js"`. Make the identical
addition to the `test:coverage:unit` script (same glob list). Leave every other
glob unchanged.

- [ ] **Step 6: Add the Herdr terminal-capability guard**

In `src/resources/extensions/shared/terminal.ts`, add an import-free helper and
extend the capability check. Replace lines 9-19 (the `isCmuxTerminal` +
`supportsCtrlAltShortcuts` block) with:

```ts
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
```

(This duplicates the small detection predicate rather than importing from
`../herdr/env.js` — `shared/terminal.ts` is a leaf module imported widely,
including by `subagent/`, and must not gain a `herdr/` dependency.)

- [ ] **Step 7: Typecheck**

Run: `pnpm run typecheck:extensions`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/resources/extensions/herdr/env.ts src/resources/extensions/herdr/tests/env.test.ts src/resources/extensions/shared/terminal.ts package.json
git commit -m "feat(herdr): env detection + Herdr terminal-capability guard

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: State → display mapping

**Files:**
- Create: `src/resources/extensions/herdr/state-mapping.ts`
- Create: `src/resources/extensions/herdr/tests/state-mapping.test.ts`

**Interfaces:**
- Consumes: `HerdrStateInput` from `../shared/herdr-events.ts` (Task 1).
- Produces:
  - `type HerdrLabelState = "working" | "idle" | "blocked"`
  - `function buildHerdrTitle(s: HerdrStateInput): string`
  - `function buildStateLabels(s: HerdrStateInput): Partial<Record<HerdrLabelState, string>>`

- [ ] **Step 1: Write the failing test**

Create `src/resources/extensions/herdr/tests/state-mapping.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildHerdrTitle, buildStateLabels } from "../state-mapping.ts";
import type { HerdrStateInput } from "../../shared/herdr-events.ts";

test("buildHerdrTitle: milestone + slice + task + phase", () => {
  const s: HerdrStateInput = {
    phase: "executing",
    activeMilestone: { id: "M2" },
    activeSlice: { id: "S1" },
    activeTask: { id: "T3" },
  };
  assert.equal(buildHerdrTitle(s), "M2 S1/T3 · executing");
});

test("buildHerdrTitle: milestone only", () => {
  assert.equal(
    buildHerdrTitle({ phase: "planning", activeMilestone: { id: "M2" } }),
    "M2 · planning",
  );
});

test("buildHerdrTitle: milestone + task, no slice → space-joined (not M2/T3)", () => {
  assert.equal(
    buildHerdrTitle({ phase: "executing", activeMilestone: { id: "M2" }, activeTask: { id: "T3" } }),
    "M2 T3 · executing",
  );
});

test("buildHerdrTitle: no unit → phase only", () => {
  assert.equal(buildHerdrTitle({ phase: "researching" }), "researching");
});

test("buildHerdrTitle: normalizes and truncates to 80 chars", () => {
  const s: HerdrStateInput = {
    phase: "executing",
    activeMilestone: { id: "M1", title: "x".repeat(200) },
  };
  const out = buildHerdrTitle(s);
  assert.ok(out.length <= 80, `expected <=80, got ${out.length}`);
  assert.ok(!/\s{2,}/.test(out));
});

test("buildStateLabels: progress fraction prefers tasks, then slices, then milestones", () => {
  assert.deepEqual(
    buildStateLabels({
      phase: "executing",
      activeMilestone: { id: "M2" },
      progress: {
        milestones: { done: 1, total: 4 },
        slices: { done: 2, total: 3 },
        tasks: { done: 3, total: 8 },
      },
    }),
    { working: "M2 · 3/8 tasks" },
  );
  assert.deepEqual(
    buildStateLabels({
      phase: "executing",
      progress: { milestones: { done: 1, total: 4 } },
    }),
    { working: "1/4 milestones" },
  );
});

test("buildStateLabels: no progress → empty object", () => {
  assert.deepEqual(buildStateLabels({ phase: "planning" }), {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/herdr/tests/state-mapping.test.ts`
Expected: FAIL — cannot find `../state-mapping.ts`.

- [ ] **Step 3: Write `state-mapping.ts`**

Create `src/resources/extensions/herdr/state-mapping.ts`:

```ts
// gsd-pi — Map GSD workflow state onto Herdr pane display strings.
// Pure functions; mirrors the removed cmux buildCmuxStatusLabel / buildCmuxProgress.

import type { HerdrStateInput } from "../shared/herdr-events.js";

export type HerdrLabelState = "working" | "idle" | "blocked";

const MAX = 80;

/** Strip control chars, collapse whitespace, hard-truncate to Herdr's 80-char cap. */
export function normalizeDisplay(value: string): string {
  return value
    .replace(/[ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX);
}

/**
 * e.g. "M2 S1/T3 · executing", "M2 T3 · executing" (no slice), "M2 · planning",
 * or just "researching". The task id joins the slice with "/" ONLY when a slice
 * is active; without a slice it joins the milestone id with a space.
 */
export function buildHerdrTitle(s: HerdrStateInput): string {
  const unit: string[] = [];
  if (s.activeMilestone) unit.push(s.activeMilestone.id);
  if (s.activeSlice) unit.push(s.activeSlice.id);
  if (s.activeTask) {
    if (s.activeSlice) {
      const prev = unit.pop();
      unit.push(prev ? `${prev}/${s.activeTask.id}` : s.activeTask.id);
    } else {
      unit.push(s.activeTask.id);
    }
  }
  const left = unit.join(" ");
  return normalizeDisplay(left ? `${left} · ${s.phase}` : s.phase);
}

/** A `working` state-label carrying the tightest available progress fraction. */
export function buildStateLabels(s: HerdrStateInput): Partial<Record<HerdrLabelState, string>> {
  const p = s.progress;
  if (!p) return {};
  const pick = (done: number, total: number, noun: string): string | null =>
    total > 0 ? `${done}/${total} ${noun}` : null;

  const frac =
    pick(p.tasks?.done ?? 0, p.tasks?.total ?? 0, "tasks") ??
    pick(p.slices?.done ?? 0, p.slices?.total ?? 0, "slices") ??
    pick(p.milestones.done, p.milestones.total, "milestones");

  if (!frac) return {};
  const prefix = s.activeMilestone ? `${s.activeMilestone.id} · ` : "";
  return { working: normalizeDisplay(`${prefix}${frac}`) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/herdr/tests/state-mapping.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm run typecheck:extensions`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/resources/extensions/herdr/state-mapping.ts src/resources/extensions/herdr/tests/state-mapping.test.ts
git commit -m "feat(herdr): GSD state -> Herdr title/label mapping

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: HerdrReporter (CLI wrapper)

**Files:**
- Create: `src/resources/extensions/herdr/reporter.ts`
- Create: `src/resources/extensions/herdr/tests/reporter.test.ts`

**Interfaces:**
- Consumes: `HerdrEnv` from `./env.ts` (Task 2); `normalizeDisplay` from `./state-mapping.ts` (Task 3).
- Produces:
  - `type HerdrState = "working" | "idle" | "blocked" | "unknown"`
  - `type HerdrRunner = (file: string, args: string[]) => void`
  - `interface HerdrReporterOptions { env: HerdrEnv; source?: string; agent?: string; runner?: HerdrRunner }`
  - `class HerdrReporter` with:
    - `constructor(opts: HerdrReporterOptions)`
    - `reportState(state: HerdrState, opts?: { message?: string }): void`
    - `reportSession(opts: { sessionId?: string; sessionPath?: string }): void`
    - `reportMetadata(opts: { title?: string | null; stateLabels?: Partial<Record<string, string>> }): void`
    - `release(): void`

- [ ] **Step 1: Write the failing test**

Create `src/resources/extensions/herdr/tests/reporter.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { HerdrReporter } from "../reporter.ts";
import type { HerdrEnv } from "../env.ts";

const env: HerdrEnv = { paneId: "w1:p2", binPath: "/bin/herdr" };

function spyReporter() {
  const calls: string[][] = [];
  const r = new HerdrReporter({ env, runner: (_file, args) => calls.push(args) });
  return { r, calls };
}

test("reportState builds the documented report-agent argv", () => {
  const { r, calls } = spyReporter();
  r.reportState("working");
  assert.deepEqual(calls[0], [
    "pane", "report-agent", "w1:p2",
    "--source", "custom:gsd", "--agent", "gsd",
    "--state", "working", "--seq", "1",
  ]);
});

test("reportState appends --message when given", () => {
  const { r, calls } = spyReporter();
  r.reportState("blocked", { message: "waiting on approval" });
  assert.deepEqual(calls[0].slice(-4), ["--seq", "1", "--message", "waiting on approval"]);
});

test("--seq strictly increases across mixed calls", () => {
  const { r, calls } = spyReporter();
  r.reportState("working");
  r.reportMetadata({ title: "M1 · planning" });
  r.reportSession({ sessionId: "abc" });
  r.release();
  const seqs = calls.map((a) => Number(a[a.indexOf("--seq") + 1]));
  assert.deepEqual(seqs, [1, 2, 3, 4]);
});

test("reportState dedups identical consecutive calls but not after a change", () => {
  const { r, calls } = spyReporter();
  r.reportState("working");
  r.reportState("working");
  r.reportState("idle");
  r.reportState("idle", { message: "done" });
  assert.deepEqual(calls.map((a) => a[a.indexOf("--state") + 1]), ["working", "idle", "idle"]);
});

test("reportMetadata dedups identical payloads", () => {
  const { r, calls } = spyReporter();
  r.reportMetadata({ title: "M1", stateLabels: { working: "1/2 tasks" } });
  r.reportMetadata({ title: "M1", stateLabels: { working: "1/2 tasks" } });
  assert.equal(calls.length, 1);
});

test("reportMetadata: null title emits --clear-title; empty labels emit --clear-state-labels", () => {
  const { r, calls } = spyReporter();
  r.reportMetadata({ title: null, stateLabels: {} });
  assert.ok(calls[0].includes("--clear-title"));
  assert.ok(calls[0].includes("--clear-state-labels"));
});

test("reportMetadata: one --state-label per entry", () => {
  const { r, calls } = spyReporter();
  r.reportMetadata({ title: "M1", stateLabels: { working: "w", blocked: "b" } });
  const labels = calls[0].filter((_, i) => calls[0][i - 1] === "--state-label");
  assert.deepEqual(labels.sort(), ["blocked=b", "working=w"]);
});

test("release is never deduped and resets the dedup caches", () => {
  const { r, calls } = spyReporter();
  r.reportState("idle");
  r.release();
  r.release();
  r.reportState("idle"); // sends again — cache was reset by release
  assert.deepEqual(
    calls.map((a) => a[1]),
    ["report-agent", "release-agent", "release-agent", "report-agent"],
  );
});

test("title/label text is normalized and truncated to 80 chars", () => {
  const { r, calls } = spyReporter();
  r.reportMetadata({ title: "a\nb   c" + "x".repeat(200) });
  const title = calls[0][calls[0].indexOf("--title") + 1];
  assert.ok(title.length <= 80);
  assert.ok(!/\s{2,}/.test(title) && !title.includes("\n"));
});

test("a throwing runner is swallowed", () => {
  const r = new HerdrReporter({ env, runner: () => { throw new Error("boom"); } });
  assert.doesNotThrow(() => r.reportState("working"));
});

test("the default runner does not spawn for a bogus bin (smoke: no throw)", () => {
  const r = new HerdrReporter({ env: { paneId: "w1:p2", binPath: "/nonexistent/herdr-xyz" } });
  assert.doesNotThrow(() => r.reportState("working"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/herdr/tests/reporter.test.ts`
Expected: FAIL — cannot find `../reporter.ts`.

- [ ] **Step 3: Write `reporter.ts`**

Create `src/resources/extensions/herdr/reporter.ts`:

```ts
// gsd-pi — Herdr CLI reporter.
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
      /* ignore stdout/stderr/exit — best effort */
    });
    child.on("error", () => {
      /* ENOENT / spawn failure — best effort */
    });
  } catch {
    /* synchronous spawn failure — best effort */
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

  private run(tail: string[]): void {
    this.seq += 1;
    const args = [...tail.slice(0, 3), ...this.identity(), ...tail.slice(3), "--seq", String(this.seq)];
    // tail is [verb, subverb, paneId, ...rest]; identity goes right after paneId.
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
    const key = `${state} ${opts.message ?? ""}`;
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    const rest = ["--state", state];
    if (opts.message) rest.push("--message", normalizeDisplay(opts.message));
    this.run(["pane", "report-agent", this.env.paneId, ...rest]);
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
```

> Note on `run()`: it inserts identity flags directly after the pane id so the
> emitted argv is exactly `pane <verb> <paneId> --source … --agent … <rest> --seq N`,
> matching the CLI reference. The test in Step 1 pins this order.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/herdr/tests/reporter.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm run typecheck:extensions`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/resources/extensions/herdr/reporter.ts src/resources/extensions/herdr/tests/reporter.test.ts
git commit -m "feat(herdr): HerdrReporter CLI wrapper (seq, dedup, best-effort)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Extension factory + manifest

**Files:**
- Create: `src/resources/extensions/herdr/index.ts`
- Create: `src/resources/extensions/herdr/extension-manifest.json`
- Create: `src/resources/extensions/herdr/tests/lifecycle.test.ts`

**Interfaces:**
- Consumes: `detectHerdrEnv`/`HerdrEnv` (Task 2), `HerdrReporter`/`HerdrState` (Task 4), `buildHerdrTitle`/`buildStateLabels` (Task 3), `HERDR_CHANNELS`/`HerdrSyncEvent`/`HerdrClearEvent` (Task 1), `loadEffectiveGSDPreferences` from `../gsd/preferences.js`, `ExtensionAPI` from `@gsd/pi-coding-agent`.
- Produces:
  - `export default function (pi: ExtensionAPI): void` — the extension factory.
  - Internal only (exported for tests): `export function __wire(pi: ExtensionAPI, reporter: Pick<HerdrReporter, "reportState" | "reportSession" | "reportMetadata" | "release">, prefs: () => { enabled: boolean; notifications: boolean; title: boolean }): void`
  - `export function isBlockedNotification(kind: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/resources/extensions/herdr/tests/lifecycle.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { __wire, isBlockedNotification } from "../index.ts";
import { HERDR_CHANNELS } from "../../shared/herdr-events.ts";

type Handler = (event: unknown, ctx?: unknown) => void;

function fakePi() {
  const on = new Map<string, Handler[]>();
  const busOn = new Map<string, Handler[]>();
  const add = (m: Map<string, Handler[]>, k: string, h: Handler) => {
    const arr = m.get(k) ?? [];
    arr.push(h);
    m.set(k, arr);
  };
  const pi = {
    on: (event: string, handler: Handler) => add(on, event, handler),
    events: {
      on: (event: string, handler: Handler) => add(busOn, event, handler),
      emit: (event: string, payload: unknown) => (busOn.get(event) ?? []).forEach((h) => h(payload)),
    },
  } as unknown as import("@gsd/pi-coding-agent").ExtensionAPI;
  const fire = (event: string, payload?: unknown, ctx?: unknown) =>
    (on.get(event) ?? []).forEach((h) => h(payload, ctx));
  return { pi, fire };
}

function fakeReporter() {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    reportState: (s: string, o?: unknown) => calls.push(["state", { s, o }]),
    reportSession: (o: unknown) => calls.push(["session", o]),
    reportMetadata: (o: unknown) => calls.push(["metadata", o]),
    release: () => calls.push(["release", null]),
  };
}

const allOn = () => ({ enabled: true, notifications: true, title: true });

test("agent_start / turn_start → working; turn_end / stop(completed) → idle", () => {
  const { pi, fire } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, allOn);
  fire("agent_start", { type: "agent_start" });
  fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
  fire("turn_end", { type: "turn_end" });
  fire("stop", { type: "stop", reason: "completed" });
  assert.deepEqual(rep.calls.map((c) => [c[0], (c[1] as any).s]), [
    ["state", "working"], ["state", "working"], ["state", "idle"], ["state", "idle"],
  ]);
});

test("stop(blocked) and blocked/input_needed notifications → blocked", () => {
  const { pi, fire } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, allOn);
  fire("stop", { type: "stop", reason: "blocked" });
  fire("notification", { type: "notification", kind: "blocked", message: "need approval" });
  fire("notification", { type: "notification", kind: "input_needed", message: "pick one" });
  fire("notification", { type: "notification", kind: "idle", message: "ignored" });
  assert.deepEqual(
    rep.calls.map((c) => [c[0], (c[1] as any).s, (c[1] as any).o?.message]),
    [["state", "blocked", undefined], ["state", "blocked", "need approval"], ["state", "blocked", "pick one"]],
  );
});

test("session_start reads identity from ctx.sessionManager", () => {
  const { pi, fire } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, allOn);
  fire("session_start", { type: "session_start", reason: "startup" }, {
    sessionManager: { getSessionId: () => "sid-1", getSessionFile: () => "/s/sid-1.jsonl" },
  });
  assert.deepEqual(rep.calls, [["session", { sessionId: "sid-1", sessionPath: "/s/sid-1.jsonl" }]]);
});

test("session_shutdown then session_end → exactly one release", () => {
  const { pi, fire } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, allOn);
  fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
  fire("session_end", { type: "session_end", reason: "user" });
  assert.deepEqual(rep.calls, [["release", null]]);
});

test("enabled:false registers no lifecycle handlers", () => {
  const { pi, fire } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, () => ({ enabled: false, notifications: true, title: true }));
  fire("agent_start", { type: "agent_start" });
  fire("turn_end", { type: "turn_end" });
  assert.equal(rep.calls.length, 0);
});

test("SYNC → reportMetadata with title + labels; title:false suppresses it", () => {
  const { pi } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, allOn);
  pi.events.emit(HERDR_CHANNELS.SYNC, {
    state: { phase: "executing", activeMilestone: { id: "M2" }, activeTask: { id: "T3" },
      progress: { milestones: { done: 1, total: 3 }, tasks: { done: 3, total: 8 } } },
  });
  assert.deepEqual(rep.calls, [["metadata", { title: "M2 T3 · executing", stateLabels: { working: "M2 · 3/8 tasks" } }]]);

  const rep2 = fakeReporter();
  const { pi: pi2 } = fakePi();
  __wire(pi2, rep2, () => ({ enabled: true, notifications: true, title: false }));
  pi2.events.emit(HERDR_CHANNELS.SYNC, { state: { phase: "executing", activeMilestone: { id: "M2" } } });
  assert.equal(rep2.calls.length, 0);
});

test("CLEAR → reportMetadata clears title + labels", () => {
  const { pi } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, allOn);
  pi.events.emit(HERDR_CHANNELS.CLEAR, {});
  assert.deepEqual(rep.calls, [["metadata", { title: null, stateLabels: {} }]]);
});

test("isBlockedNotification allowlist", () => {
  assert.equal(isBlockedNotification("blocked"), true);
  assert.equal(isBlockedNotification("input_needed"), true);
  assert.equal(isBlockedNotification("error"), false);
  assert.equal(isBlockedNotification("idle"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/herdr/tests/lifecycle.test.ts`
Expected: FAIL — cannot find `../index.ts`.

- [ ] **Step 3: Write `index.ts`**

Create `src/resources/extensions/herdr/index.ts`:

```ts
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
  pi.events.on(HERDR_CHANNELS.SYNC, (data: HerdrSyncEvent) => {
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
  pi.events.on(HERDR_CHANNELS.CLEAR, (_data: HerdrClearEvent) => {
    reporter.reportMetadata({ title: null, stateLabels: {} });
  });
}

export default function (pi: ExtensionAPI): void {
  const env = detectHerdrEnv();
  if (!env) return; // hard no-op outside Herdr

  const reporter = new HerdrReporter({ env });
  __wire(pi, reporter, readHerdrPrefs);
}
```

- [ ] **Step 4: Create the manifest**

Create `src/resources/extensions/herdr/extension-manifest.json`:

```json
{
  "id": "herdr",
  "name": "Herdr",
  "version": "1.0.0",
  "description": "Report GSD lifecycle state and auto-mode context to a Herdr pane",
  "tier": "bundled",
  "requires": { "platform": ">=2.29.0" },
  "provides": {
    "hooks": [
      "session_start",
      "session_shutdown",
      "session_end",
      "agent_start",
      "turn_start",
      "turn_end",
      "stop",
      "notification"
    ]
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/herdr/tests/lifecycle.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm run typecheck:extensions`
Expected: no new errors. If `pi.on(...)` handler types reject the `(event) => ...` arrows, widen the parameter with `as never`-free casts already shown (each handler casts `event`/`ctx` locally); do not change the `ExtensionAPI` type.

- [ ] **Step 7: Commit**

```bash
git add src/resources/extensions/herdr/index.ts src/resources/extensions/herdr/extension-manifest.json src/resources/extensions/herdr/tests/lifecycle.test.ts
git commit -m "feat(herdr): extension factory + manifest

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: `herdr` preferences block

**Files:**
- Modify: `src/resources/extensions/gsd/preferences-types.ts` (add interface near `CopilotCatalogPreferences`, field on `GSDPreferences`)
- Modify: `src/resources/extensions/gsd/preferences-validation.ts:613-620` (after the Notifications block)
- Modify: `src/resources/extensions/gsd/preferences.ts:889-891` (in `mergePreferences`, next to `notifications`)
- Test: `src/resources/extensions/gsd/tests/preferences.test.ts` (add cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: `interface HerdrPreferences { enabled?: boolean; notifications?: boolean; title?: boolean }`; `GSDPreferences.herdr?: HerdrPreferences`.

- [ ] **Step 1: Write the failing test**

Append to `src/resources/extensions/gsd/tests/preferences.test.ts` (match the file's existing `test(...)` / `describe(...)` style; if it uses `node:test` `describe`, place these inside a `describe("herdr preferences", ...)`):

```ts
test("herdr: valid block passes validation", () => {
  const { errors } = validatePreferences({ herdr: { enabled: true, notifications: false, title: true } } as any);
  assert.equal(errors.filter((e) => e.includes("herdr")).length, 0);
});

test("herdr: non-boolean key is rejected", () => {
  const { errors } = validatePreferences({ herdr: { enabled: "yes" } } as any);
  assert.ok(errors.some((e) => e.includes("herdr.enabled must be a boolean")));
});

test("herdr: non-object block is rejected", () => {
  const { errors } = validatePreferences({ herdr: true } as any);
  assert.ok(errors.some((e) => e.includes("herdr must be an object")));
});

test("herdr: base+override deep-merge keeps untouched keys", () => {
  const merged = mergePreferences(
    { herdr: { enabled: true, title: true } } as any,
    { herdr: { title: false } } as any,
  );
  assert.deepEqual(merged.herdr, { enabled: true, title: false });
});
```

Check the top of `preferences.test.ts` for the exact import names — it may import
`validatePreferences` from `../preferences-validation.js` and `mergePreferences`
from `../preferences.js`. If `mergePreferences` is not already exported/imported
in the test, import it: `import { mergePreferences } from "../preferences.js";`
(it is exported — see `preferences.ts`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/preferences.test.ts`
Expected: FAIL on the four new cases (no `herdr` handling yet; merge drops or mis-handles it).

- [ ] **Step 3: Add the type**

In `src/resources/extensions/gsd/preferences-types.ts`, add near the other small
config interfaces (e.g. just after `CopilotCatalogPreferences`, around line 111):

```ts
export interface HerdrPreferences {
  /** Master switch for Herdr reporting. Default: true (opt-out). Only affects sessions inside a Herdr pane. */
  enabled?: boolean;
  /** Route blocked/attention notifications through Herdr instead of the desktop toast. Default: true. */
  notifications?: boolean;
  /** Set the Herdr pane title/state-labels from GSD auto-mode progress. Default: true. */
  title?: boolean;
}
```

Then add the field to `GSDPreferences` (near `notifications?: NotificationPreferences;`):

```ts
  /** Herdr multiplexer integration. Inert outside a Herdr pane. See preferences reference. */
  herdr?: HerdrPreferences;
```

- [ ] **Step 4: Add validation**

In `src/resources/extensions/gsd/preferences-validation.ts`, immediately after the
`// ─── Notifications ───` block (ends ~line 620), add:

```ts
  // ─── Herdr ─────────────────────────────────────────────────────────
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

- [ ] **Step 5: Add the merge**

In `src/resources/extensions/gsd/preferences.ts`, inside `mergePreferences` (the
return object, next to the `notifications:` entry ~line 889):

```ts
    herdr: (base.herdr || override.herdr)
      ? { ...(base.herdr ?? {}), ...(override.herdr ?? {}) }
      : undefined,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/preferences.test.ts`
Expected: PASS including the four new cases.

- [ ] **Step 7: Typecheck**

Run: `pnpm run typecheck:extensions`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/resources/extensions/gsd/preferences-types.ts src/resources/extensions/gsd/preferences-validation.ts src/resources/extensions/gsd/preferences.ts src/resources/extensions/gsd/tests/preferences.test.ts
git commit -m "feat(herdr): herdr preferences block (types + validation + merge)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: GSD auto-mode emitters

**Files:**
- Modify: `src/resources/extensions/gsd/auto/loop-deps.ts:86+` (`LoopDeps` interface)
- Modify: `src/resources/extensions/gsd/auto.ts` (add `makeHerdrEmitters`; wire in `buildLoopDeps` ~line 2421; emit in `startAuto` ~2960/2990, `stopAuto` ~1657, `handleLostSessionLock` path ~2437)
- Modify: `src/resources/extensions/gsd/auto/pre-dispatch.ts:297` (before `let mid = state.activeMilestone?.id;`)
- Test: `src/resources/extensions/gsd/tests/herdr-emit.test.ts` (new)

**Interfaces:**
- Consumes: `HERDR_CHANNELS` from `../shared/herdr-events.js` (Task 1); `pi.events` (the shared `EventBus`).
- Produces (added to `LoopDeps`):
  - `syncHerdr?: (preferences: GSDPreferences | undefined, state: GSDState) => void`
  - `clearHerdr?: (preferences: GSDPreferences | undefined) => void`

**Reference:** `git show 9b5c992c -- src/resources/extensions/gsd/auto.ts src/resources/extensions/gsd/auto/pre-dispatch.ts` shows the exact cmux call sites this task mirrors (minus the `LOG` channel — there is no herdr log event).

- [ ] **Step 1: Write the failing test**

Create `src/resources/extensions/gsd/tests/herdr-emit.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { makeHerdrEmitters } from "../auto.ts";
import { HERDR_CHANNELS } from "../../shared/herdr-events.ts";

function fakePi() {
  const emitted: Array<[string, unknown]> = [];
  const pi = { events: { emit: (e: string, p: unknown) => emitted.push([e, p]) } } as any;
  return { pi, emitted };
}

test("syncHerdr emits SYNC with preferences + state", () => {
  const { pi, emitted } = fakePi();
  const { syncHerdr } = makeHerdrEmitters(pi);
  const state = { phase: "executing", activeMilestone: { id: "M1" } } as any;
  syncHerdr({ herdr: { enabled: true } } as any, state);
  assert.deepEqual(emitted, [[HERDR_CHANNELS.SYNC, { preferences: { herdr: { enabled: true } }, state }]]);
});

test("clearHerdr emits CLEAR with preferences", () => {
  const { pi, emitted } = fakePi();
  const { clearHerdr } = makeHerdrEmitters(pi);
  clearHerdr(undefined);
  assert.deepEqual(emitted, [[HERDR_CHANNELS.CLEAR, { preferences: undefined }]]);
});
```

If `makeHerdrEmitters` is not exported from `auto.ts` yet, this fails to import — that is the expected initial failure.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/herdr-emit.test.ts`
Expected: FAIL — `makeHerdrEmitters` is not exported.

- [ ] **Step 3: Add `LoopDeps` members**

In `src/resources/extensions/gsd/auto/loop-deps.ts`, inside `export interface LoopDeps { ... }`, near `updateProgressWidget`:

```ts
  /** Emit Herdr auto-mode context sync (no-op unless the herdr extension is listening). */
  syncHerdr?: (preferences: GSDPreferences | undefined, state: GSDState) => void;
  /** Emit Herdr clear when auto-mode ends. */
  clearHerdr?: (preferences: GSDPreferences | undefined) => void;
```

(`GSDPreferences` and `GSDState` are already imported in this file.)

- [ ] **Step 4: Add `makeHerdrEmitters` and wire it into `buildLoopDeps`**

In `src/resources/extensions/gsd/auto.ts`:

1. Add an import near the other `../shared/...` imports:

```ts
import { HERDR_CHANNELS } from "../shared/herdr-events.js";
```

2. Add the factory (top-level, near where `makeCmuxEmitters` used to be — see the
   removal diff; a good home is just above `buildLoopDeps`). It **must be
   `export`ed** — `herdr-emit.test.ts` imports it (the removed `makeCmuxEmitters`
   was private; this one is unit-tested):

```ts
export function makeHerdrEmitters(pi: ExtensionAPI) {
  return {
    syncHerdr: (preferences: GSDPreferences | undefined, state: GSDState) =>
      pi.events.emit(HERDR_CHANNELS.SYNC, { preferences, state }),
    clearHerdr: (preferences: GSDPreferences | undefined) =>
      pi.events.emit(HERDR_CHANNELS.CLEAR, { preferences }),
  };
}
```

3. In `buildLoopDeps(pi, ctx)` (~line 2421), spread the emitters into the returned
   `LoopDeps` object (alongside `updateProgressWidget`):

```ts
  const herdr = makeHerdrEmitters(pi);
  return {
    // ...existing members...
    updateProgressWidget,
    ...herdr,
    // ...
  };
```

4. In `handleLostSessionLock` wiring inside `buildLoopDeps` (~line 2437), clear
   Herdr before delegating (mirrors the removed
   `cmux.clearCmuxSidebar(...)` call):

```ts
    handleLostSessionLock: (ctx, lockStatus) => {
      herdr.clearHerdr(loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences);
      handleLostSessionLock(ctx, lockStatus);
    },
```

Use whatever the surrounding code already uses to read preferences here — match
the removed cmux line's argument exactly.

- [ ] **Step 5: Emit at start / resume / stop**

Still in `auto.ts`, restore the emits the cmux removal deleted from `startAuto`
and `stopAuto` (see `git show 9b5c992c -- src/resources/extensions/gsd/auto.ts`),
translated to herdr and dropping every `CMUX_CHANNELS.LOG` emit:

- In `startAuto`, after the initial `deriveState`/`rebuildState` where the loop
  begins (the non-resume path, ~line 3100 where `buildLoopDeps` is called), add a
  best-effort:

```ts
  try {
    loopDeps.syncHerdr?.(
      loadEffectiveGSDPreferences(s.basePath || undefined)?.preferences,
      await deriveState(s.basePath),
    );
  } catch (err) {
    logWarning("engine", `herdr sync failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }
```

- In the resume path (~line 2990, right after `await rebuildState(s.basePath);`),
  the same `syncHerdr?.(...)` call wrapped in `try/catch` with a `debugLog`.

- In `stopAuto` (~line 1657), at the cleanup step where the cmux code emitted
  `CMUX_CHANNELS.SIDEBAR {action:"clear"}` ("Step 9"), add:

```ts
    try {
      loopDeps?.clearHerdr?.(loadedPreferences);
    } catch (e) {
      debugLog("stop-cleanup-herdr", { error: e instanceof Error ? e.message : String(e) });
    }
```

Use the same `loopDeps` / `loadedPreferences` identifiers that are in scope at
that point in `stopAuto` (check the surrounding lines — the cmux code used
`pi?.events.emit(...)` directly; prefer the `loopDeps?.clearHerdr?.()` seam so
the emit is test-injectable, falling back to a direct
`pi?.events.emit(HERDR_CHANNELS.CLEAR, { preferences: loadedPreferences })` only
if `loopDeps` is not reachable there).

- [ ] **Step 6: Emit once per loop in pre-dispatch**

In `src/resources/extensions/gsd/auto/pre-dispatch.ts`, immediately before
`let mid = state.activeMilestone?.id;` (currently line 298), add:

```ts
  deps.syncHerdr?.(prefs, state);
```

`prefs` and `state` are both already in scope (see line 93:
`const { ctx, pi, s, deps, prefs } = ic;`). Do **not** re-add any of the
`logCmuxEvent` calls the removal deleted elsewhere in this file — there is no
herdr log channel.

- [ ] **Step 7: Run the new test + the auto-loop regression tests**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/herdr-emit.test.ts \
  src/resources/extensions/gsd/tests/auto-loop.test.ts
```
Expected: PASS. If `auto-loop.test.ts` builds a `LoopDeps` without `syncHerdr`,
the `?.` optional calls make that safe — no test change needed. If it asserts an
exact `emit` call count on a fake `pi`, update those expectations to allow the
new `herdr:sync` / `herdr:clear` events.

- [ ] **Step 8: Typecheck**

Run: `pnpm run typecheck:extensions`
Expected: no new errors.

- [ ] **Step 9: Commit**

```bash
git add src/resources/extensions/gsd/auto.ts src/resources/extensions/gsd/auto/loop-deps.ts src/resources/extensions/gsd/auto/pre-dispatch.ts src/resources/extensions/gsd/tests/herdr-emit.test.ts
git commit -m "feat(herdr): emit auto-mode context on the herdr event contract

Mirrors the cmux emit sites removed in 9b5c992c, minus the log channel.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: Notification routing through Herdr

**Files:**
- Modify: `src/resources/extensions/gsd/notifications.ts:30-58` (`sendDesktopNotification`)
- Test: `src/resources/extensions/gsd/tests/notifications.test.ts` (add cases; create if absent)

**Interfaces:**
- Consumes: `detectHerdrEnv` from `../herdr/env.js`, `HerdrReporter` from `../herdr/reporter.js`.
- Produces: `sendDesktopNotification` gains three optional test seams on `deps`:
  ```ts
  deps: {
    notifications?: NotificationPreferences;
    herdrEnv?: import("../herdr/env.js").HerdrEnv | null;
    herdrPrefs?: { enabled?: boolean; notifications?: boolean };
    herdrRun?: (file: string, args: string[]) => void;
  } = {}
  ```
  Real runtime reads env from `detectHerdrEnv()` and the `herdr` prefs from
  `loadedPreferences?.herdr`; `deps.herdrEnv` / `deps.herdrPrefs` override those
  for tests, `deps.herdrRun` is the `HerdrReporter` runner seam.

- [ ] **Step 1: Write the failing test**

Add to `src/resources/extensions/gsd/tests/notifications.test.ts` (create the file
with the standard `node:test` header if it does not exist):

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { sendDesktopNotification } from "../notifications.ts";

const herdrEnv = { paneId: "w1:p2", binPath: "/bin/herdr" };

test("inside Herdr, attention notification → delivered as a blocked state-label, no throw", () => {
  const calls: string[][] = [];
  assert.doesNotThrow(() =>
    sendDesktopNotification("GSD", "Blocked: needs input", "warning", "attention", undefined, {
      herdrEnv,
      herdrPrefs: { enabled: true, notifications: true },
      herdrRun: (_f, a) => calls.push(a),
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "report-metadata"); // argv[1] of `pane report-metadata ...`
  assert.ok(calls[0].some((x) => x.startsWith("blocked=")));
});

test("inside Herdr but herdrPrefs.notifications=false → no herdr delivery", () => {
  const calls: string[][] = [];
  sendDesktopNotification("GSD", "msg", "warning", "attention", undefined, {
    herdrEnv,
    herdrPrefs: { enabled: true, notifications: false },
    herdrRun: (_f, a) => calls.push(a),
  });
  assert.equal(calls.length, 0);
});

test("inside Herdr but herdrPrefs.enabled=false → no herdr delivery", () => {
  const calls: string[][] = [];
  sendDesktopNotification("GSD", "msg", "warning", "attention", undefined, {
    herdrEnv,
    herdrPrefs: { enabled: false, notifications: true },
    herdrRun: (_f, a) => calls.push(a),
  });
  assert.equal(calls.length, 0);
});

test("no herdrEnv → herdrRun is never called", () => {
  const calls: string[][] = [];
  sendDesktopNotification("GSD", "msg", "warning", "attention", undefined, {
    herdrEnv: null,
    herdrPrefs: { enabled: true, notifications: true },
    herdrRun: (_f, a) => calls.push(a),
  });
  assert.equal(calls.length, 0);
});
```

Note: `kind: "attention"` passes `shouldSendDesktopNotification` by default
(`on_attention ?? true`), so the herdr branch is reached without a `notifications`
entry in `deps`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/notifications.test.ts`
Expected: FAIL — `deps.herdrEnv` unsupported; no herdr delivery.

- [ ] **Step 3: Add the Herdr branch**

In `src/resources/extensions/gsd/notifications.ts`:

1. Add imports:

```ts
import { detectHerdrEnv, type HerdrEnv } from "../herdr/env.js";
import { HerdrReporter } from "../herdr/reporter.js";
```

2. Widen the `deps` parameter type and add the branch after
   `if (!shouldSendDesktopNotification(kind, notifications)) return;` and before
   the native `buildDesktopNotificationCommand` block:

```ts
  deps: {
    notifications?: NotificationPreferences;
    herdrEnv?: HerdrEnv | null;
    herdrPrefs?: { enabled?: boolean; notifications?: boolean };
    herdrRun?: (file: string, args: string[]) => void;
  } = {},
): void {
  // ...existing body: title rewrite, loadedPreferences, notifications,
  //    then `if (!shouldSendDesktopNotification(kind, notifications)) return;`

  try {
    const herdrEnv = deps.herdrEnv !== undefined ? deps.herdrEnv : detectHerdrEnv();
    const herdrPrefs = deps.herdrPrefs ?? loadedPreferences?.herdr;
    if (herdrEnv && herdrPrefs?.enabled !== false && herdrPrefs?.notifications !== false) {
      new HerdrReporter({ env: herdrEnv, runner: deps.herdrRun }).reportMetadata({
        stateLabels: { blocked: `${title}: ${message}` },
      });
      return; // Herdr surfaces attention via pane state; skip the native toast.
    }
  } catch {
    // fall through to the native desktop notification
  }

  try {
    const command = buildDesktopNotificationCommand(process.platform, title, message, level);
    if (!command) return;
    launchDesktopNotification(command);
  } catch {
    // Non-fatal — desktop notifications are best-effort
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/notifications.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm run typecheck:extensions`
Expected: no new errors. `gsd/notifications.ts` importing from `../herdr/env.js`
and `../herdr/reporter.js` is the only intended `gsd → herdr` edge; both are
leaf modules (no back-import of `gsd`).

- [ ] **Step 6: Commit**

```bash
git add src/resources/extensions/gsd/notifications.ts src/resources/extensions/gsd/tests/notifications.test.ts
git commit -m "feat(herdr): route blocked notifications through Herdr when inside it

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: Docs — PREFERENCES.md + preferences reference

**Files:**
- Modify: `src/resources/extensions/gsd/templates/PREFERENCES.md`
- Modify: `src/resources/extensions/gsd/docs/preferences-reference.md`

No test cycle — documentation only.

- [ ] **Step 1: Inspect the current structure**

```bash
grep -n "notifications:" src/resources/extensions/gsd/templates/PREFERENCES.md
grep -n "^## \|^### \|notifications" src/resources/extensions/gsd/docs/preferences-reference.md | head -40
```

- [ ] **Step 2: Add to `templates/PREFERENCES.md`**

Near the `notifications:` example block, add a commented block that matches the
file's existing comment style (leading `#`, two-space nesting):

```yaml
# herdr:                  # only affects sessions running inside a Herdr pane (HERDR_ENV=1)
#   enabled: true         # master switch for Herdr reporting
#   notifications: true   # route blocked/attention alerts through Herdr instead of the desktop toast
#   title: true           # show the active milestone/slice/task + phase as the Herdr pane title
```

- [ ] **Step 3: Add to `docs/preferences-reference.md`**

Add a section consistent with neighboring entries (heading level, "Default:",
"Type:" conventions as used in the file):

```markdown
### `herdr`

Integration with [Herdr](https://github.com/herdrdev/herdr), a terminal
multiplexer for coding agents. **Inert unless GSD is running inside a Herdr pane**
(`HERDR_ENV=1`). Opt-out — omitting the block leaves every sub-option on.

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch. When `false`, the `herdr` extension reports nothing. |
| `notifications` | boolean | `true` | Deliver blocked/attention notifications through Herdr (pane state) instead of the native desktop toast. |
| `title` | boolean | `true` | Set the Herdr pane title and `working` state-label from auto-mode progress (`M2 S1/T3 · executing`). |

Lifecycle reporting (`working`/`idle`/`blocked`) and native session-identity
reporting for Herdr restore are always on when `enabled` and inside Herdr.
Disable the whole integration with `gsd extensions disable herdr`.
```

- [ ] **Step 4: Commit**

```bash
git add src/resources/extensions/gsd/templates/PREFERENCES.md src/resources/extensions/gsd/docs/preferences-reference.md
git commit -m "docs(herdr): document the herdr preferences block

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 10: Full verification + changelog

**Files:**
- Modify: `CHANGELOG.md` (fork-baseline style — one entry)

- [ ] **Step 1: Typecheck the whole extensions tree**

Run: `pnpm run typecheck:extensions`
Expected: PASS, no new errors.

- [ ] **Step 2: Compile + run the full unit suite**

Run: `pnpm run test:compile && pnpm run test:unit:compiled`
Expected: the new files appear as
`dist-test/src/resources/extensions/herdr/tests/*.test.js` and run. All herdr +
shared/herdr-events + preferences + herdr-emit + notifications tests PASS. The
~23 known-baseline failures documented in the project memory
(`strip-to-cli-fork`) may still fail — confirm the count did not grow and no
herdr-related test is among them.

- [ ] **Step 3: Grep for accidental coupling**

```bash
grep -rn "from \"\.\./herdr/" src/resources/extensions/shared/ && echo "LEAK: shared imports herdr" || echo "ok: shared clean"
grep -rn "from \"\.\./gsd/" src/resources/extensions/herdr/ | grep -v "preferences.js" && echo "LEAK: herdr imports gsd beyond preferences" || echo "ok: herdr clean"
grep -rn "execFileSync\|execSync" src/resources/extensions/herdr/ && echo "LEAK: sync exec on herdr path" || echo "ok: no sync exec"
```
Expected: `ok:` on all three.

- [ ] **Step 4: Sanity-run the extension discovery test**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/extension-discovery.test.ts src/tests/non-extension-library.test.ts`
Expected: PASS — `herdr/` has a valid `extension-manifest.json` and a default
export, so discovery accepts it; `shared/herdr-events.ts` is a plain sibling
module (no `package.json`, not a directory) so it is not mistaken for an
extension.

- [ ] **Step 5: Add a CHANGELOG entry**

Append under the appropriate heading in `CHANGELOG.md`, matching the file's
existing entry format:

```markdown
- Added a bundled `herdr` extension: when GSD runs inside a [Herdr](https://github.com/herdrdev/herdr)
  pane it reports lifecycle state (working/idle/blocked), native session identity,
  and auto-mode context (milestone/slice/task + phase) as the pane title, and
  routes blocked notifications through Herdr. No-op outside Herdr. Opt-out via the
  `herdr` preferences block or `gsd extensions disable herdr`.
```

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(herdr): changelog entry for the herdr extension

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Manual integration checklist (record results in the PR, not automated)**

With `herdr` on `PATH` and a real Herdr pane:

1. `gsd` inside a Herdr pane → `herdr pane get "$HERDR_PANE_ID"` shows an agent
   from `--source custom:gsd`; state flips `working` ↔ `idle` across a turn.
2. `gsd auto` in a project → pane title shows `M… …/… · <phase>`; clears on
   milestone completion / `stopAuto`.
3. Force a blocked state → pane shows blocked; **no** native desktop toast fires.
4. Unset `HERDR_ENV` → none of the above; confirm no `herdr` subprocess is
   spawned (no entry in `herdr pane get`; code path returns at `detectHerdrEnv()`).
5. `gsd extensions disable herdr` → total no-op even inside Herdr; re-enable with
   `gsd extensions enable herdr`.

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
| --- | --- |
| §4.1 new files (`env`, `reporter`, `state-mapping`, `index`, manifest, tests) | Tasks 2–5 |
| §4.1 `shared/herdr-events.ts` | Task 1 |
| §4.2 `preferences-types` / `-validation` / `preferences.ts` | Task 6 |
| §4.2 `templates/PREFERENCES.md`, `docs/preferences-reference.md` | Task 9 |
| §4.2 `auto.ts`, `auto/pre-dispatch.ts`, `auto/types.ts`/`loop-deps.ts` | Task 7 |
| §4.2 `notifications.ts` | Task 8 |
| §4.2 `shared/terminal.ts` (`isHerdrTerminal`, `supportsCtrlAltShortcuts`) | Task 2 Step 6 |
| §5 two-channel contract (SYNC/CLEAR, no LOG) | Task 1 + Task 7 |
| §6.1 `detectHerdrEnv` rule (all three vars, `HERDR_ENV==="1"`) | Task 2 |
| §6.2 `HerdrReporter` (source/agent consts, seq, async execFile 2s, swallow, dedup, argv, normalization) | Task 4 |
| §6.3 `buildHerdrTitle` / `buildStateLabels` (tasks→slices→milestones) | Task 3 |
| §6.4 lifecycle mapping table + synchronous channel subscription | Task 5 |
| §6.4 blocked = `notification.kind ∈ {blocked,input_needed}` or `stop.reason==="blocked"` | Task 5 |
| §6.4 session identity from `ctx.sessionManager` | Task 5 |
| §6.5 `readHerdrPrefs()` + per-event pref merge | Task 5 |
| §6.6 `makeHerdrEmitters`, `LoopDeps` members, emit sites | Task 7 |
| §6.7 notification routing (state-label `blocked`, skip native toast, fall through on failure) | Task 8 |
| §7 preferences (type/validation/merge/docs) | Tasks 6, 9 |
| §8 manifest (id, tier bundled, hooks, no tools/commands/shortcuts) | Task 5 |
| §9 testing (env / reporter / state-mapping / lifecycle / gsd-emit / preferences) | Tasks 2–8 |
| §10 risks — coupling grep, no sync exec | Task 10 Step 3 |
| §11 rollout — auto-register on version bump, revert = delete dir + revert hunks | inherent; no task needed |
| §12 out-of-scope (socket, splits, doctor) | intentionally omitted |

No spec requirement is left without a task.

**2. Placeholder scan** — every code step contains complete code. Task 8 Step 1
carries an explicit "pick one shape and make test + impl agree" note about where
the `herdr.notifications` flag is read from; the two valid shapes are both
spelled out (read from `loadedPreferences.herdr` vs. inject via `deps`), so this
is a bounded decision, not a placeholder.

**3. Type consistency** — checked across tasks:
- `HERDR_CHANNELS.SYNC`/`.CLEAR` string values identical in Tasks 1, 5, 7.
- `HerdrStateInput` (Task 1) consumed unchanged by `state-mapping.ts` (Task 3) and the `HerdrSyncEvent.state` payload (Tasks 1, 5, 7).
- `HerdrEnv { paneId; binPath; socketPath? }` identical in Tasks 2, 4, 5, 8.
- `HerdrReporter` method names — `reportState` / `reportSession` / `reportMetadata` / `release` — identical in Tasks 4, 5, 8.
- `reportState(state, { message? })` signature matches every call site (Task 5 passes `{ message: e.message }`; Task 4 tests the same).
- `syncHerdr` / `clearHerdr` names identical in `LoopDeps` (Task 7 Step 3), `makeHerdrEmitters` (Task 7 Step 4), `pre-dispatch.ts` call (Task 7 Step 6), and the test (Task 7 Step 1).
- `readHerdrPrefs()` return shape `{ enabled; notifications; title }` matches the `prefs()` param of `__wire` (Task 5) and `deps` usage in Task 8.
- `HerdrPreferences` keys (`enabled`/`notifications`/`title`) identical in Task 6 (type + validation loop) and Task 1 (`HerdrPreferencesInput`).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-09-herdr-extension.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
