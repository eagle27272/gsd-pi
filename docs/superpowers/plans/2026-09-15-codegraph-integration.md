# CodeGraph Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only bundled `codegraph` extension that gives the agent two symbol-graph tools in projects that already have a `.codegraph/` index, and registers nothing at all everywhere else.

**Architecture:** A new extension directory at `src/resources/extensions/codegraph/` with four small modules — `detect.ts` (the gate), `cli.ts` (argv construction and process execution), `tools.ts` (the two tool definitions), `index.ts` (three lines of wiring). Every module takes its filesystem and process access as injectable parameters with real defaults, so tests never touch the disk or spawn the binary. The extension's default export returns before registering anything unless the gate passes.

**Tech Stack:** TypeScript, TypeBox schemas via `Type` from `@gsd/pi-ai`, `node:test` + `node:assert/strict` for tests, `node:child_process.execFile` for the binary.

**Spec:** `docs/superpowers/specs/2026-09-15-codegraph-integration-design.md`

## Global Constraints

- Extension id is `codegraph`, tier `bundled`, `requires.platform` is `">=2.29.0"` — matching every other bundled manifest in this repo.
- The extension never writes to the repository and never runs `codegraph init`, `index`, or `sync`. Read-only, always.
- Exactly two tools ship: `codegraph_explore` and `codegraph_node`. No `impact`, no `affected`, no grep interception.
- No git-worktree fallback. If the session's cwd has no `.codegraph/` at or above it, the gate fails and nothing registers.
- Source modules import siblings with a `.js` extension (`./detect.js`); test files import with a `.ts` extension (`../detect.ts`). This mirrors `src/resources/extensions/herdr/` and is required by the `.ts`→`.js` rewrite in `scripts/compile-tests.mjs`.
- Environment variables: `GSD_CODEGRAPH_DISABLED` (opt out) and `GSD_CODEGRAPH_PATH` (binary override), mirroring the `GSD_RTK_*` naming in `src/rtk-shared.ts`.

## Two facts verified against the real binary — do not re-derive them

**1. `~/.codegraph/` exists and is not a project index.** CodeGraph keeps its global state (daemon records, telemetry) in `~/.codegraph/`. An upward walk that tests `$HOME` itself will match that directory and wrongly treat every project under your home as indexed. The walk must stop *before* testing `$HOME`.

**2. "Not found" is not an error.** `codegraph node -- someMissingSymbol` exits **0** and prints `Symbol "someMissingSymbol" not found in the codebase` on stdout. Only real failures exit nonzero — e.g. pointing `-p` at an unindexed directory exits **1** with the explanation on stderr. So error mapping keys off the exit code alone; never pattern-match the output text.

---

### Task 1: The gate — `detect.ts`

**Files:**
- Create: `src/resources/extensions/codegraph/detect.ts`
- Test: `src/resources/extensions/codegraph/tests/detect.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface CodegraphEnv { binPath: string; projectRoot: string }`
  - `function findIndexRoot(startDir: string, opts?: { home?: string; isDirectory?: (p: string) => boolean }): string | null`
  - `function hasIndex(projectRoot: string, isDirectory?: (p: string) => boolean): boolean`
  - `function resolveBinary(opts?: { env?: NodeJS.ProcessEnv; isExecutable?: (p: string) => boolean }): string | null`
  - `function detectCodegraph(opts?: DetectOptions): CodegraphEnv | null`
  - `const CODEGRAPH_DISABLED_ENV = "GSD_CODEGRAPH_DISABLED"`
  - `const CODEGRAPH_PATH_ENV = "GSD_CODEGRAPH_PATH"`

Keep `defaultIsDirectory` and `defaultIsExecutable` module-private — they are only ever reached as parameter defaults, and an unimported export would be flagged by the `lint:dead-code` knip gate.

- [ ] **Step 1: Write the failing test**

Create `src/resources/extensions/codegraph/tests/detect.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  CODEGRAPH_DISABLED_ENV,
  CODEGRAPH_PATH_ENV,
  detectCodegraph,
  findIndexRoot,
  hasIndex,
  resolveBinary,
} from "../detect.ts";

const HOME = "/Users/dev";

/** Treats every path in `dirs` as an existing directory, everything else as absent. */
function fakeDirs(dirs: string[]): (path: string) => boolean {
  const set = new Set(dirs);
  return (path) => set.has(path);
}

/** Treats every path in `bins` as an executable file. */
function fakeBins(bins: string[]): (path: string) => boolean {
  const set = new Set(bins);
  return (path) => set.has(path);
}

test("findIndexRoot returns the directory holding .codegraph", () => {
  const isDirectory = fakeDirs(["/Users/dev/proj/.codegraph"]);
  assert.equal(findIndexRoot("/Users/dev/proj", { home: HOME, isDirectory }), "/Users/dev/proj");
});

test("findIndexRoot walks up to a parent that holds the index", () => {
  const isDirectory = fakeDirs(["/Users/dev/proj/.codegraph"]);
  assert.equal(
    findIndexRoot("/Users/dev/proj/src/deep/nested", { home: HOME, isDirectory }),
    "/Users/dev/proj",
  );
});

test("findIndexRoot never matches ~/.codegraph, which is CodeGraph's global state dir", () => {
  // CodeGraph stores daemon records and telemetry in ~/.codegraph. Testing $HOME
  // itself would report every project under the home directory as indexed.
  const isDirectory = fakeDirs(["/Users/dev/.codegraph"]);
  assert.equal(findIndexRoot("/Users/dev/proj/src", { home: HOME, isDirectory }), null);
});

test("findIndexRoot returns null at the filesystem root when nothing is indexed", () => {
  assert.equal(findIndexRoot("/srv/app", { home: HOME, isDirectory: fakeDirs([]) }), null);
});

test("findIndexRoot does not consult the git common dir for an unindexed worktree", () => {
  // The main checkout is indexed; the worktree is not. A worktree session gets null.
  const isDirectory = fakeDirs(["/Users/dev/git/app/.codegraph"]);
  assert.equal(
    findIndexRoot("/Users/dev/.claude/worktrees/app/feature", { home: HOME, isDirectory }),
    null,
  );
});

test("hasIndex checks for .codegraph directly under the given root", () => {
  const isDirectory = fakeDirs(["/Users/dev/proj/.codegraph"]);
  assert.equal(hasIndex("/Users/dev/proj", isDirectory), true);
  assert.equal(hasIndex("/Users/dev/other", isDirectory), false);
});

test("resolveBinary finds codegraph on PATH", () => {
  const env = { PATH: "/usr/bin:/opt/homebrew/bin" } as NodeJS.ProcessEnv;
  const isExecutable = fakeBins(["/opt/homebrew/bin/codegraph"]);
  assert.equal(resolveBinary({ env, isExecutable }), "/opt/homebrew/bin/codegraph");
});

test("resolveBinary returns null when codegraph is not on PATH", () => {
  const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
  assert.equal(resolveBinary({ env, isExecutable: fakeBins([]) }), null);
});

test("resolveBinary honours the path override and rejects it when not executable", () => {
  const env = { PATH: "/usr/bin", [CODEGRAPH_PATH_ENV]: "/custom/cg" } as NodeJS.ProcessEnv;
  assert.equal(resolveBinary({ env, isExecutable: fakeBins(["/custom/cg"]) }), "/custom/cg");
  assert.equal(resolveBinary({ env, isExecutable: fakeBins(["/usr/bin/codegraph"]) }), null);
});

test("detectCodegraph returns the env when the index and binary are both present", () => {
  const result = detectCodegraph({
    cwd: "/Users/dev/proj/src",
    home: HOME,
    env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    isDirectory: fakeDirs(["/Users/dev/proj/.codegraph"]),
    isExecutable: fakeBins(["/usr/bin/codegraph"]),
  });
  assert.deepEqual(result, { binPath: "/usr/bin/codegraph", projectRoot: "/Users/dev/proj" });
});

test("detectCodegraph returns null when the binary is missing", () => {
  assert.equal(
    detectCodegraph({
      cwd: "/Users/dev/proj",
      home: HOME,
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      isDirectory: fakeDirs(["/Users/dev/proj/.codegraph"]),
      isExecutable: fakeBins([]),
    }),
    null,
  );
});

test("detectCodegraph returns null when the project has no index", () => {
  assert.equal(
    detectCodegraph({
      cwd: "/Users/dev/proj",
      home: HOME,
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      isDirectory: fakeDirs([]),
      isExecutable: fakeBins(["/usr/bin/codegraph"]),
    }),
    null,
  );
});

test("detectCodegraph returns null when disabled by env, even if everything else is present", () => {
  for (const value of ["1", "true", "yes"]) {
    assert.equal(
      detectCodegraph({
        cwd: "/Users/dev/proj",
        home: HOME,
        env: { PATH: "/usr/bin", [CODEGRAPH_DISABLED_ENV]: value } as NodeJS.ProcessEnv,
        isDirectory: fakeDirs(["/Users/dev/proj/.codegraph"]),
        isExecutable: fakeBins(["/usr/bin/codegraph"]),
      }),
      null,
      `expected ${value} to disable`,
    );
  }
});

test("detectCodegraph treats empty, '0' and 'false' as not disabled", () => {
  for (const value of ["", "0", "false"]) {
    assert.ok(
      detectCodegraph({
        cwd: "/Users/dev/proj",
        home: HOME,
        env: { PATH: "/usr/bin", [CODEGRAPH_DISABLED_ENV]: value } as NodeJS.ProcessEnv,
        isDirectory: fakeDirs(["/Users/dev/proj/.codegraph"]),
        isExecutable: fakeBins(["/usr/bin/codegraph"]),
      }),
      `expected ${JSON.stringify(value)} not to disable`,
    );
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/codegraph/tests/detect.test.ts
```

Expected: fails to resolve `../detect.ts` — the module does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/resources/extensions/codegraph/detect.ts`:

```ts
// gsd-pi — CodeGraph detection.
//
// Everything this extension registers is gated on detectCodegraph() returning
// non-null: a codegraph binary, and a .codegraph/ index at or above the session
// cwd. A git worktree is deliberately NOT resolved to its main checkout — that
// index describes a different tree (see the design doc).

import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export const CODEGRAPH_DISABLED_ENV = "GSD_CODEGRAPH_DISABLED";
export const CODEGRAPH_PATH_ENV = "GSD_CODEGRAPH_PATH";

const BIN_NAME = "codegraph";
const INDEX_DIR = ".codegraph";

export interface CodegraphEnv {
  /** Path to the codegraph binary to invoke. */
  binPath: string;
  /** Directory containing the .codegraph/ index — passed to the CLI as `-p`. */
  projectRoot: string;
}

export interface DetectOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDisabled(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return Boolean(v) && v !== "0" && v !== "false";
}

/** True when `projectRoot` directly contains a .codegraph/ index. */
export function hasIndex(
  projectRoot: string,
  isDirectory: (path: string) => boolean = defaultIsDirectory,
): boolean {
  return isDirectory(join(projectRoot, INDEX_DIR));
}

/**
 * Nearest ancestor of `startDir` (inclusive) holding a .codegraph/ index.
 *
 * The walk stops before testing $HOME: ~/.codegraph is CodeGraph's own global
 * state directory (daemon records, telemetry), so testing it would report every
 * project under the home directory as indexed.
 */
export function findIndexRoot(
  startDir: string,
  opts: { home?: string; isDirectory?: (path: string) => boolean } = {},
): string | null {
  const isDirectory = opts.isDirectory ?? defaultIsDirectory;
  const home = resolve(opts.home ?? homedir());
  let dir = resolve(startDir);
  for (;;) {
    if (dir === home) return null;
    if (isDirectory(join(dir, INDEX_DIR))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The codegraph binary: the env override if usable, else the first hit on PATH. */
export function resolveBinary(
  opts: { env?: NodeJS.ProcessEnv; isExecutable?: (path: string) => boolean } = {},
): string | null {
  const env = opts.env ?? process.env;
  const isExecutable = opts.isExecutable ?? defaultIsExecutable;
  const override = env[CODEGRAPH_PATH_ENV]?.trim();
  if (override) return isExecutable(override) ? override : null;
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, BIN_NAME);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** The whole gate. Null means this extension registers nothing at all. */
export function detectCodegraph(opts: DetectOptions = {}): CodegraphEnv | null {
  const env = opts.env ?? process.env;
  if (isDisabled(env[CODEGRAPH_DISABLED_ENV])) return null;
  const projectRoot = findIndexRoot(opts.cwd ?? process.cwd(), {
    home: opts.home,
    isDirectory: opts.isDirectory,
  });
  if (!projectRoot) return null;
  const binPath = resolveBinary({ env, isExecutable: opts.isExecutable });
  if (!binPath) return null;
  return { binPath, projectRoot };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/codegraph/tests/detect.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/codegraph/detect.ts src/resources/extensions/codegraph/tests/detect.test.ts
git commit -m "feat(codegraph): detection gate for binary and project index"
```

---

### Task 2: Argv and process execution — `cli.ts`

**Files:**
- Create: `src/resources/extensions/codegraph/cli.ts`
- Test: `src/resources/extensions/codegraph/tests/cli.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (this module is pure plus one process wrapper).
- Produces:
  - `interface ExploreParams { query: string; maxFiles?: number }`
  - `interface NodeParams { name?: string; file?: string; offset?: number; limit?: number; symbolsOnly?: boolean }`
  - `interface CodegraphRun { stdout: string; stderr: string; code: number | null; timedOut: boolean; aborted: boolean }`
  - `type CodegraphRunner = (bin: string, args: string[], signal: AbortSignal | undefined) => Promise<CodegraphRun>`
  - `function buildExploreArgs(projectRoot: string, params: ExploreParams): string[]`
  - `function buildNodeArgs(projectRoot: string, params: NodeParams): string[]`
  - `function createExecFileRunner(timeoutMs?: number): CodegraphRunner`
  - `const CODEGRAPH_TIMEOUT_MS = 60_000`

- [ ] **Step 1: Write the failing test**

Create `src/resources/extensions/codegraph/tests/cli.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildExploreArgs, buildNodeArgs, createExecFileRunner } from "../cli.ts";

const ROOT = "/Users/dev/proj";

test("buildExploreArgs passes --no-color, the project root, and the query after --", () => {
  assert.deepEqual(buildExploreArgs(ROOT, { query: "how are extensions registered" }), [
    "--no-color",
    "explore",
    "-p",
    ROOT,
    "--",
    "how are extensions registered",
  ]);
});

test("buildExploreArgs includes --max-files only when given", () => {
  assert.deepEqual(buildExploreArgs(ROOT, { query: "detectHerdrEnv", maxFiles: 3 }), [
    "--no-color",
    "explore",
    "-p",
    ROOT,
    "--max-files",
    "3",
    "--",
    "detectHerdrEnv",
  ]);
});

test("buildExploreArgs keeps a leading-dash query as a positional, not a flag", () => {
  // The `--` separator is what makes this safe; without it commander would try
  // to parse the query as an option.
  const args = buildExploreArgs(ROOT, { query: "--symbols-only" });
  assert.deepEqual(args.slice(-2), ["--", "--symbols-only"]);
});

test("buildNodeArgs in symbol mode passes just the name", () => {
  assert.deepEqual(buildNodeArgs(ROOT, { name: "detectHerdrEnv" }), [
    "--no-color",
    "node",
    "-p",
    ROOT,
    "--",
    "detectHerdrEnv",
  ]);
});

test("buildNodeArgs in file mode passes -f and the range flags", () => {
  assert.deepEqual(
    buildNodeArgs(ROOT, { file: "src/cli.ts", offset: 40, limit: 120 }),
    ["--no-color", "node", "-p", ROOT, "-f", "src/cli.ts", "--offset", "40", "--limit", "120"],
  );
});

test("buildNodeArgs includes --symbols-only only when true", () => {
  assert.ok(buildNodeArgs(ROOT, { file: "src/cli.ts", symbolsOnly: true }).includes("--symbols-only"));
  assert.ok(!buildNodeArgs(ROOT, { file: "src/cli.ts", symbolsOnly: false }).includes("--symbols-only"));
});

test("buildNodeArgs supports a name disambiguated to a file", () => {
  assert.deepEqual(buildNodeArgs(ROOT, { name: "run", file: "src/cli.ts" }), [
    "--no-color",
    "node",
    "-p",
    ROOT,
    "-f",
    "src/cli.ts",
    "--",
    "run",
  ]);
});

test("createExecFileRunner reports a successful run", async () => {
  const run = createExecFileRunner();
  const result = await run(process.execPath, ["-e", "process.stdout.write('hi')"], undefined);
  assert.equal(result.stdout, "hi");
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
});

test("createExecFileRunner reports a nonzero exit with stderr, without throwing", async () => {
  const run = createExecFileRunner();
  const result = await run(
    process.execPath,
    ["-e", "process.stderr.write('boom'); process.exit(3)"],
    undefined,
  );
  assert.equal(result.code, 3);
  assert.match(result.stderr, /boom/);
});

test("createExecFileRunner reports a spawn failure with a null code", async () => {
  const run = createExecFileRunner();
  const result = await run("/nonexistent/codegraph", ["--version"], undefined);
  assert.equal(result.code, null);
  assert.equal(result.timedOut, false);
});

test("createExecFileRunner reports a timeout", async () => {
  const run = createExecFileRunner(50);
  const result = await run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], undefined);
  assert.equal(result.timedOut, true);
});

test("createExecFileRunner reports an abort", async () => {
  const controller = new AbortController();
  const run = createExecFileRunner();
  const pending = run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/codegraph/tests/cli.test.ts
```

Expected: fails to resolve `../cli.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/resources/extensions/codegraph/cli.ts`:

```ts
// gsd-pi — CodeGraph CLI invocation.
//
// Argv construction is pure and separately tested. Execution never throws: every
// failure mode comes back as a CodegraphRun the caller maps to a tool result.

import { execFile } from "node:child_process";

export const CODEGRAPH_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 8 * 1024 * 1024;

export interface ExploreParams {
  query: string;
  maxFiles?: number;
}

export interface NodeParams {
  name?: string;
  file?: string;
  offset?: number;
  limit?: number;
  symbolsOnly?: boolean;
}

export interface CodegraphRun {
  stdout: string;
  stderr: string;
  /** Exit code, or null when the process could not be spawned. */
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
}

export type CodegraphRunner = (
  bin: string,
  args: string[],
  signal: AbortSignal | undefined,
) => Promise<CodegraphRun>;

export function buildExploreArgs(projectRoot: string, params: ExploreParams): string[] {
  const args = ["--no-color", "explore", "-p", projectRoot];
  if (params.maxFiles !== undefined) args.push("--max-files", String(params.maxFiles));
  // `--` keeps a query that starts with a dash from being parsed as an option.
  args.push("--", params.query);
  return args;
}

export function buildNodeArgs(projectRoot: string, params: NodeParams): string[] {
  const args = ["--no-color", "node", "-p", projectRoot];
  if (params.file !== undefined) args.push("-f", params.file);
  if (params.offset !== undefined) args.push("--offset", String(params.offset));
  if (params.limit !== undefined) args.push("--limit", String(params.limit));
  if (params.symbolsOnly) args.push("--symbols-only");
  if (params.name !== undefined) args.push("--", params.name);
  return args;
}

export function createExecFileRunner(timeoutMs: number = CODEGRAPH_TIMEOUT_MS): CodegraphRunner {
  return (bin, args, signal) =>
    new Promise<CodegraphRun>((resolveRun) => {
      execFile(
        bin,
        args,
        { signal, timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (!error) {
            resolveRun({ stdout, stderr, code: 0, timedOut: false, aborted: false });
            return;
          }
          const err = error as Error & { code?: number | string; killed?: boolean };
          const aborted = signal?.aborted === true || err.name === "AbortError";
          const timedOut = !aborted && err.killed === true;
          resolveRun({
            stdout: stdout ?? "",
            stderr: stderr || err.message || "",
            code: typeof err.code === "number" ? err.code : null,
            timedOut,
            aborted,
          });
        },
      );
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/codegraph/tests/cli.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/codegraph/cli.ts src/resources/extensions/codegraph/tests/cli.test.ts
git commit -m "feat(codegraph): argv builders and non-throwing CLI runner"
```

---

### Task 3: The two tools — `tools.ts`

**Files:**
- Create: `src/resources/extensions/codegraph/tools.ts`
- Test: `src/resources/extensions/codegraph/tests/tools.test.ts`

**Interfaces:**
- Consumes: `CodegraphEnv`, `hasIndex` from `./detect.js`; `buildExploreArgs`, `buildNodeArgs`, `CodegraphRunner`, `ExploreParams`, `NodeParams`, `CODEGRAPH_TIMEOUT_MS` from `./cli.js`.
- Produces:
  - `interface CodegraphDetails { command: "explore" | "node"; projectRoot: string; exitCode: number | null; truncated: boolean; error?: string }`
  - `interface CodegraphToolDeps { env: CodegraphEnv; run: CodegraphRunner; isDirectory?: (path: string) => boolean }`
  - `function createExploreTool(deps: CodegraphToolDeps)`
  - `function createNodeTool(deps: CodegraphToolDeps)`

Both factories return a value assignable to `pi.registerTool`, built with `defineTool` from `@gsd/pi-coding-agent` so TypeBox parameter inference survives the assignment.

- [ ] **Step 1: Write the failing test**

Create `src/resources/extensions/codegraph/tests/tools.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createExploreTool, createNodeTool, type CodegraphToolDeps } from "../tools.ts";
import type { CodegraphRun } from "../cli.ts";

const ENV = { binPath: "/usr/bin/codegraph", projectRoot: "/Users/dev/proj" };

interface Recorded {
  bin: string;
  args: string[];
}

/** Deps whose runner records its invocation and returns a canned result. */
function deps(
  result: Partial<CodegraphRun> = {},
  overrides: Partial<CodegraphToolDeps> = {},
): { deps: CodegraphToolDeps; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const base: CodegraphToolDeps = {
    env: ENV,
    isDirectory: () => true,
    run: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: "", stderr: "", code: 0, timedOut: false, aborted: false, ...result };
    },
  };
  return { deps: { ...base, ...overrides }, calls };
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => ("text" in c ? (c.text ?? "") : "")).join("");
}

test("codegraph_explore is named and described for the model", () => {
  const tool = createExploreTool(deps().deps);
  assert.equal(tool.name, "codegraph_explore");
  assert.ok(tool.promptSnippet);
  assert.ok(tool.promptGuidelines && tool.promptGuidelines.length > 0);
  assert.match(tool.promptGuidelines.join(" "), /before grep/i);
});

test("codegraph_explore invokes the binary with the built argv and returns stdout", async () => {
  const { deps: d, calls } = deps({ stdout: "**Exploration: foo**\n" });
  const tool = createExploreTool(d);
  const result = await tool.execute("id", { query: "foo" }, undefined, undefined, {} as never);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "/usr/bin/codegraph");
  assert.deepEqual(calls[0].args, ["--no-color", "explore", "-p", ENV.projectRoot, "--", "foo"]);
  assert.equal(textOf(result), "**Exploration: foo**\n");
  assert.equal(result.isError, undefined);
  assert.equal(result.details.command, "explore");
});

test("a nonzero exit becomes an error result carrying stderr, not a throw", async () => {
  const { deps: d } = deps({ code: 1, stderr: "✗ CodeGraph isn't available here" });
  const tool = createExploreTool(d);
  const result = await tool.execute("id", { query: "foo" }, undefined, undefined, {} as never);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /isn't available here/);
  assert.equal(result.details.exitCode, 1);
});

test("a not-found answer exits 0 and is passed through as a normal result", async () => {
  // Verified against the real binary: `node -- missingSymbol` exits 0 and prints
  // the not-found line on stdout. Never treat it as an error.
  const { deps: d } = deps({ stdout: 'Symbol "zzz" not found in the codebase\n', code: 0 });
  const tool = createNodeTool(d);
  const result = await tool.execute("id", { name: "zzz" }, undefined, undefined, {} as never);
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /not found in the codebase/);
});

test("a timeout becomes an error result naming the timeout", async () => {
  const { deps: d } = deps({ timedOut: true, code: null });
  const tool = createExploreTool(d);
  const result = await tool.execute("id", { query: "foo" }, undefined, undefined, {} as never);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /timed out/i);
});

test("an abort becomes an error result and says so", async () => {
  const { deps: d } = deps({ aborted: true, code: null });
  const tool = createExploreTool(d);
  const result = await tool.execute("id", { query: "foo" }, undefined, undefined, {} as never);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /abort/i);
});

test("an index removed mid-session is an error result and spawns nothing", async () => {
  const { deps: d, calls } = deps({}, { isDirectory: () => false });
  const tool = createExploreTool(d);
  const result = await tool.execute("id", { query: "foo" }, undefined, undefined, {} as never);
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  assert.match(textOf(result), /grep/i);
});

test("oversized output is truncated and says so", async () => {
  // DEFAULT_MAX_LINES is 2000; 3000 lines trips the line limit before the byte limit.
  const huge = `${Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n")}\n`;
  const { deps: d } = deps({ stdout: huge });
  const tool = createExploreTool(d);
  const result = await tool.execute("id", { query: "foo" }, undefined, undefined, {} as never);
  assert.equal(result.details.truncated, true);
  assert.ok(textOf(result).length < huge.length);
  assert.match(textOf(result), /truncated/i);
});

test("codegraph_node rejects a call with neither name nor file, without spawning", async () => {
  const { deps: d, calls } = deps();
  const tool = createNodeTool(d);
  const result = await tool.execute("id", {}, undefined, undefined, {} as never);
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  assert.match(textOf(result), /name.*file|file.*name/i);
});

test("codegraph_node file mode builds file-mode argv", async () => {
  const { deps: d, calls } = deps({ stdout: "ok" });
  const tool = createNodeTool(d);
  await tool.execute("id", { file: "src/cli.ts", symbolsOnly: true }, undefined, undefined, {} as never);
  assert.deepEqual(calls[0].args, [
    "--no-color",
    "node",
    "-p",
    ENV.projectRoot,
    "-f",
    "src/cli.ts",
    "--symbols-only",
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/codegraph/tests/tools.test.ts
```

Expected: fails to resolve `../tools.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/resources/extensions/codegraph/tools.ts`:

```ts
// gsd-pi — CodeGraph tools.
//
// Two tools mirroring what codegraph's own MCP server exposes. Both are only
// ever constructed when detect.ts says the project is indexed, so their prompt
// guidelines are automatically absent in projects without a graph.

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
  type AgentToolResult,
} from "@gsd/pi-coding-agent";
import { Type } from "@gsd/pi-ai";
import {
  CODEGRAPH_TIMEOUT_MS,
  buildExploreArgs,
  buildNodeArgs,
  type CodegraphRunner,
  type ExploreParams,
  type NodeParams,
} from "./cli.js";
import { hasIndex, type CodegraphEnv } from "./detect.js";

export interface CodegraphDetails {
  command: "explore" | "node";
  projectRoot: string;
  exitCode: number | null;
  truncated: boolean;
  error?: string;
}

export interface CodegraphToolDeps {
  env: CodegraphEnv;
  run: CodegraphRunner;
  isDirectory?: (path: string) => boolean;
}

function errorResult(
  command: "explore" | "node",
  projectRoot: string,
  message: string,
  exitCode: number | null = null,
): AgentToolResult<CodegraphDetails> {
  return {
    content: [{ type: "text", text: message }],
    details: { command, projectRoot, exitCode, truncated: false, error: message },
    isError: true,
  };
}

async function runTool(
  deps: CodegraphToolDeps,
  command: "explore" | "node",
  args: string[],
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<CodegraphDetails>> {
  const { projectRoot } = deps.env;
  if (!hasIndex(projectRoot, deps.isDirectory)) {
    return errorResult(
      command,
      projectRoot,
      `The CodeGraph index for ${projectRoot} is no longer present. Use grep and read instead.`,
    );
  }

  const run = await deps.run(deps.env.binPath, args, signal);
  if (run.aborted) return errorResult(command, projectRoot, "CodeGraph call was aborted.");
  if (run.timedOut) {
    return errorResult(command, projectRoot, `CodeGraph timed out after ${CODEGRAPH_TIMEOUT_MS}ms.`);
  }
  if (run.code !== 0) {
    const detail =
      (run.stderr || run.stdout).trim() || `codegraph exited with code ${String(run.code)}`;
    return errorResult(command, projectRoot, detail, run.code);
  }

  const truncation = truncateHead(run.stdout, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const text = truncation.truncated
    ? `${truncation.content}\n\n[truncated — ${truncation.outputLines} of ${truncation.totalLines} lines shown; narrow the query]`
    : truncation.content;
  return {
    content: [{ type: "text", text }],
    details: { command, projectRoot, exitCode: 0, truncated: truncation.truncated },
  };
}

export function createExploreTool(deps: CodegraphToolDeps) {
  return defineTool({
    name: "codegraph_explore",
    label: "CodeGraph Explore",
    description:
      "Explore an area of this codebase through its CodeGraph symbol index. Returns the relevant " +
      "symbols' verbatim, line-numbered source, the call paths between them (including dynamic-dispatch " +
      "hops grep cannot follow), and a blast-radius summary of what depends on them. One call replaces " +
      "a grep-then-read loop.",
    promptSnippet: "Explore code through the CodeGraph symbol index",
    promptGuidelines: [
      "This project has a CodeGraph index. Reach for codegraph_explore before grep or find when you need to locate or understand code.",
      "Name a file or symbol in the query to get its current line-numbered source; treat source returned this way as already read.",
      "Use grep for non-code text — log lines, config values, strings in data files — where a symbol graph cannot help.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Symbol names or a natural-language question, e.g. 'detectHerdrEnv' or 'how are extensions registered'",
      }),
      maxFiles: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 20,
          description: "Maximum number of files to include source from. Omit for codegraph's default.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      return runTool(deps, "explore", buildExploreArgs(deps.env.projectRoot, params as ExploreParams), signal);
    },
  });
}

export function createNodeTool(deps: CodegraphToolDeps) {
  return defineTool({
    name: "codegraph_node",
    label: "CodeGraph Node",
    description:
      "Read one symbol's source plus its caller/callee trail from the CodeGraph index, or read a whole " +
      "file with line numbers plus the files that depend on it. Pass `name` for symbol mode, `file` for " +
      "file mode, or both to disambiguate a symbol to a file.",
    promptSnippet: "Read a symbol or file, with dependents, from the CodeGraph index",
    promptGuidelines: [
      "Prefer codegraph_node over read when you want one symbol and its callers rather than a whole file.",
      "File mode returns the same line-numbered content as read, plus the files that depend on it; treat the file as read.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Symbol name, e.g. 'detectHerdrEnv'" })),
      file: Type.Optional(
        Type.String({
          description:
            "File path, repo-relative or absolute. Alone for file mode, or alongside `name` to disambiguate.",
        }),
      ),
      offset: Type.Optional(Type.Number({ minimum: 1, description: "File mode only: 1-based start line" })),
      limit: Type.Optional(Type.Number({ minimum: 1, description: "File mode only: maximum lines" })),
      symbolsOnly: Type.Optional(
        Type.Boolean({ description: "File mode only: return just the symbol map and dependents" }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const p = params as NodeParams;
      if (!p.name && !p.file) {
        return errorResult(
          "node",
          deps.env.projectRoot,
          "codegraph_node needs `name` for symbol mode or `file` for file mode.",
        );
      }
      return runTool(deps, "node", buildNodeArgs(deps.env.projectRoot, p), signal);
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/codegraph/tests/tools.test.ts
```

Expected: PASS, 10 tests.

`defineTool` and `AgentToolResult` are both re-exported from `@gsd/pi-coding-agent` (`packages/pi-coding-agent/src/index.ts:19` and `:107`). Do not import them from `@gsd/pi-agent-core` — that package is not a declared dependency of the root package. If any import fails to resolve, find the real export site rather than widening types to `any`.

- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/codegraph/tools.ts src/resources/extensions/codegraph/tests/tools.test.ts
git commit -m "feat(codegraph): codegraph_explore and codegraph_node tools"
```

---

### Task 4: Wiring, manifest, and CI registration

**Files:**
- Create: `src/resources/extensions/codegraph/index.ts`
- Create: `src/resources/extensions/codegraph/extension-manifest.json`
- Test: `src/resources/extensions/codegraph/tests/registration.test.ts`
- Modify: `package.json` — the `test:unit:compiled` and `test:coverage:unit` scripts
- Modify: `docs/dev/FILE-SYSTEM-MAP.md`

**Interfaces:**
- Consumes: `detectCodegraph`, `CodegraphEnv` from `./detect.js`; `createExecFileRunner`, `CodegraphRunner` from `./cli.js`; `createExploreTool`, `createNodeTool` from `./tools.js`.
- Produces: `function __wire(pi: ExtensionAPI, env: CodegraphEnv, run: CodegraphRunner): void` and the default export.

`__wire` exists as a testable seam, matching `src/resources/extensions/herdr/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/resources/extensions/codegraph/tests/registration.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { __wire } from "../index.ts";

test("__wire registers exactly the two CodeGraph tools", () => {
  const registered: string[] = [];
  const pi = { registerTool: (tool: { name: string }) => registered.push(tool.name) };
  __wire(
    pi as never,
    { binPath: "/usr/bin/codegraph", projectRoot: "/Users/dev/proj" },
    async () => ({ stdout: "", stderr: "", code: 0, timedOut: false, aborted: false }),
  );
  assert.deepEqual(registered.sort(), ["codegraph_explore", "codegraph_node"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/codegraph/tests/registration.test.ts
```

Expected: fails to resolve `../index.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/resources/extensions/codegraph/index.ts`:

```ts
// gsd-pi — CodeGraph extension.
//
// Gives the agent symbol-graph exploration in projects that already have a
// .codegraph/ index. A hard no-op otherwise: no tools, no prompt text, no cost.
// Read-only — this extension never creates or updates an index.

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { createExecFileRunner, type CodegraphRunner } from "./cli.js";
import { detectCodegraph, type CodegraphEnv } from "./detect.js";
import { createExploreTool, createNodeTool } from "./tools.js";

/** Testable wiring seam — see tests/registration.test.ts. */
export function __wire(pi: ExtensionAPI, env: CodegraphEnv, run: CodegraphRunner): void {
  const deps = { env, run };
  pi.registerTool(createExploreTool(deps));
  pi.registerTool(createNodeTool(deps));
}

export default function (pi: ExtensionAPI): void {
  const env = detectCodegraph();
  if (!env) return; // no index or no binary — register nothing
  __wire(pi, env, createExecFileRunner());
}
```

Create `src/resources/extensions/codegraph/extension-manifest.json`:

```json
{
  "id": "codegraph",
  "name": "CodeGraph",
  "version": "1.0.0",
  "description": "Symbol-graph code exploration for projects that have a .codegraph/ index",
  "tier": "bundled",
  "requires": { "platform": ">=2.29.0" },
  "provides": {
    "tools": ["codegraph_explore", "codegraph_node"]
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/codegraph/tests/registration.test.ts
```

Expected: PASS, 1 test.

- [ ] **Step 5: Register the tests with CI**

In `package.json`, both the `test:unit:compiled` and `test:coverage:unit` scripts enumerate extension test directories one path at a time. A new `tests/` directory runs nowhere unless it is added — and the failure is silent, looking exactly like passing.

Both scripts contain this exact substring once each:

```
"dist-test/src/resources/extensions/mcp-client/tests/*.test.js"
```

Replace **both** occurrences (use an `Edit` with `replace_all: true`) with:

```
"dist-test/src/resources/extensions/mcp-client/tests/*.test.js" \"dist-test/src/resources/extensions/codegraph/tests/*.test.js\"
```

Take care with the escaping: inside the JSON string these paths are written as `\"...\"`, so the inserted glob must be `\"dist-test/src/resources/extensions/codegraph/tests/*.test.js\"` in the raw file.

- [ ] **Step 6: Verify the tests actually run in the compiled suite**

```bash
pnpm run test:compile && node --import ./scripts/dist-test-resolve.mjs --test "dist-test/src/resources/extensions/codegraph/tests/*.test.js"
```

Expected: all four test files run and pass — 37 tests total (14 + 12 + 10 + 1). If the glob matches nothing, the compile step or the path is wrong; fix it before continuing, because a glob that matches nothing exits 0 and looks like success.

- [ ] **Step 7: Document the new files**

In `docs/dev/FILE-SYSTEM-MAP.md`, add these rows to the extension file table, immediately before the `mac-tools/index.ts` row:

```
| codegraph/index.ts | CodeGraph | CodeGraph extension entry — registers tools only when the project is indexed |
| codegraph/detect.ts | CodeGraph | Binary and .codegraph/ index detection gate |
| codegraph/cli.ts | CodeGraph | codegraph argv construction and process execution |
| codegraph/tools.ts | CodeGraph | codegraph_explore and codegraph_node tool definitions |
```

And add this row to the subsystem table, immediately before the `**Mac Tools**` row:

```
| **CodeGraph** | src/resources/extensions/codegraph/* |
```

- [ ] **Step 8: Commit**

```bash
git add src/resources/extensions/codegraph/index.ts \
        src/resources/extensions/codegraph/extension-manifest.json \
        src/resources/extensions/codegraph/tests/registration.test.ts \
        package.json docs/dev/FILE-SYSTEM-MAP.md
git commit -m "feat(codegraph): wire the extension, manifest, and CI test globs"
```

---

### Task 5: Full-suite check and live smoke test

**Files:** none created or modified unless a check fails.

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: evidence that the extension behaves correctly in both the indexed and unindexed cases.

- [ ] **Step 1: Typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors in `src/resources/extensions/codegraph/`. Pre-existing errors elsewhere are not yours; do not fix them, but do report them.

- [ ] **Step 2: Run the full unit suite**

`pnpm run test:unit` needs `--test-concurrency=8` in this repo — at the default concurrency it gets OOM-killed (exit 137, empty log) or trips the 90s workflow-authority baseline budget. **`pnpm run test:unit --test-concurrency=8` does not work**: `test:unit` is three chained scripts and pnpm appends the flag to the last one only, so the big suite still runs unbounded. Run the compile step, then invoke the compiled suite yourself with the flag immediately after `node`:

```bash
pnpm run test:compile
```

Then take the `test:unit:compiled` command from `package.json`, insert `--test-concurrency=8` directly after `node`, and run it — keeping its full glob list unchanged apart from the codegraph glob you added in Task 4.

Known baseline failures, present before this change and not caused by it:

- ~23 in `src/resources/extensions/gsd/tests/migrate-safety-audit.test.ts` (`handle.setMutationBoundaryFaultForTest is not a function`) — these only appear when `native/addon/gsd_engine.dev.node` exists.
- `src/tests/bootstrap-links.test.ts`, which fails alongside them and makes the count 24.
- `workflow authority baseline controlled sabotage exits nonzero` is load-sensitive and fails when a second suite is running concurrently on the machine.

Anything outside that list is yours. Report it rather than working around it.

- [ ] **Step 3: Confirm the gate is closed in this worktree**

This worktree has no `.codegraph/`, so detection must return null:

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types \
  -e "import('./src/resources/extensions/codegraph/detect.ts').then(m => console.log(m.detectCodegraph()))"
```

Expected: `null`. If it prints an object, the upward walk is escaping to a parent index or matching `~/.codegraph` — fix Task 1 before continuing.

- [ ] **Step 4: Smoke-test the real binary against a real index**

The main checkout at `/Users/MiRogers/git/eagle27272/gsd-pi` is indexed; this worktree is not. Do **not** `cd` into the main checkout — pass its path explicitly:

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types \
  -e "import('./src/resources/extensions/codegraph/detect.ts').then(m => console.log(m.detectCodegraph({ cwd: '/Users/MiRogers/git/eagle27272/gsd-pi' })))"
```

Expected: an object with `projectRoot: '/Users/MiRogers/git/eagle27272/gsd-pi'` and a `binPath` ending in `/codegraph`.

- [ ] **Step 5: Smoke-test a tool end to end**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types \
  -e "Promise.all([import('./src/resources/extensions/codegraph/detect.ts'), import('./src/resources/extensions/codegraph/cli.ts'), import('./src/resources/extensions/codegraph/tools.ts')]).then(async ([d, c, t]) => { const env = d.detectCodegraph({ cwd: '/Users/MiRogers/git/eagle27272/gsd-pi' }); const tool = t.createExploreTool({ env, run: c.createExecFileRunner() }); const r = await tool.execute('smoke', { query: 'detectHerdrEnv', maxFiles: 1 }, undefined, undefined, {}); console.log(r.isError ? 'ERROR' : 'OK', r.details); console.log(r.content[0].text.slice(0, 400)); })"
```

Expected: `OK`, details showing `command: 'explore'` and `exitCode: 0`, followed by an exploration report naming `detectHerdrEnv` and its callers.

- [ ] **Step 6: Report**

State plainly which checks passed, paste the failing output for any that did not, and note any pre-existing failures you observed so they are not mistaken for regressions. Do not claim completion without this evidence.

---

## Notes for the implementer

**Why no worktree fallback.** `git rev-parse --git-common-dir` would make codegraph available in worktrees in about three lines. It is deliberately absent: the main checkout's index describes a different branch, with different line numbers and sometimes different function bodies. Interestingly, codegraph guards this itself — querying it with `-p <main checkout>` from a worktree prints a warning banner about the mismatch — but the extension does not rely on that guard, it simply never makes the cross-tree query. Do not add the fallback because it looks like an easy win.

**Why the gate rather than an always-on tool that errors.** Registering tools that always fail would cost schema tokens on every request in every unindexed project, and would tempt the model into retry loops. Absence is the correct behaviour.

**Do not add a `before_agent_start` hook.** The prompt guidance rides on each tool's `promptGuidelines`, which the platform only emits for active tools. Since the tools are conditionally registered, the guidance is already conditional. A hook would duplicate it.
