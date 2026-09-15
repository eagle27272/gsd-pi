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
