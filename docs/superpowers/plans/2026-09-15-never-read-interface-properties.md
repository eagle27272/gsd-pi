# Never-Read Interface Properties Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a ratcheted CI gate that reports interface and type-literal properties which are written somewhere and never read — the one dead-code shape neither `tsc` nor knip can see.

**Architecture:** One `ts.Program` over the whole repo, one AST walk. Reads are indexed by property *name*; writes are resolved to the declared symbol through the object literal's contextual type. A property is reported when it is written at least once and no property of that name is read anywhere. Findings ratchet against a committed baseline exactly as the knip gate does.

**Tech Stack:** Node 24.20.0, TypeScript 5.9.3 compiler API (`import ts from "typescript"`), `node:test`, plain `.mjs` scripts. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-09-15-never-read-interface-properties-design.md](../specs/2026-09-15-never-read-interface-properties-design.md)

## Global Constraints

- **No new dependencies.** TypeScript 5.9.3 is already a devDependency; nothing else is needed.
- **Node 24.20.0** is the floor (`2c51de9b` raised it). `fs.globSync` and `import.meta.dirname` are available and used by existing scripts.
- **Scripts are `.mjs` with ESM imports.** Follow `scripts/knip-gate.mjs` and `scripts/lib/knip-baseline-lib.mjs`.
- **Every script test file starts with the two-line banner** used across `scripts/__tests__/`:
  ```js
  // Project/App: gsd-pi
  // File Purpose: <one line>
  ```
- **Comment policy** (from CLAUDE.md): no comments that restate what the code does, no comments narrating changes. Comment only non-obvious *why*. The existing knip lib is a good model — its comments explain load-bearing decisions, not mechanics.
- **Finding key format:** `writeOnly|<file>|<Owner>.<property>`, no line or column, file path relative to repo root with forward slashes.
- **Baseline path:** `.config/iface-props-baseline.json`
- **npm scripts:** `lint:dead-code:props` and `lint:dead-code:props:update`
- **Declaration scope** (first-party only — `packages/pi-*` is in the program for reads but never yields findings):
  ```
  src/**/*.ts
  scripts/**/*.ts
  packages/contracts/src/**/*.ts
  packages/db/**/*.ts
  packages/gsd-agent-core/src/**/*.ts
  packages/gsd-agent-modes/src/**/*.ts
  packages/mcp-server/src/**/*.ts
  packages/native/src/**/*.ts
  packages/rpc-client/src/**/*.ts
  ```
- **Program scope:** the above plus `packages/pi-*/src/**/*.ts`. `.d.ts` files are excluded everywhere.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/lib/baseline-ratchet.mjs` | **New.** Generic baseline parse/diff/render/exit-code, shared by both gates. Extracted from the knip lib in Task 1. |
| `scripts/lib/knip-baseline-lib.mjs` | **Modify.** Keeps its knip-specific flattening; delegates baseline mechanics to `baseline-ratchet.mjs`. |
| `scripts/lib/iface-props-lib.mjs` | **New.** Declaration collection, reference classification, the write-only join, and the glob lists. All logic lives here; no CLI concerns. |
| `scripts/iface-props-gate.mjs` | **New.** CLI only: resolve globs, build the program, call the lib, diff the baseline, print, set exit code. Mirrors `scripts/knip-gate.mjs`. |
| `.config/iface-props-baseline.json` | **New.** The ratchet, generated in Task 5. |
| `scripts/__tests__/iface-props-gate.test.mjs` | **New.** Classification fixtures, false-positive fixtures, the #79 regression, baseline round-trip, wiring drift, glob rot. |
| `package.json` | **Modify.** Two new scripts. |
| `.github/workflows/ci.yml`, `scripts/ci-fast-gates.sh`, `scripts/verify-merge.sh` | **Modify.** Run the gate alongside `lint:dead-code`. |
| `docs/dev/dead-code-lint.md` | **Modify.** Its "What knip does *not* catch" section currently says this case is untracked. |

---

### Task 1: Extract the shared baseline ratchet

The baseline parse/diff/render/exit-code machinery is identical for both gates. Extract it before writing the second gate rather than duplicating ~40 lines. The existing knip tests cover every behaviour, so they verify the refactor.

**Files:**
- Create: `scripts/lib/baseline-ratchet.mjs`
- Modify: `scripts/lib/knip-baseline-lib.mjs` (remove `parseBaseline`, `diffAgainstBaseline`, `renderBaselineFile`, `exitCodeForDiff` bodies; re-export wrappers)
- Test: `scripts/__tests__/knip-gate.test.mjs` (unchanged — it must pass as-is)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseBaseline(text, label = "baseline") -> string[]`
  - `diffAgainstBaseline(current, baseline) -> { added: string[], resolved: string[] }`
  - `renderBaselineFile(header, keys) -> string`
  - `exitCodeForDiff(diff) -> 0 | 1`

- [ ] **Step 1: Run the existing knip tests to record the green baseline**

Run: `node --test scripts/__tests__/knip-gate.test.mjs`
Expected: PASS, all tests. Note the count — it must be identical after the refactor.

- [ ] **Step 2: Create the shared module**

Create `scripts/lib/baseline-ratchet.mjs`:

```js
/**
 * Baseline ratchet shared by the dead-code gates: parse a committed findings
 * snapshot, diff the current run against it, and render it back deterministically.
 *
 * `label` names the owning gate in error messages so a corrupt baseline says
 * which file to regenerate.
 */

export function parseBaseline(text, label = "baseline") {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  const findings = parsed?.findings;
  if (!Array.isArray(findings) || findings.some((key) => typeof key !== 'string')) {
    throw new Error(`${label} must hold a \`findings\` array of strings`);
  }
  return findings;
}

export function diffAgainstBaseline(current, baseline) {
  const currentSet = new Set(current);
  const baselineSet = new Set(baseline);
  return {
    added: current.filter((key) => !baselineSet.has(key)).sort(),
    resolved: baseline.filter((key) => !currentSet.has(key)).sort(),
  };
}

export function renderBaselineFile(header, keys) {
  return `${JSON.stringify({ '//': header, findings: [...keys].sort() }, null, 2)}\n`;
}

export function exitCodeForDiff(diff) {
  return diff.added.length > 0 ? 1 : 0;
}
```

- [ ] **Step 3: Re-point the knip lib at it**

In `scripts/lib/knip-baseline-lib.mjs`, delete the bodies of `parseBaseline`, `diffAgainstBaseline`, `renderBaselineFile` and `exitCodeForDiff`, and add at the top of the file:

```js
import {
  diffAgainstBaseline,
  exitCodeForDiff,
  parseBaseline as parseBaselineText,
  renderBaselineFile as renderBaseline,
} from './baseline-ratchet.mjs';
```

Replace the four removed functions with:

```js
export { diffAgainstBaseline, exitCodeForDiff };

export function parseBaseline(text) {
  return parseBaselineText(text, 'knip baseline');
}

export function renderBaselineFile(keys) {
  return renderBaseline(BASELINE_HEADER, keys);
}
```

Keep `BASELINE_HEADER`, `ISSUE_TYPES`, `symbolOf`, `flattenKnipReport` and `parseKnipReport` exactly as they are. The wrappers preserve the existing one-argument signatures, so no caller changes.

- [ ] **Step 4: Run the knip tests unchanged**

Run: `node --test scripts/__tests__/knip-gate.test.mjs`
Expected: PASS, same test count as Step 1. The two message assertions (`/findings/` and `/baseline/i`) still match because the label is `"knip baseline"`.

- [ ] **Step 5: Verify the real gate still runs**

Run: `pnpm run lint:dead-code`
Expected: `knip: no new dead code (N baselined finding(s)) ✓`

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/baseline-ratchet.mjs scripts/lib/knip-baseline-lib.mjs
git commit -m "refactor(scripts): extract the baseline ratchet shared by dead-code gates"
```

---

### Task 2: Declaration collection and owner labelling

**Files:**
- Create: `scripts/lib/iface-props-lib.mjs`
- Create: `scripts/__tests__/iface-props-gate.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `DECLARATION_GLOBS: string[]` — the nine first-party globs from Global Constraints
  - `PROGRAM_GLOBS: string[]` — `DECLARATION_GLOBS` plus `packages/pi-*/src/**/*.ts`
  - `BASELINE_HEADER: string`
  - `createProgram(filePaths: string[]) -> ts.Program`
  - `ownerLabel(node: ts.Node) -> string` — nearest named enclosing declaration
  - `collectDeclarations(program, checker, isFirstParty, root) -> Map<ts.Symbol, { name, file, owner, key }>`
    - `isFirstParty: (absolutePath: string) => boolean`
    - `root: string` — absolute path that `file` is made relative to. Passed explicitly rather than derived from `program.getCommonSourceDirectory()`, which varies with which files happen to be in the program and would make baseline keys depend on the glob result rather than on the repo layout.
    - `key` is the full `writeOnly|<file>|<Owner>.<prop>` string
    - `file` is relative to `root`, forward slashes

- [ ] **Step 1: Write the failing tests**

Create `scripts/__tests__/iface-props-gate.test.mjs`:

```js
// Project/App: gsd-pi
// File Purpose: Coverage for the never-read interface-property dead-code gate.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { collectDeclarations, createProgram } from "../lib/iface-props-lib.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

// Compile a set of named sources in a scratch dir and hand back the program,
// checker and the fixture root so assertions can use relative paths.
function withFixture(files, run) {
  const dir = mkdtempSync(join(tmpdir(), "gsd-iface-props-"));
  try {
    const paths = Object.entries(files).map(([name, source]) => {
      const path = join(dir, name);
      writeFileSync(path, source, "utf-8");
      return path;
    });
    const program = createProgram(paths);
    return run({ program, checker: program.getTypeChecker(), dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function declarationKeys(files, isFirstParty = () => true) {
  return withFixture(files, ({ program, checker, dir }) =>
    [...collectDeclarations(program, checker, isFirstParty, dir).values()].map((d) => d.key).sort(),
  );
}

test("collectDeclarations names an interface property after its interface", () => {
  const keys = declarationKeys({ "a.ts": "export interface Meta { url: string }" });

  assert.deepEqual(keys, ["writeOnly|a.ts|Meta.url"]);
});

test("collectDeclarations names a type-alias literal property after the alias", () => {
  const keys = declarationKeys({ "a.ts": "export type Meta = { url: string }" });

  assert.deepEqual(keys, ["writeOnly|a.ts|Meta.url"]);
});

// Labelling every anonymous literal `<type-literal>` collapses distinct
// properties onto one key, so deleting all but one would go undetected.
test("collectDeclarations names an anonymous literal after its nearest named ancestor", () => {
  const keys = declarationKeys({
    "a.ts": "export function scan(): { items: string[] } { return { items: [] } }",
  });

  assert.deepEqual(keys, ["writeOnly|a.ts|scan.items"]);
});

test("collectDeclarations disambiguates two literals sharing an ancestor and a property name", () => {
  const keys = declarationKeys({
    "a.ts": "export function scan(a: { items: string[] }, b: { items: number[] }) { return [a, b] }",
  });

  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 2, `keys must be unique, got ${JSON.stringify(keys)}`);
});

test("collectDeclarations skips files the first-party predicate rejects", () => {
  const keys = declarationKeys(
    { "a.ts": "export interface A { x: string }", "b.ts": "export interface B { y: string }" },
    (path) => path.endsWith("a.ts"),
  );

  assert.deepEqual(keys, ["writeOnly|a.ts|A.x"]);
});

test("collectDeclarations ignores methods and index signatures, which are not properties", () => {
  const keys = declarationKeys({
    "a.ts": "export interface A { run(): void; [k: string]: unknown; kept: string }",
  });

  assert.deepEqual(keys, ["writeOnly|a.ts|A.kept"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/__tests__/iface-props-gate.test.mjs`
Expected: FAIL — `Cannot find module '../lib/iface-props-lib.mjs'`

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/iface-props-lib.mjs`:

```js
/**
 * Never-read interface properties: find `PropertySignature`s that are written
 * at least one site and read at none.
 *
 * See docs/dev/dead-code-lint.md and
 * docs/superpowers/specs/2026-09-15-never-read-interface-properties-design.md.
 */
import { relative } from 'node:path';
import ts from 'typescript';

export const DECLARATION_GLOBS = Object.freeze([
  'src/**/*.ts',
  'scripts/**/*.ts',
  'packages/contracts/src/**/*.ts',
  // packages/db has no package.json, so pnpm does not treat it as a workspace
  // and it has no src/ segment. knip.jsonc reaches it the same way.
  'packages/db/**/*.ts',
  'packages/gsd-agent-core/src/**/*.ts',
  'packages/gsd-agent-modes/src/**/*.ts',
  'packages/mcp-server/src/**/*.ts',
  'packages/native/src/**/*.ts',
  'packages/rpc-client/src/**/*.ts',
]);

// The vendored packages are in the program so that reads from them count
// against first-party declarations, but they never yield findings of their own:
// the pi boundary owns that tree and deleting code there fights upstream syncs.
export const PROGRAM_GLOBS = Object.freeze([...DECLARATION_GLOBS, 'packages/pi-*/src/**/*.ts']);

export const BASELINE_HEADER =
  'Accepted never-read interface properties as of the gate rollout. Never add to ' +
  'this list by hand: delete the property, or regenerate with ' +
  '`pnpm run lint:dead-code:props:update` when a finding moves for a legitimate ' +
  'reason. See docs/dev/dead-code-lint.md.';

export function createProgram(filePaths) {
  return ts.createProgram(filePaths, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  });
}

const NAMED_ANCESTORS = [
  ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration,
  ts.isClassDeclaration,
  ts.isFunctionDeclaration,
  ts.isMethodDeclaration,
  ts.isMethodSignature,
  ts.isPropertyDeclaration,
  ts.isVariableDeclaration,
  ts.isParameter,
];

export function ownerLabel(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (NAMED_ANCESTORS.some((is) => is(current)) && current.name && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
  }
  return '<module>';
}

export function collectDeclarations(program, checker, isFirstParty, root) {
  const declarations = new Map();
  const used = new Set();

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !isFirstParty(sourceFile.fileName)) continue;
    const file = relative(root, sourceFile.fileName).split('\\').join('/');

    const visit = (node) => {
      if (ts.isPropertySignature(node) && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol && !declarations.has(symbol)) {
          const name = node.name.text;
          const owner = ownerLabel(node);
          // Two anonymous literals can share an ancestor and a property name.
          // Suffixing keeps the key unique without reintroducing line numbers,
          // which would make moving code within a file read as a new finding.
          let key = `writeOnly|${file}|${owner}.${name}`;
          for (let index = 2; used.has(key); index += 1) {
            key = `writeOnly|${file}|${owner}.${name}#${index}`;
          }
          used.add(key);
          declarations.set(symbol, { name, file, owner, key });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return declarations;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/__tests__/iface-props-gate.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/iface-props-lib.mjs scripts/__tests__/iface-props-gate.test.mjs
git commit -m "feat(scripts): collect interface property declarations with stable owner labels"
```

---

### Task 3: Reference classification

The heart of the pass. Every reference form in the spec's table, resolved in one walk.

**Files:**
- Modify: `scripts/lib/iface-props-lib.mjs`
- Modify: `scripts/__tests__/iface-props-gate.test.mjs`

**Interfaces:**
- Consumes: `createProgram`, `collectDeclarations` from Task 2.
- Produces:
  - `classifyReferences(program, checker) -> { readNames: Set<string>, writeSymbols: Set<ts.Symbol> }`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/__tests__/iface-props-gate.test.mjs`, and add `classifyReferences` to the import from `../lib/iface-props-lib.mjs`:

```js
// Classify one fixture and report, per declared property name, whether the
// property was read anywhere and whether this declaration was written.
function classify(files) {
  return withFixture(files, ({ program, checker }) => {
    const declarations = collectDeclarations(program, checker, () => true);
    const { readNames, writeSymbols } = classifyReferences(program, checker);
    const result = {};
    for (const [symbol, info] of declarations) {
      result[`${info.owner}.${info.name}`] = {
        read: readNames.has(info.name),
        written: writeSymbols.has(symbol),
      };
    }
    return result;
  });
}

test("classifyReferences treats a property access as a read", () => {
  const seen = classify({
    "a.ts": `export interface A { x: string }
export function f(a: A) { return a.x }`,
  });

  assert.deepEqual(seen["A.x"], { read: true, written: false });
});

test("classifyReferences treats assignment to a property access as a write", () => {
  const seen = classify({
    "a.ts": `export interface A { x: string }
export function f(a: A) { a.x = "v" }`,
  });

  assert.deepEqual(seen["A.x"], { read: false, written: true });
});

// `+=` and `++` load the old value before storing, so they are reads too.
test("classifyReferences treats compound assignment as a read", () => {
  const seen = classify({
    "a.ts": `export interface A { n: number }
export function f(a: A) { a.n += 1 }`,
  });

  assert.equal(seen["A.n"].read, true);
});

test("classifyReferences treats an increment as a read", () => {
  const seen = classify({
    "a.ts": `export interface A { n: number }
export function f(a: A) { a.n++ }`,
  });

  assert.equal(seen["A.n"].read, true);
});

// getSymbolAtLocation on an object-literal key returns the literal's own
// symbol, not the interface property it satisfies. Without the contextual-type
// bridge this write is invisible and the property reads as untouched.
test("classifyReferences bridges an object-literal key to the interface it satisfies", () => {
  const seen = classify({
    "a.ts": `export interface A { x: string }
export function make(): A { return { x: "v" } }`,
  });

  assert.deepEqual(seen["A.x"], { read: false, written: true });
});

test("classifyReferences bridges a shorthand object-literal key", () => {
  const seen = classify({
    "a.ts": `export interface A { x: string }
export function make(x: string): A { return { x } }`,
  });

  assert.equal(seen["A.x"].written, true);
});

test("classifyReferences treats destructuring as a read", () => {
  const seen = classify({
    "a.ts": `export interface A { x: string }
export function f(a: A) { const { x } = a; return x }`,
  });

  assert.equal(seen["A.x"].read, true);
});

test("classifyReferences treats string-literal element access as a read", () => {
  const seen = classify({
    "a.ts": `export interface A { x: string }
export function f(a: A) { return a["x"] }`,
  });

  assert.equal(seen["A.x"].read, true);
});

// A spread propagates every property onward invisibly. Under-reporting there
// is far cheaper than a false positive.
test("classifyReferences treats every property of a spread type as read", () => {
  const seen = classify({
    "a.ts": `export interface A { x: string; y: string }
export function copy(a: A) { return { ...a } }`,
  });

  assert.equal(seen["A.x"].read, true);
  assert.equal(seen["A.y"].read, true);
});

test("classifyReferences links a key satisfying a union to both constituents", () => {
  const seen = classify({
    "a.ts": `export interface A { tag: string; a: number }
export interface B { tag: string; b: number }
export function make(): A | B { return { tag: "t", a: 1 } }`,
  });

  assert.equal(seen["A.tag"].written, true);
  assert.equal(seen["B.tag"].written, true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/__tests__/iface-props-gate.test.mjs`
Expected: FAIL — `classifyReferences is not a function` (the Task 2 tests still pass).

- [ ] **Step 3: Write the implementation**

Append to `scripts/lib/iface-props-lib.mjs`:

```js
// `=` stores without loading. Every other assignment operator, and ++/--, reads
// the old value first.
function isPlainAssignmentTarget(node) {
  return (
    ts.isBinaryExpression(node.parent) &&
    node.parent.left === node &&
    node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

function rootsOf(checker, symbol) {
  return symbol ? [symbol, ...(checker.getRootSymbols(symbol) ?? [])] : [];
}

// Resolve a property name against a type, descending into unions and
// intersections so a key satisfying `A | B` links to the declaration in both.
function propertiesOfType(checker, type, name) {
  if (!type) return [];
  const found = [];
  const direct = checker.getPropertyOfType(type, name);
  if (direct) found.push(direct);
  if (type.isUnionOrIntersection?.()) {
    for (const constituent of type.types) {
      const property = checker.getPropertyOfType(constituent, name);
      if (property) found.push(property);
    }
  }
  return found.flatMap((symbol) => rootsOf(checker, symbol));
}

export function classifyReferences(program, checker) {
  const readNames = new Set();
  const writeSymbols = new Set();

  const markRead = (symbols) => {
    for (const symbol of symbols) readNames.add(symbol.getName());
  };
  const markWritten = (symbols) => {
    for (const symbol of symbols) writeSymbols.add(symbol);
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const symbols = rootsOf(checker, checker.getSymbolAtLocation(node.name));
        if (isPlainAssignmentTarget(node)) markWritten(symbols);
        else markRead(symbols);
      } else if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        const type = checker.getTypeAtLocation(node.expression);
        markRead(propertiesOfType(checker, type, node.argumentExpression.text));
      } else if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        ts.isObjectLiteralExpression(node.parent)
      ) {
        const contextual = checker.getContextualType(node.parent);
        markWritten(propertiesOfType(checker, contextual, node.name.text));
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const type = checker.getTypeAtLocation(node.parent);
        markRead(propertiesOfType(checker, type, (node.propertyName ?? node.name).getText()));
      } else if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) {
        const type = checker.getTypeAtLocation(node.expression);
        if (type) markRead(checker.getPropertiesOfType(type) ?? []);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return { readNames, writeSymbols };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/__tests__/iface-props-gate.test.mjs`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/iface-props-lib.mjs scripts/__tests__/iface-props-gate.test.mjs
git commit -m "feat(scripts): classify interface property reads and writes in one AST walk"
```

---

### Task 4: The write-only join, the #79 regression, and the false-positive suite

The correctness heart. Task 3 proved each reference form is classified; this task proves the composed pass reports the shape the issue exists for and stays quiet on the five categories that would otherwise sink it.

**Files:**
- Modify: `scripts/lib/iface-props-lib.mjs`
- Modify: `scripts/__tests__/iface-props-gate.test.mjs`

**Interfaces:**
- Consumes: `createProgram`, `collectDeclarations`, `classifyReferences`.
- Produces:
  - `findWriteOnly(declarations, references) -> string[]` — sorted finding keys
  - `analyse(filePaths, isFirstParty, root) -> string[]` — composes createProgram → collect → classify → join. `root` is the path finding keys are relative to, as in Task 2.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/__tests__/iface-props-gate.test.mjs`, adding `analyse` to the lib import:

```js
function findings(files, isFirstParty = () => true) {
  const dir = mkdtempSync(join(tmpdir(), "gsd-iface-props-"));
  try {
    const paths = Object.entries(files).map(([name, source]) => {
      const path = join(dir, name);
      writeFileSync(path, source, "utf-8");
      return path;
    });
    return analyse(paths, isFirstParty, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The regression this gate exists for: #79, RefMetadata.frameContext, a
// property written at one site and read at none. Fixed in ba897845; this
// fixture reconstructs it.
test("analyse reports the never-read property from #79", () => {
  const keys = findings({
    "state.ts": `export interface RefMetadata { url: string; frameContext?: string }`,
    "refs.ts": `import type { RefMetadata } from "./state.js";
export function snapshot(url: string, frame: string): RefMetadata {
  return { url, frameContext: frame };
}`,
    "use.ts": `import type { RefMetadata } from "./state.js";
export function describe(m: RefMetadata) { return m.url }`,
  });

  assert.deepEqual(keys, ["writeOnly|state.ts|RefMetadata.frameContext"]);
});

test("analyse stays silent once the property is read", () => {
  const keys = findings({
    "state.ts": `export interface RefMetadata { url: string; frameContext?: string }`,
    "refs.ts": `import type { RefMetadata } from "./state.js";
export function snapshot(url: string, frame: string): RefMetadata {
  return { url, frameContext: frame };
}`,
    "use.ts": `import type { RefMetadata } from "./state.js";
export function stale(m: RefMetadata, now: string) { return m.frameContext !== now }`,
  });

  assert.deepEqual(keys, []);
});

test("analyse reports nothing for a property that is never written either", () => {
  const keys = findings({ "a.ts": `export interface A { unused: string }` });

  assert.deepEqual(keys, []);
});

test("analyse never reports a declaration the first-party predicate rejects", () => {
  const keys = findings(
    {
      "vendored.ts": `export interface V { dead: string }`,
      "use.ts": `import type { V } from "./vendored.js";
export function make(): V { return { dead: "x" } }`,
    },
    (path) => !path.endsWith("vendored.ts"),
  );

  assert.deepEqual(keys, []);
});

// --- false-positive categories: each must produce no finding ---

test("analyse does not report a discriminant narrowed but never read as a property", () => {
  const keys = findings({
    "a.ts": `export interface A { kind: "a"; value: string }
export function make(): A { return { kind: "a", value: "v" } }
export function read(a: A) { if (a.kind === "a") return a.value; return "" }`,
  });

  assert.deepEqual(keys, []);
});

test("analyse does not report a property reached only through a spread", () => {
  const keys = findings({
    "a.ts": `export interface A { x: string }
export function make(): A { return { x: "v" } }
export function copy(a: A) { return { ...a } }`,
  });

  assert.deepEqual(keys, []);
});

test("analyse does not report a property read only by destructuring", () => {
  const keys = findings({
    "a.ts": `export interface A { x: string }
export function make(): A { return { x: "v" } }
export function read(a: A) { const { x } = a; return x }`,
  });

  assert.deepEqual(keys, []);
});

test("analyse does not report a property read only by string-literal element access", () => {
  const keys = findings({
    "a.ts": `export interface A { x: string }
export function make(): A { return { x: "v" } }
export function read(a: A) { return a["x"] }`,
  });

  assert.deepEqual(keys, []);
});

// Structural typing: the read goes through a compatible but nominally separate
// interface, exactly as WorktreeStatus is read via WorktreeStatusLike. A
// symbol-identity join reports this; keying reads by name is what prevents it.
test("analyse does not report a property read through a structurally-compatible alias", () => {
  const keys = findings({
    "a.ts": `export interface Status { name: string }
export function make(): Status { return { name: "n" } }`,
    "b.ts": `export interface StatusLike { name: string }
export function render(s: StatusLike) { return s.name }`,
  });

  assert.deepEqual(keys, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/__tests__/iface-props-gate.test.mjs`
Expected: FAIL — `analyse is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `scripts/lib/iface-props-lib.mjs`:

```js
/**
 * A property is dead when it is written somewhere and no property of that name
 * is read anywhere in the program.
 *
 * Reads are matched by name rather than by symbol because TypeScript is
 * structurally typed: a read through a compatible-but-separate interface never
 * links back to this declaration. Keying on the symbol turns ~190 findings into
 * ~1800, nearly all of them reads the join simply could not see. The cost is
 * recall — a same-named property on an unrelated type that *is* read masks a
 * genuine finding — which is the right trade for a gate wired into CI.
 */
export function findWriteOnly(declarations, references) {
  const keys = [];
  for (const [symbol, info] of declarations) {
    if (references.readNames.has(info.name)) continue;
    if (!references.writeSymbols.has(symbol)) continue;
    keys.push(info.key);
  }
  return keys.sort();
}

export function analyse(filePaths, isFirstParty, root) {
  const program = createProgram(filePaths);
  const checker = program.getTypeChecker();
  const declarations = collectDeclarations(program, checker, isFirstParty, root);
  return findWriteOnly(declarations, classifyReferences(program, checker));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/__tests__/iface-props-gate.test.mjs`
Expected: PASS, 25 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/iface-props-lib.mjs scripts/__tests__/iface-props-gate.test.mjs
git commit -m "feat(scripts): report write-only interface properties, with the #79 regression covered"
```

---

### Task 5: The gate CLI, the npm scripts, and the baseline

**Files:**
- Create: `scripts/iface-props-gate.mjs`
- Create: `.config/iface-props-baseline.json` (generated, not hand-written)
- Modify: `package.json`

**Interfaces:**
- Consumes: `analyse`, `DECLARATION_GLOBS`, `PROGRAM_GLOBS`, `BASELINE_HEADER` from the lib; `parseBaseline`, `diffAgainstBaseline`, `renderBaselineFile`, `exitCodeForDiff` from `baseline-ratchet.mjs`.
- Produces: `pnpm run lint:dead-code:props` and `pnpm run lint:dead-code:props:update`.

- [ ] **Step 1: Write the gate CLI**

Create `scripts/iface-props-gate.mjs`:

```js
#!/usr/bin/env node
/**
 * Never-read interface properties: report first-party `PropertySignature`s that
 * are written somewhere and read nowhere, failing only on findings absent from
 * .config/iface-props-baseline.json. Pass --write to regenerate that baseline.
 *
 * Complements scripts/knip-gate.mjs, whose member analysis covers classes and
 * enums only. See docs/dev/dead-code-lint.md.
 */
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  diffAgainstBaseline,
  exitCodeForDiff,
  parseBaseline,
  renderBaselineFile,
} from './lib/baseline-ratchet.mjs';
import { analyse, BASELINE_HEADER, DECLARATION_GLOBS, PROGRAM_GLOBS } from './lib/iface-props-lib.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, '.config', 'iface-props-baseline.json');

function parseArgs(argv) {
  const unknown = argv.filter((arg) => arg !== '--write');
  if (unknown.length > 0) {
    throw new Error(`unknown argument(s): ${unknown.join(' ')}. The only flag is --write.`);
  }
  return { write: argv.includes('--write') };
}

// The analysed set is a function of these globs alone, never of local gitignore
// or build state, so the baseline is identical on every machine and in CI.
function resolveGlobs(globs) {
  const paths = new Set();
  for (const pattern of globs) {
    for (const match of globSync(pattern, { cwd: ROOT, nodir: true })) {
      if (!match.endsWith('.d.ts')) paths.add(join(ROOT, match));
    }
  }
  return [...paths].sort();
}

function readBaseline() {
  let text;
  try {
    text = readFileSync(BASELINE_PATH, 'utf8');
  } catch (error) {
    throw new Error(
      `cannot read the interface-property baseline at ${BASELINE_PATH} (${error.code}). ` +
        'Regenerate it with `pnpm run lint:dead-code:props:update`.',
    );
  }
  return parseBaseline(text, 'interface-property baseline');
}

function run() {
  const declarationPaths = new Set(resolveGlobs(DECLARATION_GLOBS));
  return analyse(resolveGlobs(PROGRAM_GLOBS), (path) => declarationPaths.has(path), ROOT);
}

function printKeys(stream, keys, prefix) {
  for (const key of keys) {
    const [, file, symbol] = key.split('|');
    stream.write(`  ${prefix}${file} — ${symbol}\n`);
  }
}

function main() {
  const { write } = parseArgs(process.argv.slice(2));
  const baseline = write ? null : readBaseline();
  const current = run();

  if (write) {
    const previous = (() => {
      try {
        return readBaseline();
      } catch {
        return [];
      }
    })();
    writeFileSync(BASELINE_PATH, renderBaselineFile(BASELINE_HEADER, current));
    process.stdout.write(`interface-property baseline written: ${current.length} accepted finding(s)\n`);
    const diff = diffAgainstBaseline(current, previous);
    printKeys(process.stdout, diff.resolved, 'resolved: ');
    printKeys(process.stdout, diff.added, 'accepted: ');
    return;
  }

  const diff = diffAgainstBaseline(current, baseline);

  if (diff.resolved.length > 0) {
    process.stdout.write(
      `interface properties: ${diff.resolved.length} baselined finding(s) no longer occur — ` +
        'run `pnpm run lint:dead-code:props:update` to tighten the baseline:\n',
    );
    printKeys(process.stdout, diff.resolved, '- ');
  }

  if (diff.added.length === 0) {
    process.stdout.write(
      `interface properties: no new never-read properties (${baseline.length} baselined finding(s)) ✓\n`,
    );
  } else {
    process.stderr.write(`\nERROR: ${diff.added.length} never-read interface propert(ies):\n`);
    printKeys(process.stderr, diff.added, '');
    process.stderr.write(
      '\nEach of these is written somewhere and read nowhere. Either read it or delete it. ' +
        'If a finding moved for a legitimate reason, rerun with ' +
        '`pnpm run lint:dead-code:props:update` and explain the change in the PR.\n',
    );
  }

  // Set the code rather than calling process.exit(): stdout and stderr are async
  // when they are pipes, as under CI, and exiting outright truncates the finding
  // list that makes a failure actionable.
  process.exitCode = exitCodeForDiff(diff);
}

try {
  main();
} catch (error) {
  process.stderr.write(`\nERROR: interface-property gate could not run: ${error.message}\n`);
  process.exitCode = 2;
}
```

- [ ] **Step 2: Add the npm scripts**

In `package.json`, immediately after the two `lint:dead-code` entries:

```json
"lint:dead-code:props": "node scripts/iface-props-gate.mjs",
"lint:dead-code:props:update": "node scripts/iface-props-gate.mjs --write",
```

- [ ] **Step 3: Verify the gate fails cleanly with no baseline yet**

Run: `pnpm run lint:dead-code:props`
Expected: exit code 2, `ERROR: interface-property gate could not run: cannot read the interface-property baseline at ... (ENOENT). Regenerate it with \`pnpm run lint:dead-code:props:update\`.`

This confirms a missing baseline is a hard error rather than a silent pass.

- [ ] **Step 4: Generate the baseline**

Run: `pnpm run lint:dead-code:props:update`
Expected: `interface-property baseline written: N accepted finding(s)` where **N is approximately 192**. Takes roughly 10–15 seconds.

If N is wildly off — under 100 or over 400 — stop and investigate before committing. The likely cause is a glob resolving to nothing (check `resolveGlobs(DECLARATION_GLOBS).length` is in the low thousands) or `packages/pi-*` leaking into the declaration set.

- [ ] **Step 5: Sanity-check the baseline contents**

Run:
```bash
node -e "const b=require('./.config/iface-props-baseline.json');console.log(b.findings.length);console.log(b.findings.filter(k=>k.includes('packages/pi-')).length+' pi-* findings (must be 0)');console.log(b.findings.slice(0,5).join('\n'))"
```
Expected: the count from Step 4, **0 pi-\* findings**, and keys of the form `writeOnly|src/...|Owner.prop`.

- [ ] **Step 6: Verify the gate now passes**

Run: `pnpm run lint:dead-code:props`
Expected: `interface properties: no new never-read properties (N baselined finding(s)) ✓`, exit code 0.

- [ ] **Step 7: Verify the ratchet actually catches a new finding**

Add a throwaway write-only property to a first-party file:
```bash
printf '\nexport interface PlanScratchProbe { written: string }\nexport function planScratchProbe(): PlanScratchProbe { return { written: "x" } }\n' >> src/cli-args.ts
pnpm run lint:dead-code:props; echo "exit=$?"
```
Expected: exit=1 and `ERROR: 1 never-read interface propert(ies):` naming `PlanScratchProbe.written`.

Then revert: `git checkout src/cli-args.ts` and re-run to confirm it is green again.

- [ ] **Step 8: Commit**

```bash
git add scripts/iface-props-gate.mjs .config/iface-props-baseline.json package.json
git commit -m "feat(scripts): gate never-read interface properties on a committed baseline"
```

---

### Task 6: CI wiring and drift tests

A gate nobody runs drifts exactly the way the missing `noUnusedLocals` did. Wire it into the same three runners as knip and assert that wiring in tests.

**Files:**
- Modify: `.github/workflows/ci.yml:22` (after the `lint:dead-code` step)
- Modify: `scripts/ci-fast-gates.sh:70` (after the knip block)
- Modify: `scripts/verify-merge.sh:86` (after the knip block)
- Modify: `scripts/__tests__/iface-props-gate.test.mjs`

**Interfaces:**
- Consumes: the `lint:dead-code:props` script from Task 5.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/__tests__/iface-props-gate.test.mjs`. Add `readFileSync` and `globSync` to the `node:fs` import, and `BASELINE_HEADER`, `DECLARATION_GLOBS`, `renderBaselineFile`, `parseBaseline` to the imports — `renderBaselineFile` and `parseBaseline` come from `../lib/baseline-ratchet.mjs`:

```js
// #81's lesson: a gate that is not wired into every runner drifts silently.
test("the interface-property gate is wired into CI and the local merge-parity scripts", () => {
  const read = (path) => readFileSync(join(repoRoot, path), "utf8");

  assert.match(read(".github/workflows/ci.yml"), /pnpm run lint:dead-code:props/);
  assert.match(read("scripts/ci-fast-gates.sh"), /pnpm run lint:dead-code:props/);
  assert.match(read("scripts/verify-merge.sh"), /pnpm run lint:dead-code:props/);
});

test("the committed baseline parses and is sorted, so regeneration produces no spurious diff", () => {
  const text = readFileSync(join(repoRoot, ".config/iface-props-baseline.json"), "utf8");

  assert.equal(renderBaselineFile(BASELINE_HEADER, parseBaseline(text)), text);
});

test("the baseline holds no findings from the vendored pi-* tree", () => {
  const text = readFileSync(join(repoRoot, ".config/iface-props-baseline.json"), "utf8");
  const leaked = parseBaseline(text).filter((key) => key.includes("packages/pi-"));

  assert.deepEqual(leaked, []);
});

// A glob matching nothing silently exempts the code it was meant to cover.
test("every declaration glob matches at least one file", () => {
  const dead = DECLARATION_GLOBS.filter(
    (pattern) => globSync(pattern, { cwd: repoRoot, nodir: true }).length === 0,
  );

  assert.deepEqual(dead, []);
});
```

- [ ] **Step 2: Run the tests to verify the wiring test fails**

Run: `node --test scripts/__tests__/iface-props-gate.test.mjs`
Expected: the wiring test FAILS (no match in `ci.yml`); the other three PASS.

- [ ] **Step 3: Wire into CI**

In `.github/workflows/ci.yml`, immediately after line 22 (`- run: pnpm run lint:dead-code`):

```yaml
      # Interface-property dead-code gate (#185). knip's member analysis covers
      # classes and enums only; this covers never-read interface properties.
      - run: pnpm run lint:dead-code:props
```

- [ ] **Step 4: Wire into the fast gates**

In `scripts/ci-fast-gates.sh`, after the existing knip block (line 70):

```bash
echo "── dead code (interface properties) ──"
pnpm run lint:dead-code:props
```

- [ ] **Step 5: Wire into verify-merge**

In `scripts/verify-merge.sh`, after the existing knip block (line 86):

```bash
echo "── lint:dead-code:props ──"
pnpm run lint:dead-code:props
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test scripts/__tests__/iface-props-gate.test.mjs`
Expected: PASS, 29 tests.

- [ ] **Step 7: Run the whole script-policy suite**

Run: `node --test "scripts/__tests__/*.mjs" "scripts/__tests__/*.cjs"`
Expected: PASS. This is the command `ci-fast-gates.sh` runs, so it must be green.

- [ ] **Step 8: Verify the workflow file is still valid**

Run: `actionlint -config-file .config/actionlint.yaml` (skip if `actionlint` is not installed locally — CI enforces it).
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add .github/workflows/ci.yml scripts/ci-fast-gates.sh scripts/verify-merge.sh scripts/__tests__/iface-props-gate.test.mjs
git commit -m "ci: run the interface-property gate alongside knip in all three runners"
```

---

### Task 7: Documentation

`docs/dev/dead-code-lint.md` currently states this case is untracked and points at #185. That is now wrong in two ways: the gate exists, and one of the two examples it cites has since been fixed.

**Files:**
- Modify: `docs/dev/dead-code-lint.md`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: nothing.

- [ ] **Step 1: Retitle the document and note both gates**

Change the heading from `# Dead-code lint (knip)` to `# Dead-code lint`, and extend the opening paragraph so it names both passes: knip for files, exports, dependencies, and class and enum members; the interface-property gate for properties written but never read.

- [ ] **Step 2: Add a running section for the new gate**

After the existing "Running it" section:

````markdown
### Interface properties

```bash
pnpm run lint:dead-code:props
```

Takes about fifteen seconds. Runs in the same three places as the knip gate.

This is a custom pass over the TypeScript compiler API
(`scripts/lib/iface-props-lib.mjs`) rather than a third-party tool, because no
tool reports this: knip's member analysis covers classes and enums only, and
`tsc`, `ts-prune`, `biome` and `@typescript-eslint` have no interface-member rule
at all.
````

- [ ] **Step 3: Replace the "Never-read interface or type-literal properties" subsection**

That subsection under "What knip does *not* catch" currently says the case needs a custom pass and is tracked in #185. Replace the whole bolded paragraph and its bullet list with:

````markdown
**Never-read interface or type-literal properties.** knip's member analysis covers
classes and enums only. A second gate covers this case — see "Interface properties"
above — because both findings that motivated knip were interface properties:

- `RefMetadata.frameContext` (`src/resources/extensions/browser-tools/state.ts`),
  #79, fixed in ba897845 (#129).
- `FuzzyMatchResult.contentForReplacement`, fixed in c680e785 (#38) after it shipped
  a real bug.

Note that `contentForReplacement` lived in
`packages/pi-coding-agent/src/core/tools/edit-diff.ts`. The vendored tree is out of
scope for both gates, so neither would have caught it where it actually was.
````

- [ ] **Step 4: Document the name-keying trade-off honestly**

Add, under the new gate's section:

````markdown
### What the interface-property gate trades away

Reads are matched by property **name**, not by symbol. TypeScript is structurally
typed, so a read through a compatible-but-separate interface never links back to
the declaration: `WorktreeStatus.name` (`src/worktree-cli-status.ts`) is read only
via `WorktreeStatusLike` (`src/worktree-cli-format.ts`), and a symbol-identity join
calls it dead. Keying on the symbol turns roughly 190 findings into roughly 1,800,
almost all of them reads the join could not see.

The cost is recall. A same-named property on an unrelated type that *is* read masks
a genuine finding: `UnitMetrics.cacheHitRate`
(`src/resources/extensions/gsd/metrics.ts`) is written twice and read nowhere, but
`CompletionDashboardSnapshot.cacheHitRate` is read, so the gate stays quiet. That is
the intended bias — for something wired into three CI runners, silence is a cheaper
failure than noise.

The gate also reports only properties that are **written somewhere**. A property
declared and never touched at all is not reported here; knip's `types` and `exports`
rules approach that case from the other side.
````

- [ ] **Step 4a: Update the baseline-ratchet section to cover both files**

The "The baseline ratchet" section describes `.config/knip-baseline.json` only. Note that both gates share the same mechanism via `scripts/lib/baseline-ratchet.mjs`, and that the interface-property gate's baseline is `.config/iface-props-baseline.json`, regenerated with `pnpm run lint:dead-code:props:update`.

- [ ] **Step 5: Add known baseline contents worth burning down**

Mirroring the existing knip section of the same name, append (substituting the real counts from Task 5 Step 4 for `N` and the test-file figure):

````markdown
### Interface-property baseline contents worth burning down

- **N accepted findings at rollout.** Each is a property written at one or more
  sites and read at none, so each is either a missing read or a deletion.
- **Six are in `.test.ts` files.** A write-only property in a test usually means an
  assertion was weakened or removed and the fixture field outlived it.
- **`RefMetadata.selectorScope`** (`src/resources/extensions/browser-tools/state.ts`)
  is the same shape as #79 on the same interface: written at
  `tools/refs.ts`, read nowhere, and `validateRefFreshness` never consults the
  snapshot's selector scope. Tracked as #205.
````

- [ ] **Step 6: Check the docs scanner passes**

Run: `bash scripts/docs-prompt-injection-scan.sh --file docs/dev/dead-code-lint.md`
Expected: no findings.

- [ ] **Step 7: Verify the full fast-gate suite**

Run: `pnpm run verify:fast`
Expected: PASS, including both dead-code gates.

- [ ] **Step 8: Commit**

```bash
git add docs/dev/dead-code-lint.md
git commit -m "docs: cover the interface-property gate in the dead-code lint guide"
```

---

## Verification

Before opening the PR:

- [ ] `node --test "scripts/__tests__/*.mjs" "scripts/__tests__/*.cjs"` — PASS
- [ ] `pnpm run lint:dead-code` — green, baseline count unchanged from before Task 1
- [ ] `pnpm run lint:dead-code:props` — green
- [ ] `pnpm run verify:fast` — PASS
- [ ] `git diff main --stat` shows no changes to `.config/knip-baseline.json` (Task 1 is a pure refactor; if that file moved, something is wrong)

The PR closes #185 and references #205.
