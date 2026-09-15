// Project/App: gsd-pi
// File Purpose: Coverage for the never-read interface-property dead-code gate.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { analyse, classifyReferences, collectDeclarations, createProgram } from "../lib/iface-props-lib.mjs";

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

test("collectDeclarations includes the intervening property in the owner path for one level of nesting", () => {
  const keys = declarationKeys({
    "a.ts": "export interface R { cost: { total: number } }",
  });

  // `cost` is itself a PropertySignature (object-literal-typed) and gets its
  // own entry alongside the nested `total`, which is the case this test is for.
  assert.deepEqual(keys, ["writeOnly|a.ts|R.cost", "writeOnly|a.ts|R.cost.total"]);
});

test("collectDeclarations keeps accumulating the owner path across multiple levels of nesting", () => {
  const keys = declarationKeys({
    "a.ts": "export interface R { a: { b: { c: string } } }",
  });

  assert.deepEqual(keys, ["writeOnly|a.ts|R.a", "writeOnly|a.ts|R.a.b", "writeOnly|a.ts|R.a.b.c"]);
});

test("collectDeclarations disambiguates two literals sharing an ancestor and a property name", () => {
  const keys = declarationKeys({
    "a.ts": "export function scan(a: { items: string[] }, b: { items: number[] }) { return [a, b] }",
  });

  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 2, `keys must be unique, got ${JSON.stringify(keys)}`);
});

// Unlike the parameter-literals case above, both literals here share the
// same nearest named ancestor (`scan`) and the same property name (`items`),
// so the raw key collides and the #2 suffix branch must fire.
test("collectDeclarations suffixes a genuine key collision between two literals under one ancestor", () => {
  const keys = declarationKeys({
    "a.ts": "export function scan(): { items: string[] } | { items: number[] } { return { items: [] } }",
  });

  assert.deepEqual(keys, ["writeOnly|a.ts|scan.items", "writeOnly|a.ts|scan.items#2"]);
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

// Classify one fixture and report, per declared property name, whether the
// property was read anywhere and whether this declaration was written.
function classify(files) {
  return withFixture(files, ({ program, checker, dir }) => {
    const declarations = collectDeclarations(program, checker, () => true, dir);
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

// `...rest` carries every unnamed property onward invisibly, same as a
// spread in an object literal. Looking up a property literally named `rest`
// would find nothing and miss this read.
test("classifyReferences treats an object-rest binding element as reading every property of its type", () => {
  const seen = classify({
    "a.ts": `export interface A { x: string; y: string }
export function f(a: A) { const { x, ...rest } = a; return [x, rest] }`,
  });

  assert.equal(seen["A.x"].read, true);
  assert.equal(seen["A.y"].read, true);
});

// Over-marking is the intended behaviour: even if `rest` is never used
// afterward, its properties are conservatively read rather than risking the
// false positive of reporting a genuinely-consumed property as never-read.
test("classifyReferences marks object-rest properties read even when the rest binding is never used", () => {
  const seen = classify({
    "a.ts": `export interface A { x: string; y: string }
export function f(a: A) { const { x, ...rest } = a; return x }`,
  });

  assert.equal(seen["A.y"].read, true);
});

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
export function stale(m: RefMetadata, now: string) { return m.url !== "" && m.frameContext !== now }`,
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
