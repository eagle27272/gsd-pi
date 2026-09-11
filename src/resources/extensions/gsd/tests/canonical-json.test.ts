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
