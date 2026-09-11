import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the native addon directly
const addonDir = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "native",
  "addon",
);
const platformTag = `${process.platform}-${process.arch}`;
const candidates = [
  path.join(addonDir, `gsd_engine.${platformTag}.node`),
  path.join(addonDir, "gsd_engine.dev.node"),
];

let native;
for (const candidate of candidates) {
  try {
    native = require(candidate);
    break;
  } catch {
    // try next
  }
}

if (!native) {
  console.error(
    "Native addon not found. Run `npm run build:native -w @gsd/native` first.",
  );
  process.exit(1);
}

// ── fuzzy matching is intentionally absent ──────────────────
// A native fuzzy matcher cannot just return a normalized copy of the content:
// applying the match requires source ranges back into the original text. See
// issue #4 and buildFuzzySourceMap in
// packages/pi-coding-agent/src/core/tools/edit-diff.ts.

describe("fuzzy matching", () => {
  test("is not exported by the addon", () => {
    assert.equal(native.normalizeForFuzzyMatch, undefined);
    assert.equal(native.fuzzyFindText, undefined);
  });
});

// ── generateDiff ────────────────────────────────────────────────────────

describe("generateDiff", () => {
  test("generates diff for a line change", () => {
    const old = "line1\nline2\nline3";
    const newText = "line1\nmodified\nline3";
    const result = native.generateDiff(old, newText);
    assert.ok(result.diff.includes("line2"));
    assert.ok(result.diff.includes("modified"));
    assert.ok(result.diff.includes("-"));
    assert.ok(result.diff.includes("+"));
    assert.notEqual(result.firstChangedLine, null);
  });

  test("generates diff for an addition", () => {
    const old = "line1\nline3";
    const newText = "line1\nline2\nline3";
    const result = native.generateDiff(old, newText);
    assert.ok(result.diff.includes("+"));
    assert.ok(result.diff.includes("line2"));
  });

  test("generates diff for a deletion", () => {
    const old = "line1\nline2\nline3";
    const newText = "line1\nline3";
    const result = native.generateDiff(old, newText);
    assert.ok(result.diff.includes("-"));
    assert.ok(result.diff.includes("line2"));
  });

  test("returns empty diff for identical content", () => {
    const result = native.generateDiff("same", "same");
    assert.equal(result.diff, "");
    // napi-rs maps Option::None to undefined (not null)
    assert.equal(result.firstChangedLine, undefined);
  });

  test("respects context lines parameter", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const old = lines.join("\n");
    lines[10] = "modified";
    const newText = lines.join("\n");
    const result = native.generateDiff(old, newText, 2);
    assert.ok(result.diff.includes("..."));
  });

  test("default context is 4 lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const old = lines.join("\n");
    lines[10] = "modified";
    const newText = lines.join("\n");
    const result = native.generateDiff(old, newText);
    // Should show 4 context lines before and after
    assert.ok(result.diff.length > 0);
  });
});
