# Development

Engineering rules and local workflow for gsd-pi. Extracted from the fork-point
`CONTRIBUTING.md`, which was removed when this became a private-use repository.

## Local development

### One-time setup (after cloning)

```bash
pnpm install --frozen-lockfile      # Install dependencies — MUST run first
pnpm run secret-scan:install-hook   # Install git hooks — run once
```

`pnpm install` creates workspace symlinks in `node_modules/@gsd/*` and `node_modules/@opengsd/*` pointing to `packages/`. These are required for builds and tests to resolve packages correctly.

Run `pnpm run secret-scan:install-hook` once after cloning. It installs a pre-commit hook that blocks commits containing hardcoded secrets or credentials. Conventional Commits format is validated by CI on push.

### Day-to-day development

```bash
pnpm run build    # Build
pnpm test         # Run tests
```

To iterate faster, test only what you changed instead of the full suite:

```bash
pnpm run test:changed:src              # run unit tests for your modified source files
pnpm --filter @gsd/<package> test      # run one workspace package's tests
```

If `pnpm run build` fails after running tests (e.g. `Cannot find module '@gsd/*'` errors), run `pnpm install --frozen-lockfile` first to restore workspace symlinks, then try again.

The unit suite caps its own worker concurrency (see [Test confidence stack](./test-confidence-stack.md)), so `pnpm run test:unit` is correct as written. To change the cap, set `TEST_CONCURRENCY=<n>` in the environment — appending `--test-concurrency` to `pnpm run test:unit` does nothing useful, because pnpm passes trailing args to the last sub-command of a compound script only.

### Before pushing

CI is tiered to match local scripts. See [Test confidence stack](./test-confidence-stack.md) for the full map.

```bash
pnpm run verify:fast    # ~1–3 min: same scans as CI fast-gates (secrets, docs injection, skill refs)
pnpm run verify:pr      # ~5–15 min: fast inner loop — build:core → typecheck:extensions → test:unit
pnpm run verify:merge:needed -- --base upstream/main  # decide whether this diff really needs the full merge gate
pnpm run verify:merge   # ~20–60+ min on large diffs: CI PR blocking parity (native test addon, build, all test jobs, validate-pack)
pnpm run verify:full    # Alias for verify:merge
pnpm run audit:test-confidence   # Inventory report: runners, tiers, thin areas
```

Run `verify:fast` on every push. While iterating, `verify:pr` is enough for a quick check. Before requesting review, run `pnpm run verify:merge:needed -- --base upstream/main` first. If it reports that the diff is `heavy-code-changed=true`, run `verify:merge`; otherwise `verify:fast` plus targeted checks is enough unless you want extra confidence. A passing `verify:pr` alone does not match what CI requires when the heavy Linux gate will run.

`verify:merge` builds the native engine with `pnpm run build:native:test` (needs Rust/`rustc`) and copies `native/addon/*.node` into `dist-test/native/addon/` with `GSD_NATIVE_PREFER_LOCAL=1`, matching CI. Without that, compiled unit tests fail on a fresh checkout because the published `@opengsd/engine-*` binary can lag N-API exports such as `ProjectionRootIdentityLock`.

If `verify:pr` fails after running tests (e.g. `Cannot find module '@gsd/*'` errors), run `pnpm install --frozen-lockfile` first to restore workspace symlinks, then try again.

### Cross-platform note

gsd-pi runs on macOS, Linux, and Windows:

- **Git hooks** are executed by Git's bundled shell, so they work from any terminal (CMD, PowerShell, Git Bash).
- **Shell scripts** in `scripts/` use `#!/usr/bin/env bash`. On Windows, Git may convert these to CRLF line endings, which breaks the shebang. The repository's committed `.gitattributes` owns line-ending rules; if shell scripts need explicit protection, add `*.sh text eol=lf` there and include that change in your PR.

### Native engine version lockstep

Production installs load the native engine from the `@opengsd/engine-*` platform packages, pinned to an exact version in the root `package.json` `optionalDependencies`. Version bumps are release-time only: the release workflow runs `node scripts/bump-version.mjs <version>` and then publishes the `@opengsd/engine-*` binaries. **PRs must not bump version surfaces** (`package.json`, `native/Cargo.toml`, `native/npm/*/package.json`, workspace packages) — pinning an engine version that is not yet on npm breaks `pnpm install --frozen-lockfile` in CI and for every contributor.

If a change adds or changes N-API exports (e.g. in `native/crates/`), the already-published engine binaries do not contain them, so until the next release publishes new binaries the new flows fail closed as "unavailable" at runtime and gsd-pi runs on its JS fallbacks (or the locally built addon with `GSD_NATIVE_PREFER_LOCAL=1`). This is intentional — never republish or mutate an already-released engine version, and never bump versions inside a feature PR to work around it.

## Architecture guidelines

Before writing code, understand these principles:

- **Extension-first.** Can this be an extension instead of a core change? If yes, build it as an extension.
- **Simplicity wins.** Don't add abstractions, helpers, or utilities for one-time operations. Don't design for hypothetical future requirements.
- **Tests are the contract.** Changed behavior? The test suite tells you what you broke.

## Testing standards

This project uses Node.js built-in `node:test` as the test runner. All new tests must follow these patterns:

### Use `node:test` and `node:assert/strict`

```typescript
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
```

Do not use `createTestContext()` from `test-helpers.ts` (legacy, being removed). Do not introduce Jest, Vitest, or other test frameworks.

### Use `beforeEach`/`afterEach` or `t.after()` for cleanup — never `try`/`finally`

```typescript
// ✅ CORRECT — shared fixture with beforeEach/afterEach
describe("feature", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("case", () => {
    /* clean test body */
  });
});

// ✅ CORRECT — per-test cleanup with t.after()
test("case", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "test-"));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  // test body
});

// ❌ WRONG — inline try/finally
test("case", () => {
  const tmp = mkdtempSync(join(tmpdir(), "test-"));
  try {
    // test body
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

**When to use which:**

- `beforeEach`/`afterEach` — when all tests in a `describe` block share the same setup/teardown pattern
- `t.after()` — when each test has unique cleanup (different fixtures, env vars, etc.)
- `try`/`finally` — only inside standalone helper functions that don't have access to the test context `t` (e.g., `withEnv()`, `capture()`)

### Template literal fixture data

When constructing multi-line fixture content (markdown, YAML, etc.) inside indented test blocks, use array join to avoid unintended leading whitespace:

```typescript
// ✅ CORRECT — no indentation leakage
const content = [
  "## Slices",
  "- [x] **S01: First slice**",
  "- [ ] **S02: Second slice**",
].join("\n");

// ❌ WRONG — template literal inside describe/test adds leading spaces
const content = `
  ## Slices
  - [x] **S01: First slice**
`;
// Each line now has 2 leading spaces, breaking ^## regex anchors
```

### Test-first for bug fixes

Bug fixes must include a regression test that fails before the fix and passes after. Write the test first, confirm it fails, then apply the fix. See the `test-first-bugfix` skill.

### No source-grep tests

A test must execute the code under test. Reading a source file with `readFileSync` (or any equivalent) and asserting against its contents with regex, string matching, or AST inspection is **not a test** — it asserts that the code was *written a certain way*, not that it *behaves correctly*. This is pure Goodhart's Law: the metric (test count, coverage) gets satisfied while the actual property (correctness) is untouched.

```typescript
// ❌ WRONG — source-grep test. Passes if the string exists, regardless of behavior.
test("handles null input", () => {
  const source = readFileSync("src/parser.ts", "utf8");
  assert.match(source, /if \(input === null\)/);
});

// ❌ WRONG — same anti-pattern with AST or string includes.
test("exports the function", () => {
  const source = readFileSync("src/index.ts", "utf8");
  assert.ok(source.includes("export function parse"));
});

// ✅ CORRECT — import the code and exercise it.
import { parse } from "../src/parser.ts";
test("handles null input", () => {
  assert.equal(parse(null), undefined);
});
```

CI enforces this via `scripts/check-source-grep-tests.sh` (wired into the `fast-gates` job) — it scans changed test files for `readFileSync` / `readFile` calls whose path argument points into `src/` or `packages/`. If the code under test is genuinely hard to invoke (e.g., a build script, a CLI entry point), invoke it as a subprocess and assert on its real output — not on its source text.

The narrow exception: tests that legitimately verify *file structure* as the actual product (e.g., a code generator's output, a config-file linter, a script that produces a manifest). In those cases the file contents *are* the behavior. Opt out with a same-line or preceding-line marker:

```typescript
// allow-source-grep: this test verifies the codegen output, which IS the product
const generated = readFileSync("packages/codegen/dist/manifest.ts", "utf8");
assert.match(generated, /export const ROUTES =/);
```

The reason becomes part of the diff and is visible at review. If you're not sure whether your case qualifies, it doesn't.

### Three recurring defect classes

These patterns have caused real bugs in merged PRs (see issue #4931). Watch for them.

**1. `Statement#get()` returns `undefined`, not `null`.** better-sqlite3's `Statement#get(…)` returns `undefined` when no row matches. A `!== null` guard passes for `undefined` too (`undefined !== null` is `true`), so the guard is always truthy and downstream property access crashes.

```typescript
// ❌ WRONG
const row = stmt.get(id);
if (row !== null) {
  use(row.v);  // row is undefined → crash
}

// ✅ CORRECT
const row = stmt.get(id);
if (row != null) { use(row.v); }        // catches both null and undefined
// or
if (row === undefined) return null;
// or
return row ?? defaultValue;
```

**2. Attach `once()` listeners BEFORE the triggering syscall.** If the event fires synchronously (fast exit, already-emitted event), a listener attached after the trigger misses it.

```typescript
// ❌ WRONG — listener can miss sync exit
proc.kill("SIGINT");
await new Promise(resolve => proc.once("exit", resolve));

// ✅ CORRECT — listener first, trigger after
const done = new Promise(resolve => proc.once("exit", resolve));
proc.kill("SIGINT");
await done;
```

**3. `.mjs` importing `.ts` requires `--experimental-strip-types`.** Without the flag (or `--import tsx`, `--loader ts-node`, etc.), Node throws `ERR_UNKNOWN_FILE_EXTENSION`. If your `.mjs` harness imports any `.ts` module, every script that runs it must pass the flag.

```json
// ❌ WRONG
"test:tokens": "node --test web/lib/__tests__/example.test.ts"

// ✅ CORRECT
"test:tokens": "node --experimental-strip-types --test web/lib/__tests__/example.test.ts"
```
