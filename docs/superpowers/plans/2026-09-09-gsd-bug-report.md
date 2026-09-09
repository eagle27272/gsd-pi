# gsd-pi Self-Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bundled `gsd-bug-report` extension that lets the agent draft a GitHub issue for a defect in the gsd-pi CLI itself and file it to `eagle27272/gsd-pi` only after in-session user confirmation.

**Architecture:** A new auto-discovered bundled extension under `src/resources/extensions/gsd-bug-report/`. It registers one agent tool (`report_gsd_bug`) whose `promptGuidelines` steer the model, plus a `/report-gsd-bug` command, plus a `session_start` reset hook. A pure core module does dedupe matching / body enrichment / draft rendering; a self-contained `gh` wrapper does issue search + create with a test seam; a tiny module holds the per-session filed-count. Every guarantee (confirm gate, dedupe, soft cap, environment capture, `gh`-missing fallback) is a code path with a test.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@sinclair/typebox` (`Type.*`) for tool parameter schemas, `@gsd/pi-coding-agent` `ExtensionAPI`, `node:child_process` `execFileSync` for `gh`, `node:test` + `node:assert/strict` for tests.

**Spec:** `docs/superpowers/specs/2026-09-09-gsd-bug-report-design.md`

## Global Constraints

- **Node built-in test runner only.** `import { describe, test, beforeEach, afterEach } from "node:test"` and `import assert from "node:assert/strict"`. No vitest, no jest. (CONTRIBUTING.md §Testing.)
- **ESM with explicit `.js` specifiers.** Source is `.ts`; imports of sibling modules use the `.js` extension (e.g. `import { isEnabled } from "./config.js"`). Test files import siblings with the `.ts` extension (e.g. `import { isEnabled } from "../config.ts"`), matching `src/resources/extensions/search-the-web/tests/*.test.ts`.
- **Target repo default:** `eagle27272/gsd-pi`, as a constant in `config.ts`. Overridable via `GSD_BUG_REPORT_REPO` env (`owner/repo`). Never hard-code the repo at a call site.
- **Enable flag:** `GSD_BUG_REPORT` env. Disabled when the trimmed lowercase value is `off`, `0`, or `false`. Any other value, or unset, means enabled.
- **Soft cap:** `SOFT_CAP = 3` — a constant in `config.ts`, not user-configurable in v1.
- **`gh` calls never throw to the caller.** Every wrapper function returns `GhResult<T> = { ok: boolean; data?: T; error?: string }`. Mirror `src/resources/extensions/github-sync/cli.ts`.
- **Labels:** always `bug`; add `documentation` when `category === "docs"`. These labels already exist in `eagle27272/gsd-pi`.
- **Commit message trailer:** every commit body ends with a blank line then:
  `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
- **Branch:** `personal/gsd-bug-report` (already created; the spec commit `b19851c3` is on it).
- **Run a single test file during development:**
  `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd-bug-report/tests/<file>.test.ts`
- **Full unit run:** `pnpm run test:unit` (compiles to `dist-test/` then runs). Requires the package.json glob added in Task 1 or the new tests are compiled but never executed.
- **Do not** modify the `gsd` extension, `src/loader.ts`, or `src/resource-loader.ts`.

---

## File Structure

**New — `src/resources/extensions/gsd-bug-report/`**

| File | Responsibility |
|---|---|
| `extension-manifest.json` | Registry metadata: id, name, version, tier, `provides` |
| `config.ts` | `isEnabled()`, `targetRepo()`, `SOFT_CAP`, `DEFAULT_REPO` — env reads only, no I/O |
| `session-state.ts` | Per-process counter: `filedThisSession()`, `recordFiled()`, `resetSession()` |
| `report.ts` | Pure core: `BUG_REPORT_GUIDELINES`, `categoryToLabels()`, `matchExistingIssue()`, `enrichBody()`, `renderDraft()` — no I/O, no `ctx` |
| `github.ts` | Self-contained `gh` wrapper: `ghAvailable()`, `searchIssues()`, `createIssue()`, plus `_setExecForTest()` / `_resetGithubCacheForTest()` seams |
| `index.ts` | Default export `(pi) => void`: builds the shared handler, registers `report_gsd_bug` tool + `/report-gsd-bug` command + `session_start` reset |
| `tests/config.test.ts` | `isEnabled` truth table, `targetRepo` default + override |
| `tests/report.test.ts` | dedupe matcher, enrichment, draft render, label map, guideline text |
| `tests/github.test.ts` | `gh` wrapper against stubbed exec: availability, search parse, create parse, failure → `{ok:false}` |
| `tests/session-state.test.ts` | counter increments, reset |
| `tests/registration.test.ts` | loading `index.ts` against a fake `ExtensionAPI` registers exactly the expected tool/command/hook; end-to-end pipeline behavior with stubbed deps |

**Modified**

- `package.json` — add `"dist-test/src/resources/extensions/gsd-bug-report/tests/*.test.js"` to the `test:unit:compiled` script and to the `test:coverage:unit` script.
- `README.md` — one line documenting `GSD_BUG_REPORT` / `GSD_BUG_REPORT_REPO` and the self-report behavior.

**Not modified (verified auto-discovering):** `src/tests/extension-smoke.test.ts` (discovers entry paths, asserts `>= 10`), `src/tests/resource-loader.test.ts` (tmp-dir based), `scripts/compile-tests.mjs` (recursively collects all `src/**/*.ts`).

---

## Task 1: Extension scaffold, config, and test wiring

**Files:**
- Create: `src/resources/extensions/gsd-bug-report/extension-manifest.json`
- Create: `src/resources/extensions/gsd-bug-report/config.ts`
- Create: `src/resources/extensions/gsd-bug-report/index.ts`
- Create: `src/resources/extensions/gsd-bug-report/tests/config.test.ts`
- Modify: `package.json` (two `scripts` entries)
- Test: `src/resources/extensions/gsd-bug-report/tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `config.ts`: `DEFAULT_REPO = "eagle27272/gsd-pi"` (const), `SOFT_CAP = 3` (const), `isEnabled(env?: NodeJS.ProcessEnv): boolean`, `targetRepo(env?: NodeJS.ProcessEnv): string`.
  - `index.ts`: `export default function gsdBugReport(pi: ExtensionAPI): void` — in this task it only logs nothing and returns; real registration lands in Tasks 5–6.

- [ ] **Step 1: Write `extension-manifest.json`**

```json
{
  "id": "gsd-bug-report",
  "name": "gsd-pi Self-Report",
  "version": "1.0.0",
  "description": "Draft and file GitHub issues for defects in the gsd-pi CLI itself, with user confirmation.",
  "tier": "bundled",
  "requires": { "platform": ">=2.29.0" },
  "provides": {
    "tools": ["report_gsd_bug"],
    "commands": ["report-gsd-bug"],
    "hooks": ["session_start"]
  }
}
```

- [ ] **Step 2: Write the failing test** — `tests/config.test.ts`

```ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isEnabled, targetRepo, DEFAULT_REPO, SOFT_CAP } from "../config.ts";

describe("gsd-bug-report config", () => {
  test("isEnabled defaults to true when unset", () => {
    assert.equal(isEnabled({}), true);
  });

  test("isEnabled is false for off/0/false, case-insensitively", () => {
    for (const v of ["off", "OFF", "0", "false", "False", " off "]) {
      assert.equal(isEnabled({ GSD_BUG_REPORT: v }), false, `value: ${JSON.stringify(v)}`);
    }
  });

  test("isEnabled is true for other values", () => {
    for (const v of ["on", "1", "true", "yes"]) {
      assert.equal(isEnabled({ GSD_BUG_REPORT: v }), true, `value: ${JSON.stringify(v)}`);
    }
  });

  test("targetRepo defaults to DEFAULT_REPO", () => {
    assert.equal(targetRepo({}), DEFAULT_REPO);
    assert.equal(DEFAULT_REPO, "eagle27272/gsd-pi");
  });

  test("targetRepo honors GSD_BUG_REPORT_REPO when it looks like owner/repo", () => {
    assert.equal(targetRepo({ GSD_BUG_REPORT_REPO: "me/fork" }), "me/fork");
  });

  test("targetRepo ignores a malformed override", () => {
    assert.equal(targetRepo({ GSD_BUG_REPORT_REPO: "not-a-repo" }), DEFAULT_REPO);
  });

  test("SOFT_CAP is 3", () => {
    assert.equal(SOFT_CAP, 3);
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd-bug-report/tests/config.test.ts`
Expected: FAIL — `Cannot find module '../config.ts'`.

- [ ] **Step 4: Write `config.ts`**

```ts
/**
 * Configuration for the gsd-pi self-report extension. Env reads only — no I/O.
 */

export const DEFAULT_REPO = "eagle27272/gsd-pi";
export const SOFT_CAP = 3;

const DISABLED_VALUES = new Set(["off", "0", "false"]);

export function isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GSD_BUG_REPORT;
  if (raw === undefined) return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

export function targetRepo(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.GSD_BUG_REPORT_REPO?.trim();
  if (raw && /^[^/\s]+\/[^/\s]+$/.test(raw)) return raw;
  return DEFAULT_REPO;
}
```

- [ ] **Step 5: Write `index.ts` (placeholder registration)**

```ts
/**
 * gsd-pi Self-Report extension.
 *
 * Registers the `report_gsd_bug` tool, the `/report-gsd-bug` command, and a
 * session_start reset hook. Wiring is completed in later tasks.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";

export default function gsdBugReport(_pi: ExtensionAPI): void {
  // Registration added in Tasks 5–6.
}
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd-bug-report/tests/config.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 7: Add the new test dir to the two package.json globs**

In `package.json`, in the `test:unit:compiled` script value, immediately after the substring
`"dist-test/src/resources/extensions/github-sync/tests/*.test.js"` add a space then
`"dist-test/src/resources/extensions/gsd-bug-report/tests/*.test.js"`.
Make the identical insertion in the `test:coverage:unit` script value (same substring, same addition).

- [ ] **Step 8: Verify the extension smoke test still passes**

Run: `pnpm run test:compile && node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/tests/extension-smoke.test.js`
Expected: PASS — the new `gsd-bug-report/index.ts` imports without throwing; extension count still `>= 10`.

- [ ] **Step 9: Commit**

```bash
git add src/resources/extensions/gsd-bug-report/ package.json
git commit -m "$(cat <<'EOF'
feat(gsd-bug-report): scaffold extension, config, and test wiring

New bundled extension directory with manifest, env-driven config
(isEnabled / targetRepo / SOFT_CAP), a placeholder index.ts, and the
package.json test globs so its tests run under pnpm test:unit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Pure core — guidelines, labels, dedupe, enrichment, draft

**Files:**
- Create: `src/resources/extensions/gsd-bug-report/report.ts`
- Test: `src/resources/extensions/gsd-bug-report/tests/report.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (all pure, no I/O):
  - `BUG_REPORT_GUIDELINES: string[]` — bullets for `promptGuidelines`.
  - `type BugCategory = "runtime" | "docs" | "dx" | "test"`.
  - `categoryToLabels(category: BugCategory): string[]` — `["bug"]` or `["bug", "documentation"]`.
  - `interface IssueHit { number: number; title: string; url: string; state: string }`.
  - `matchExistingIssue(title: string, hits: IssueHit[]): IssueHit | null` — returns the first hit whose title is a strong match (case-insensitive substring either direction, or Jaccard overlap of alphanumeric word-tokens `>= 0.6`), else `null`.
  - `interface ReportEnv { version: string; commit: string | null; platform: string; arch: string; node: string; cwdProject: string }`.
  - `enrichBody(body: string, env: ReportEnv): string` — appends a fenced `--- environment ---` block and the footer `_Filed via gsd-pi self-report._`.
  - `renderDraft(input: { title: string; labels: string[]; body: string }): string` — a plain-text block for the confirm prompt (title line, labels line, blank line, body).

- [ ] **Step 1: Write the failing test** — `tests/report.test.ts`

```ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  BUG_REPORT_GUIDELINES,
  categoryToLabels,
  matchExistingIssue,
  enrichBody,
  renderDraft,
  type IssueHit,
  type ReportEnv,
} from "../report.ts";

const hit = (over: Partial<IssueHit>): IssueHit => ({
  number: 1, title: "t", url: "https://x/1", state: "open", ...over,
});

describe("categoryToLabels", () => {
  test("runtime/dx/test → [bug]", () => {
    for (const c of ["runtime", "dx", "test"] as const) {
      assert.deepEqual(categoryToLabels(c), ["bug"]);
    }
  });
  test("docs → [bug, documentation]", () => {
    assert.deepEqual(categoryToLabels("docs"), ["bug", "documentation"]);
  });
});

describe("matchExistingIssue", () => {
  test("returns null on empty list", () => {
    assert.equal(matchExistingIssue("gsd auto hangs on unit phase", []), null);
  });
  test("matches on case-insensitive substring", () => {
    const hits = [hit({ number: 12, title: "gsd auto hangs on unit phase sometimes" })];
    assert.equal(matchExistingIssue("gsd auto hangs on unit phase", hits)?.number, 12);
  });
  test("matches on high token overlap despite reordering", () => {
    const hits = [hit({ number: 7, title: "Unit phase hangs during gsd auto" })];
    assert.equal(matchExistingIssue("gsd auto hangs on unit phase", hits)?.number, 7);
  });
  test("does not match a weakly related title", () => {
    const hits = [hit({ number: 9, title: "Docs typo in README install section" })];
    assert.equal(matchExistingIssue("gsd auto hangs on unit phase", hits), null);
  });
});

describe("enrichBody", () => {
  const env: ReportEnv = {
    version: "1.18.0", commit: "abc1234", platform: "darwin", arch: "arm64",
    node: "v22.19.0", cwdProject: "some-app",
  };
  test("appends an environment block and footer", () => {
    const out = enrichBody("Original body.", env);
    assert.match(out, /Original body\./);
    assert.match(out, /--- environment ---/);
    assert.match(out, /gsd-pi: 1\.18\.0/);
    assert.match(out, /commit: abc1234/);
    assert.match(out, /darwin arm64/);
    assert.match(out, /node: v22\.19\.0/);
    assert.match(out, /_Filed via gsd-pi self-report\._\s*$/);
  });
  test("omits the commit line when commit is null", () => {
    const out = enrichBody("b", { ...env, commit: null });
    assert.doesNotMatch(out, /commit:/);
  });
});

describe("renderDraft", () => {
  test("shows title, labels, and body", () => {
    const out = renderDraft({ title: "T", labels: ["bug", "documentation"], body: "B" });
    assert.match(out, /T/);
    assert.match(out, /bug, documentation/);
    assert.match(out, /B/);
  });
});

describe("BUG_REPORT_GUIDELINES", () => {
  test("names the non-bug exclusions", () => {
    const text = BUG_REPORT_GUIDELINES.join("\n").toLowerCase();
    assert.ok(text.includes("test:unit"), "mentions the baseline test:unit failures");
    assert.ok(text.includes("flaky"), "mentions the rotating flaky tests");
    assert.ok(text.includes("current task"), "excludes code being written this task");
    assert.ok(text.includes("report_gsd_bug"), "tells the model which tool to call");
    assert.ok(text.includes("subagent"), "tells subagents to defer to the main session");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd-bug-report/tests/report.test.ts`
Expected: FAIL — `Cannot find module '../report.ts'`.

- [ ] **Step 3: Write `report.ts`**

```ts
/**
 * Pure core for the gsd-pi self-report extension: model guidance, label
 * mapping, duplicate matching, body enrichment, and draft rendering.
 * No I/O, no extension context.
 */

export const BUG_REPORT_GUIDELINES: string[] = [
  "You are running inside the gsd-pi CLI while working on the user's current project. If you observe a defect in the gsd-pi CLI ITSELF — one of its `gsd` commands, its workflow MCP, its on-screen output, or a bundled doc/help text — you may report it with the report_gsd_bug tool.",
  "Only report defects in gsd-pi itself. Never report bugs in the project you are working on, and never report bugs in code you are writing or modifying for the current task — fix those in place.",
  "These are NOT bugs, do not report them: the ~23 baseline `pnpm run test:unit` failures on main (native setMutationBoundaryFaultForTest tests that need a --test-fault-injection build the dev environment does not produce); the known rotating flaky tests (SIGKILL-convergence, MCP-replay, write-gate CONTEXT.md) which pass in isolation.",
  "Before reporting, make sure it is a genuine, reproducible defect and not environment misconfiguration. Draft a specific, imperative title and a body with what happened, repro steps, expected vs actual, and affected files or `path:line`.",
  "Call report_gsd_bug with { title, body, category, area? }. It searches for duplicates, adds environment details, shows the user the draft, and files the issue only after the user approves in this session. If the tool says the per-session limit is reached, summarize any further findings to the user at the end of your turn instead of calling it again.",
  "If you are a subagent, do not call report_gsd_bug — report the suspected gsd-pi defect in your result text and let the main session decide.",
];

export type BugCategory = "runtime" | "docs" | "dx" | "test";

export function categoryToLabels(category: BugCategory): string[] {
  return category === "docs" ? ["bug", "documentation"] : ["bug"];
}

export interface IssueHit {
  number: number;
  title: string;
  url: string;
  state: string;
}

const STOP_TOKENS = new Set(["the", "a", "an", "on", "in", "of", "to", "is", "and", "or", "for", "with", "when"]);

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP_TOKENS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function matchExistingIssue(title: string, hits: IssueHit[]): IssueHit | null {
  const t = title.trim().toLowerCase();
  const tt = tokens(title);
  for (const h of hits) {
    const ht = h.title.trim().toLowerCase();
    if (ht.includes(t) || t.includes(ht)) return h;
    if (jaccard(tt, tokens(h.title)) >= 0.6) return h;
  }
  return null;
}

export interface ReportEnv {
  version: string;
  commit: string | null;
  platform: string;
  arch: string;
  node: string;
  cwdProject: string;
}

export function enrichBody(body: string, env: ReportEnv): string {
  const lines = [
    body.trimEnd(),
    "",
    "```",
    "--- environment ---",
    `gsd-pi: ${env.version}`,
    ...(env.commit ? [`commit: ${env.commit}`] : []),
    `platform: ${env.platform} ${env.arch}`,
    `node: ${env.node}`,
    `cwd project: ${env.cwdProject}`,
    "```",
    "",
    "_Filed via gsd-pi self-report._",
  ];
  return lines.join("\n");
}

export function renderDraft(input: { title: string; labels: string[]; body: string }): string {
  return [
    `Title:  ${input.title}`,
    `Labels: ${input.labels.join(", ")}`,
    "",
    input.body,
  ].join("\n");
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd-bug-report/tests/report.test.ts`
Expected: PASS — all groups green.

- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/gsd-bug-report/report.ts src/resources/extensions/gsd-bug-report/tests/report.test.ts
git commit -m "$(cat <<'EOF'
feat(gsd-bug-report): pure core — guidelines, labels, dedupe, enrichment

matchExistingIssue (substring + Jaccard >= 0.6), enrichBody (environment
block + footer), renderDraft, categoryToLabels, and the promptGuidelines
text including the baseline/flaky non-bug exclusions.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Self-contained `gh` wrapper

**Files:**
- Create: `src/resources/extensions/gsd-bug-report/github.ts`
- Test: `src/resources/extensions/gsd-bug-report/tests/github.test.ts`

**Reference:** `src/resources/extensions/github-sync/cli.ts` — copy its `GhResult<T>`, `execFileSync` options (`encoding: "utf-8"`, `stdio`, `timeout`), and the `_set…ForTest` seam idiom. Do **not** import from that file (extension isolation).

**Interfaces:**
- Consumes: `IssueHit` from `./report.js`.
- Produces:
  - `interface GhResult<T> { ok: boolean; data?: T; error?: string }`.
  - `ghAvailable(): boolean` — cached; true iff `gh --version` and `gh auth status` both exit 0.
  - `searchIssues(repo: string, query: string): GhResult<IssueHit[]>` — runs `gh issue list --repo <repo> --state all --search <query> --limit 20 --json number,title,url,state`; parses JSON to `IssueHit[]`.
  - `createIssue(repo: string, input: { title: string; body: string; labels: string[] }): GhResult<string>` — runs `gh issue create --repo <repo> --title <t> --body <b> --label <csv>`; returns the issue URL parsed from stdout.
  - `_setExecForTest(fn: ExecFn | null): void` and `_resetGithubCacheForTest(): void` — test seams. `type ExecFn = (file: string, args: string[]) => string` (returns stdout; throws to simulate non-zero exit / ENOENT).

- [ ] **Step 1: Write the failing test** — `tests/github.test.ts`

```ts
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ghAvailable,
  searchIssues,
  createIssue,
  _setExecForTest,
  _resetGithubCacheForTest,
} from "../github.ts";

afterEach(() => {
  _setExecForTest(null);
  _resetGithubCacheForTest();
});

describe("ghAvailable", () => {
  test("true when version and auth both succeed", () => {
    _setExecForTest((_file, args) => (args.includes("--version") ? "gh version 2.100.0" : "Logged in"));
    assert.equal(ghAvailable(), true);
  });
  test("false when gh is missing (ENOENT)", () => {
    _setExecForTest(() => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); });
    assert.equal(ghAvailable(), false);
  });
  test("false when auth status fails", () => {
    _setExecForTest((_file, args) => {
      if (args.includes("--version")) return "gh version 2.100.0";
      throw new Error("not logged in");
    });
    assert.equal(ghAvailable(), false);
  });
});

describe("searchIssues", () => {
  test("parses the JSON array into IssueHit[]", () => {
    _setExecForTest(() => JSON.stringify([
      { number: 5, title: "A bug", url: "https://gh/5", state: "OPEN" },
    ]));
    const r = searchIssues("me/repo", "a bug");
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, [{ number: 5, title: "A bug", url: "https://gh/5", state: "OPEN" }]);
  });
  test("returns ok:false on a gh failure", () => {
    _setExecForTest(() => { throw new Error("gh: network error"); });
    const r = searchIssues("me/repo", "x");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /network error/);
  });
  test("returns ok:false on unparseable output", () => {
    _setExecForTest(() => "not json");
    assert.equal(searchIssues("me/repo", "x").ok, false);
  });
});

describe("createIssue", () => {
  test("returns the issue URL from stdout", () => {
    _setExecForTest((_file, args) => {
      assert.ok(args.includes("--repo") && args.includes("me/repo"));
      assert.ok(args.includes("--label") && args.includes("bug,documentation"));
      return "https://github.com/me/repo/issues/42\n";
    });
    const r = createIssue("me/repo", { title: "T", body: "B", labels: ["bug", "documentation"] });
    assert.deepEqual(r, { ok: true, data: "https://github.com/me/repo/issues/42" });
  });
  test("returns ok:false when gh exits non-zero", () => {
    _setExecForTest(() => { throw new Error("gh: 403"); });
    assert.equal(createIssue("me/repo", { title: "T", body: "B", labels: ["bug"] }).ok, false);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd-bug-report/tests/github.test.ts`
Expected: FAIL — `Cannot find module '../github.ts'`.

- [ ] **Step 3: Write `github.ts`**

```ts
/**
 * Self-contained `gh` CLI wrapper for the self-report extension.
 * Every function returns GhResult<T> and never throws. Patterns copied from
 * src/resources/extensions/github-sync/cli.ts (not imported — extension isolation).
 */

import { execFileSync } from "node:child_process";
import type { IssueHit } from "./report.js";

export interface GhResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

type ExecFn = (file: string, args: string[]) => string;

let execImpl: ExecFn = (file, args) =>
  execFileSync(file, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  }).trim();

let availableCache: boolean | null = null;

export function _setExecForTest(fn: ExecFn | null): void {
  execImpl = fn ?? ((file, args) =>
    execFileSync(file, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 }).trim());
}

export function _resetGithubCacheForTest(): void {
  availableCache = null;
}

export function ghAvailable(): boolean {
  if (availableCache !== null) return availableCache;
  try {
    execImpl("gh", ["--version"]);
    execImpl("gh", ["auth", "status"]);
    availableCache = true;
  } catch {
    availableCache = false;
  }
  return availableCache;
}

export function searchIssues(repo: string, query: string): GhResult<IssueHit[]> {
  try {
    const raw = execImpl("gh", [
      "issue", "list",
      "--repo", repo,
      "--state", "all",
      "--search", query,
      "--limit", "20",
      "--json", "number,title,url,state",
    ]);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false, error: `Unexpected output: ${raw.slice(0, 200)}` };
    return { ok: true, data: parsed as IssueHit[] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function createIssue(
  repo: string,
  input: { title: string; body: string; labels: string[] },
): GhResult<string> {
  try {
    const args = [
      "issue", "create",
      "--repo", repo,
      "--title", input.title,
      "--body", input.body,
    ];
    if (input.labels.length) args.push("--label", input.labels.join(","));
    const out = execImpl("gh", args);
    const match = out.match(/https?:\/\/\S+\/issues\/\d+/);
    if (!match) return { ok: false, error: `Could not parse issue URL from: ${out.slice(0, 200)}` };
    return { ok: true, data: match[0] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd-bug-report/tests/github.test.ts`
Expected: PASS — all groups green.

- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/gsd-bug-report/github.ts src/resources/extensions/gsd-bug-report/tests/github.test.ts
git commit -m "$(cat <<'EOF'
feat(gsd-bug-report): self-contained gh wrapper

ghAvailable (version + auth), searchIssues (gh issue list --json),
createIssue (parse issue URL from stdout). GhResult<T>, never throws,
exec seam for tests. Patterns copied from github-sync/cli.ts.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Per-session filed-count

**Files:**
- Create: `src/resources/extensions/gsd-bug-report/session-state.ts`
- Test: `src/resources/extensions/gsd-bug-report/tests/session-state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `filedThisSession(): number`, `recordFiled(): void`, `resetSession(): void` — module-level counter in this process.

- [ ] **Step 1: Write the failing test** — `tests/session-state.test.ts`

```ts
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { filedThisSession, recordFiled, resetSession } from "../session-state.ts";

beforeEach(() => resetSession());

describe("session-state", () => {
  test("starts at zero", () => {
    assert.equal(filedThisSession(), 0);
  });
  test("recordFiled increments", () => {
    recordFiled();
    recordFiled();
    assert.equal(filedThisSession(), 2);
  });
  test("resetSession clears the count", () => {
    recordFiled();
    resetSession();
    assert.equal(filedThisSession(), 0);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd-bug-report/tests/session-state.test.ts`
Expected: FAIL — `Cannot find module '../session-state.ts'`.

- [ ] **Step 3: Write `session-state.ts`**

```ts
/**
 * Per-process count of issues filed by the self-report extension this session.
 * Reset on session_start.
 */

let filed = 0;

export function filedThisSession(): number {
  return filed;
}

export function recordFiled(): void {
  filed += 1;
}

export function resetSession(): void {
  filed = 0;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd-bug-report/tests/session-state.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/gsd-bug-report/session-state.ts src/resources/extensions/gsd-bug-report/tests/session-state.test.ts
git commit -m "$(cat <<'EOF'
feat(gsd-bug-report): per-session filed-count

filedThisSession / recordFiled / resetSession — the soft-cap counter,
reset on session_start.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: The report pipeline + `report_gsd_bug` tool

**Files:**
- Modify: `src/resources/extensions/gsd-bug-report/index.ts` (full rewrite from the Task 1 placeholder)
- Test: `src/resources/extensions/gsd-bug-report/tests/registration.test.ts`

**Interfaces:**
- Consumes:
  - `config.ts`: `isEnabled`, `targetRepo`, `SOFT_CAP`.
  - `report.ts`: `BUG_REPORT_GUIDELINES`, `categoryToLabels`, `matchExistingIssue`, `enrichBody`, `renderDraft`, `BugCategory`, `ReportEnv`.
  - `github.ts`: `ghAvailable`, `searchIssues`, `createIssue`.
  - `session-state.ts`: `filedThisSession`, `recordFiled`, `resetSession`.
- Produces:
  - `interface ReportInput { title: string; body: string; category: BugCategory; area?: string }`.
  - `interface ReportDeps { env?: NodeJS.ProcessEnv; gh?: { ghAvailable: typeof ghAvailable; searchIssues: typeof searchIssues; createIssue: typeof createIssue }; confirm: (draft: string, repo: string) => Promise<boolean>; now?: () => ReportEnv }`.
  - `async function runReport(input: ReportInput, deps: ReportDeps): Promise<{ status: "disabled" | "capped" | "duplicate" | "declined" | "filed" | "manual"; message: string; url?: string }>`.
  - default `export function gsdBugReport(pi: ExtensionAPI): void`.

- [ ] **Step 1: Write the failing test** — `tests/registration.test.ts`

```ts
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import gsdBugReport, { runReport, type ReportDeps } from "../index.ts";
import { resetSession } from "../session-state.ts";

const baseEnvSnapshot = (): ReturnType<NonNullable<ReportDeps["now"]>> => ({
  version: "1.18.0", commit: "abc1234", platform: "darwin", arch: "arm64",
  node: "v22.19.0", cwdProject: "some-app",
});

function fakeGh(over: Partial<ReportDeps["gh"]> = {}): ReportDeps["gh"] {
  return {
    ghAvailable: () => true,
    searchIssues: () => ({ ok: true, data: [] }),
    createIssue: () => ({ ok: true, data: "https://github.com/eagle27272/gsd-pi/issues/99" }),
    ...over,
  };
}

const input = {
  title: "gsd auto hangs on unit phase",
  body: "Steps: run gsd auto. Expected: proceeds. Actual: hangs.",
  category: "runtime" as const,
};

beforeEach(() => resetSession());

describe("runReport", () => {
  test("disabled → status disabled, nothing filed", async () => {
    let created = 0;
    const r = await runReport(input, {
      env: { GSD_BUG_REPORT: "off" },
      gh: fakeGh({ createIssue: () => { created++; return { ok: true, data: "x" }; } }),
      confirm: async () => true,
      now: baseEnvSnapshot,
    });
    assert.equal(r.status, "disabled");
    assert.equal(created, 0);
  });

  test("duplicate → status duplicate, no confirm, no create", async () => {
    let confirmed = false;
    const r = await runReport(input, {
      env: {},
      gh: fakeGh({
        searchIssues: () => ({ ok: true, data: [
          { number: 7, title: "Unit phase hangs during gsd auto", url: "https://gh/7", state: "open" },
        ] }),
      }),
      confirm: async () => { confirmed = true; return true; },
      now: baseEnvSnapshot,
    });
    assert.equal(r.status, "duplicate");
    assert.match(r.message, /#7/);
    assert.equal(confirmed, false);
  });

  test("decline at confirm → status declined, no create, counter unchanged", async () => {
    let created = 0;
    const r = await runReport(input, {
      env: {},
      gh: fakeGh({ createIssue: () => { created++; return { ok: true, data: "x" }; } }),
      confirm: async () => false,
      now: baseEnvSnapshot,
    });
    assert.equal(r.status, "declined");
    assert.equal(created, 0);
  });

  test("approve → status filed, URL returned, counter increments", async () => {
    const r = await runReport(input, {
      env: {}, gh: fakeGh(), confirm: async () => true, now: baseEnvSnapshot,
    });
    assert.equal(r.status, "filed");
    assert.equal(r.url, "https://github.com/eagle27272/gsd-pi/issues/99");
  });

  test("soft cap → 4th call returns capped without touching gh", async () => {
    const deps: ReportDeps = { env: {}, gh: fakeGh(), confirm: async () => true, now: baseEnvSnapshot };
    for (let i = 0; i < 3; i++) await runReport({ ...input, title: `bug number ${i}` }, deps);
    let touched = false;
    const r = await runReport({ ...input, title: "bug number four" }, {
      ...deps,
      gh: fakeGh({ searchIssues: () => { touched = true; return { ok: true, data: [] }; } }),
    });
    assert.equal(r.status, "capped");
    assert.equal(touched, false);
  });

  test("gh unavailable → status manual, draft + prefilled URL in message, no create", async () => {
    const r = await runReport(input, {
      env: {},
      gh: fakeGh({ ghAvailable: () => false }),
      confirm: async () => true,
      now: baseEnvSnapshot,
    });
    assert.equal(r.status, "manual");
    assert.match(r.message, /issues\/new/);
    assert.match(r.message, /gsd auto hangs on unit phase/);
  });

  test("dedupe search failure is non-fatal → proceeds to confirm", async () => {
    const r = await runReport(input, {
      env: {},
      gh: fakeGh({ searchIssues: () => ({ ok: false, error: "network" }) }),
      confirm: async () => true,
      now: baseEnvSnapshot,
    });
    assert.equal(r.status, "filed");
  });
});

describe("gsdBugReport registration", () => {
  test("registers exactly the tool, command, and session_start hook", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const fakePi = {
      registerTool: (spec: { name: string; promptGuidelines?: string[] }) => {
        tools.push(spec.name);
        assert.ok((spec.promptGuidelines?.length ?? 0) > 0, "tool carries promptGuidelines");
      },
      registerCommand: (name: string) => { commands.push(name); },
      on: (event: string) => { events.push(event); },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gsdBugReport(fakePi as any);
    assert.deepEqual(tools, ["report_gsd_bug"]);
    assert.deepEqual(commands, ["report-gsd-bug"]);
    assert.ok(events.includes("session_start"));
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd-bug-report/tests/registration.test.ts`
Expected: FAIL — `runReport` / default export shape not present.

- [ ] **Step 3: Rewrite `index.ts`**

```ts
/**
 * gsd-pi Self-Report extension.
 *
 * report_gsd_bug tool + /report-gsd-bug command: draft a GitHub issue for a
 * defect in the gsd-pi CLI itself and file it to the fork repo after the user
 * confirms in-session. All guarantees (enable flag, soft cap, dedupe,
 * environment capture, gh-missing fallback) are enforced in runReport().
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { isEnabled, targetRepo, SOFT_CAP } from "./config.js";
import {
  BUG_REPORT_GUIDELINES,
  categoryToLabels,
  matchExistingIssue,
  enrichBody,
  renderDraft,
  type BugCategory,
  type ReportEnv,
} from "./report.js";
import {
  ghAvailable as realGhAvailable,
  searchIssues as realSearchIssues,
  createIssue as realCreateIssue,
} from "./github.js";
import { filedThisSession, recordFiled, resetSession } from "./session-state.js";

export interface ReportInput {
  title: string;
  body: string;
  category: BugCategory;
  area?: string;
}

export interface ReportDeps {
  env?: NodeJS.ProcessEnv;
  gh?: {
    ghAvailable: typeof realGhAvailable;
    searchIssues: typeof realSearchIssues;
    createIssue: typeof realCreateIssue;
  };
  confirm: (draft: string, repo: string) => Promise<boolean>;
  now?: () => ReportEnv;
}

export interface ReportResult {
  status: "disabled" | "capped" | "duplicate" | "declined" | "filed" | "manual";
  message: string;
  url?: string;
}

function defaultEnvSnapshot(env: NodeJS.ProcessEnv): ReportEnv {
  let commit: string | null = null;
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: env.GSD_BIN_PATH ? basename(env.GSD_BIN_PATH) : process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    }).trim() || null;
  } catch {
    commit = null;
  }
  return {
    version: env.GSD_VERSION || "0.0.0",
    commit,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cwdProject: basename(process.cwd()),
  };
}

function prefilledIssueUrl(repo: string, title: string, body: string, labels: string[]): string {
  const q = new URLSearchParams({ title, body, labels: labels.join(",") });
  return `https://github.com/${repo}/issues/new?${q.toString()}`;
}

export async function runReport(input: ReportInput, deps: ReportDeps): Promise<ReportResult> {
  const env = deps.env ?? process.env;
  const gh = deps.gh ?? {
    ghAvailable: realGhAvailable,
    searchIssues: realSearchIssues,
    createIssue: realCreateIssue,
  };
  const snapshot = (deps.now ?? (() => defaultEnvSnapshot(env)))();
  const repo = targetRepo(env);
  const labels = categoryToLabels(input.category);

  if (!isEnabled(env)) {
    return { status: "disabled", message: "gsd-pi self-report is disabled (GSD_BUG_REPORT=off)." };
  }

  if (filedThisSession() >= SOFT_CAP) {
    return {
      status: "capped",
      message: `Already filed ${SOFT_CAP} issue(s) this session. Summarize any further gsd-pi findings to the user at the end of your turn instead of filing more.`,
    };
  }

  const body = enrichBody(input.body, snapshot);

  if (gh.ghAvailable()) {
    const search = gh.searchIssues(repo, input.title);
    if (search.ok && search.data) {
      const dup = matchExistingIssue(input.title, search.data);
      if (dup) {
        return {
          status: "duplicate",
          message: `Likely duplicate of #${dup.number} (${dup.state}): ${dup.url} — not filed.`,
        };
      }
    }
    const draft = renderDraft({ title: input.title, labels, body });
    const approved = await deps.confirm(draft, repo);
    if (!approved) return { status: "declined", message: "Not filed — declined by user." };

    const created = gh.createIssue(repo, { title: input.title, body, labels });
    if (!created.ok) {
      return {
        status: "manual",
        message:
          `gh issue create failed: ${created.error}\n\n` +
          `File it manually:\n${prefilledIssueUrl(repo, input.title, body, labels)}`,
      };
    }
    recordFiled();
    return { status: "filed", message: `Filed: ${created.data}`, url: created.data };
  }

  const draft = renderDraft({ title: input.title, labels, body });
  return {
    status: "manual",
    message:
      `\`gh\` is not available. Draft below — file it manually:\n\n${draft}\n\n` +
      `${prefilledIssueUrl(repo, input.title, body, labels)}`,
  };
}

const ReportParams = Type.Object({
  title: Type.String({ description: "Specific, imperative issue title." }),
  body: Type.String({
    description: "Markdown: what happened, repro steps, expected vs actual, affected files or path:line.",
  }),
  category: Type.Union(
    [Type.Literal("runtime"), Type.Literal("docs"), Type.Literal("dx"), Type.Literal("test")],
    { description: "runtime = wrong CLI/MCP behavior; docs = wrong doc/help text; dx = broken repo script/harness; test = genuine bug a test caught." },
  ),
  area: Type.Optional(Type.String({ description: "Short area tag, e.g. 'gsd auto', 'workflow-mcp'." })),
});

export default function gsdBugReport(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    resetSession();
  });

  const confirmViaUi = (ctx: { hasUI?: boolean; ui?: { select?: (t: string, o: string[], opts?: unknown) => Promise<string | undefined> } }) =>
    async (draft: string, repo: string): Promise<boolean> => {
      if (!ctx.hasUI || !ctx.ui?.select) return false;
      const FILE = "File it";
      const choice = await ctx.ui.select(
        `File this issue to ${repo}?\n\n${draft}`,
        [FILE, "Don't file"],
      );
      return choice === FILE;
    };

  pi.registerTool({
    name: "report_gsd_bug",
    label: "Report gsd-pi Bug",
    description:
      "Draft a GitHub issue for a defect in the gsd-pi CLI itself and file it to the fork repo after the user confirms. Searches for duplicates and adds environment details automatically.",
    promptSnippet: "Report a defect in the gsd-pi CLI itself (draft-then-confirm).",
    promptGuidelines: BUG_REPORT_GUIDELINES,
    parameters: ReportParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runReport(params as ReportInput, {
        confirm: confirmViaUi(ctx as never),
      });
      return { content: [{ type: "text", text: result.message }], details: result };
    },
  });

  pi.registerCommand("report-gsd-bug", {
    description: "Draft and file a gsd-pi bug report (interactive).",
    async handler(args: string, ctx) {
      const anyCtx = ctx as unknown as {
        hasUI?: boolean;
        ui?: {
          select?: (t: string, o: string[], opts?: unknown) => Promise<string | undefined>;
          input?: (t: string, ph?: string) => Promise<string | undefined>;
          notify?: (msg: string, level?: string) => void;
        };
      };
      const title = args.trim() || (await anyCtx.ui?.input?.("Bug title", "Short imperative title")) || "";
      if (!title) {
        anyCtx.ui?.notify?.("Cancelled — no title.", "warning");
        return;
      }
      const body = (await anyCtx.ui?.input?.("Details", "What happened, repro, expected vs actual")) || "(no details provided)";
      const result = await runReport(
        { title, body, category: "runtime" },
        { confirm: confirmViaUi(anyCtx as never) },
      );
      anyCtx.ui?.notify?.(result.message, result.status === "filed" ? "info" : "warning");
    },
  });
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd-bug-report/tests/registration.test.ts`
Expected: PASS — all `runReport` cases and the registration assertion green.

- [ ] **Step 5: Typecheck the extensions project**

Run: `pnpm run typecheck:extensions`
Expected: no errors in `src/resources/extensions/gsd-bug-report/`. Fix any type errors (e.g. `ExtensionAPI` method signatures) before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/resources/extensions/gsd-bug-report/index.ts src/resources/extensions/gsd-bug-report/tests/registration.test.ts
git commit -m "$(cat <<'EOF'
feat(gsd-bug-report): report pipeline + report_gsd_bug tool

runReport enforces enable flag, soft cap, dedupe, environment capture,
confirm gate, and gh-missing fallback. index.ts registers the tool with
promptGuidelines, the /report-gsd-bug command, and a session_start reset.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Docs + full-suite verification

**Files:**
- Modify: `README.md`
- Test: full unit suite

- [ ] **Step 1: Add a README line**

In `README.md`, under the section that lists environment variables / features (search for an existing `GSD_` env var mention or a "Configuration" heading; if none, add a short `### Self-report` subsection near the other feature descriptions):

```markdown
- **Self-report (`GSD_BUG_REPORT`)** — when the agent finds a defect in the gsd-pi CLI itself, it drafts a GitHub issue and, after you approve it in-session, files it to `eagle27272/gsd-pi` (override with `GSD_BUG_REPORT_REPO`). Set `GSD_BUG_REPORT=off` to disable. Run `/report-gsd-bug` to file one by hand.
```

- [ ] **Step 2: Run the new extension's tests as a group**

Run: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd-bug-report/tests/*.test.ts`
Expected: PASS — config, report, github, session-state, registration all green.

- [ ] **Step 3: Run the compiled unit suite and confirm the new tests execute**

Run: `pnpm run test:unit 2>&1 | tee /tmp/gsd-bug-report-testrun.txt`
Expected: the run includes `dist-test/src/resources/extensions/gsd-bug-report/tests/*.test.js` (grep the output for `gsd-bug-report`). Pre-existing baseline failures (~23 native fault-injection tests) and 0–2 rotating flaky tests may still fail — confirm no **new** failures come from `gsd-bug-report`.

- [ ] **Step 4: Run the extension smoke test**

Run: `node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/tests/extension-smoke.test.js`
Expected: PASS — `gsd-bug-report/index.ts` imports cleanly; count still `>= 10`.

- [ ] **Step 5: Manual sanity checks**

1. `GSD_BUG_REPORT=off gsd` … trigger `report_gsd_bug` (or `/report-gsd-bug`) → tool returns "disabled", nothing filed.
2. With `gh` authenticated, `/report-gsd-bug "test — please ignore"` → draft shown → choose **Don't file** → "declined by user", no issue created. Verify on GitHub that no issue was opened.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(gsd-bug-report): document GSD_BUG_REPORT and /report-gsd-bug

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage**

| Spec item | Task |
|---|---|
| New bundled extension `gsd-bug-report/`, auto-loaded every session | Task 1 (scaffold), verified Task 1 Step 8 / Task 6 Step 4 |
| `extension-manifest.json` with `provides` | Task 1 Step 1 |
| System-prompt guidance via `promptGuidelines` (categories, non-bugs, boundary, tool name) | Task 2 (`BUG_REPORT_GUIDELINES` + test), attached Task 5 Step 3 |
| Tool `report_gsd_bug(title, body, category, area?)` | Task 5 (`ReportParams`, `execute`) |
| Enable gate `GSD_BUG_REPORT` default-on, opt-out | Task 1 (`isEnabled`), enforced Task 5 (`runReport`) |
| Soft cap 3 / session, overflow → model summarizes | Task 4 (counter), Task 5 (`capped` branch + test) |
| Dedupe via `gh issue list --search`, strong-match → skip | Task 3 (`searchIssues`), Task 2 (`matchExistingIssue`), Task 5 (`duplicate` branch) |
| Body enrichment: version, commit, platform, node, cwd project + footer | Task 2 (`enrichBody`), snapshot in Task 5 (`defaultEnvSnapshot`) |
| Draft render + confirm prompt, file only on yes | Task 2 (`renderDraft`), Task 5 (`confirmViaUi`, `declined` branch + test) |
| `gh issue create` with `bug` (+ `documentation` for docs) | Task 3 (`createIssue`), Task 2 (`categoryToLabels`) |
| `gh` missing / non-zero → return draft + paste-ready + prefilled `issues/new` URL, never throw | Task 3 (`GhResult`), Task 5 (`manual` branches + tests) |
| Dedupe search failure non-fatal | Task 5 (test "dedupe search failure is non-fatal") |
| `create` fails after confirm → error + manual, counter not incremented | Task 5 (`manual` branch after `createIssue` not ok; `recordFiled` only on success) |
| `session_start` resets counter + re-reads flag | Task 4 (`resetSession`), Task 5 (`pi.on("session_start")`); flag is re-read every `runReport` call via `isEnabled(env)` |
| Command `/report-gsd-bug`, same pipeline | Task 5 (`registerCommand`) |
| `GSD_BUG_REPORT_REPO` override, default not hard-coded at call sites | Task 1 (`targetRepo`, `DEFAULT_REPO`) |
| Tests: report / config / github / registration (+ session-state) | Tasks 1–5 |
| README line | Task 6 Step 1 |
| package.json test globs (deviation from spec "not changed") | Task 1 Step 7 — flagged |
| `github.ts` self-contained instead of importing github-sync (deviation) | Task 3 — flagged, patterns copied |

Subagent-context deferral (spec "subagent deferral") — covered: `BUG_REPORT_GUIDELINES` has the subagent bullet (Task 2 Step 3) and `report.test.ts` asserts `text.includes("subagent")` (Task 2 Step 1).

**2. Placeholder scan** — no "TBD"/"handle appropriately"/"similar to Task N". Every code step has full code. The README step gives exact text and a fallback location rule. OK.

**3. Type consistency** — `GhResult<T>` shape identical in Task 3 and consumed in Task 5. `IssueHit` defined in Task 2, imported by Task 3 and used in Task 5 tests. `ReportEnv` defined Task 2, produced by `defaultEnvSnapshot` / `deps.now` in Task 5, matches the `baseEnvSnapshot` fixture. `BugCategory` union matches `ReportParams` literals (`runtime|docs|dx|test`). `categoryToLabels` name stable across Tasks 2 and 5. `runReport` / `ReportDeps` / `ReportResult` names stable in Task 5 code and its test. `resetSession` used in Tasks 4, 5, and both test files. Consistent.

---

## Execution Handoff

Self-review fixes are already folded into the task text above — implement the tasks as written.
