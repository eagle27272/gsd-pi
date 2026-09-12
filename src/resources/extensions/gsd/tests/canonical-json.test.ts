// Project/App: gsd-pi
// File Purpose: Tests the deterministic canonical-JSON and hashing primitives.

import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, hashBytes, hashValue } from "../canonical-json.js";

test("canonicalJson orders object keys deterministically", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("canonicalJson preserves array order", () => {
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
});

test("canonicalJson handles nested structures and null", () => {
  assert.equal(canonicalJson({ z: [{ y: null, x: 1 }] }), '{"z":[{"x":1,"y":null}]}');
});

test("hashBytes returns a sha256-prefixed digest", () => {
  const digest = hashBytes("abc");
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    digest,
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("hashValue is stable across key orderings", () => {
  assert.equal(hashValue({ a: 1, b: 2 }), hashValue({ b: 2, a: 1 }));
});

test("canonicalJson throws on an object cycle", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.throws(() => canonicalJson(cyclic), {
    message: "canonical JSON requires acyclic strict JSON",
  });
});

test("canonicalJson throws on an array cycle", () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  assert.throws(() => canonicalJson(cyclic), {
    message: "canonical JSON requires acyclic strict JSON",
  });
});

test("canonicalJson escapes control characters and passes through unicode", () => {
  const value = "😀\t\n\"\\";
  assert.equal(canonicalJson(value), "\"😀\\t\\n\\\"\\\\\"");
});

test("canonicalJson rejects non-finite numbers", () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => canonicalJson(value), {
      message: "canonical JSON requires strict JSON with finite numbers",
    });
  }
});

test("canonicalJson rejects sparse arrays", () => {
  const sparse = [1, 2, 3];
  delete sparse[1];
  assert.throws(() => canonicalJson(sparse), {
    message: "canonical JSON requires dense JSON arrays without extra keys",
  });
});

test("canonicalJson rejects symbol keys on objects", () => {
  const withSymbol: Record<string | symbol, unknown> = {};
  withSymbol[Symbol("x")] = 1;
  assert.throws(() => canonicalJson(withSymbol), {
    message: "canonical JSON requires strict JSON without symbol keys",
  });
});

test("canonicalJson rejects non-plain prototypes", () => {
  assert.throws(() => canonicalJson(new Date()), {
    message: "canonical JSON requires plain JSON objects",
  });
});

test("canonicalJson accepts null-prototype objects", () => {
  const nullProto = Object.create(null) as Record<string, unknown>;
  nullProto["a"] = 1;
  assert.equal(canonicalJson(nullProto), '{"a":1}');
});

test("canonicalJson rejects non-object, non-array values", () => {
  assert.throws(() => canonicalJson(undefined), {
    message: "canonical JSON requires strict JSON values",
  });
});

test("canonicalJson normalizes negative zero to 0", () => {
  assert.equal(canonicalJson(-0), "0");
});

test("canonicalJson emits scientific notation for 1e21", () => {
  assert.equal(canonicalJson(1e21), "1e+21");
});

test("hashValue produces a pinned digest for strings with unicode and escapes", () => {
  assert.equal(
    hashValue("😀\t\n\"\\"),
    "sha256:f1f7d5637adebfd110c697ca0fcb3ecf88b629819297fb4eb2f67fefbda08d4e",
  );
});
