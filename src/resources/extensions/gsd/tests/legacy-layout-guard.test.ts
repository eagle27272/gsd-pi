// Project/App: gsd-pi
// File Purpose: Tests detection of the pre-flat-phase milestones/<MID>/ layout.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertNoLegacyLayout, detectLegacyLayout } from "../legacy-layout-guard.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "gsd-legacy-guard-"));
}

test("detects a content-bearing milestones/<MID>/ layout", () => {
  const root = makeRoot();
  const milestone = join(root, ".gsd", "milestones", "M001");
  mkdirSync(milestone, { recursive: true });
  writeFileSync(join(milestone, "ROADMAP.md"), "# roadmap\n");

  const finding = detectLegacyLayout(root);

  assert.equal(finding?.kind, "milestones-layout");
});

test("ignores an empty milestones/ directory", () => {
  const root = makeRoot();
  mkdirSync(join(root, ".gsd", "milestones"), { recursive: true });
  mkdirSync(join(root, ".gsd", "phases"), { recursive: true });

  assert.equal(detectLegacyLayout(root), null);
});

test("ignores a milestones/<MID>/ holding only META json", () => {
  const root = makeRoot();
  const milestone = join(root, ".gsd", "milestones", "M001");
  mkdirSync(milestone, { recursive: true });
  writeFileSync(join(milestone, "M001-META.json"), "{}\n");

  assert.equal(detectLegacyLayout(root), null);
});

test("accepts a real in-repo .gsd holding flat-phase state", () => {
  const root = makeRoot();
  mkdirSync(join(root, ".gsd", "phases"), { recursive: true });
  writeFileSync(join(root, ".gsd", "gsd.db"), "");

  assert.equal(detectLegacyLayout(root), null);
});

test("detects a content-bearing milestones/<MID>/ behind a .gsd symlink", () => {
  const root = makeRoot();
  const external = makeRoot();
  const milestone = join(external, "milestones", "M001");
  mkdirSync(milestone, { recursive: true });
  writeFileSync(join(milestone, "ROADMAP.md"), "# roadmap\n");
  symlinkSync(external, join(root, ".gsd"));

  const finding = detectLegacyLayout(root);

  assert.equal(finding?.kind, "milestones-layout");
});

test("accepts a .gsd symlink pointing at external state", () => {
  const root = makeRoot();
  const external = makeRoot();
  mkdirSync(join(external, "phases"), { recursive: true });
  symlinkSync(external, join(root, ".gsd"));

  assert.equal(detectLegacyLayout(root), null);
});

test("assertNoLegacyLayout names the last version that could migrate", () => {
  const root = makeRoot();
  const milestone = join(root, ".gsd", "milestones", "M001");
  mkdirSync(milestone, { recursive: true });
  writeFileSync(join(milestone, "ROADMAP.md"), "# roadmap\n");

  assert.throws(() => assertNoLegacyLayout(root), /v1\.18\.0/);
});

test("assertNoLegacyLayout is a no-op on a clean project", () => {
  const root = makeRoot();
  const external = makeRoot();
  mkdirSync(join(external, "phases"), { recursive: true });
  symlinkSync(external, join(root, ".gsd"));

  assert.doesNotThrow(() => assertNoLegacyLayout(root));
});
