// Project/App: gsd-pi
// File Purpose: Proves no production module imports the test-only markdown importer.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("no production module imports the legacy markdown importer (md-importer is test-only)", () => {
  // md-importer's migrateFromMarkdown/migrateHierarchyToDb are an unconsented,
  // unverified markdown→DB write path kept alive for test scaffolding only.
  // Every production markdown→DB import must go through the crash-safe Import
  // Application (workflow_import_applications). This guard fails if any
  // non-test module starts importing md-importer directly.
  const gsdSourceDir = join(import.meta.dirname, "..");
  const MD_IMPORTER_RE =
    /from\s+["'][^"']*md-importer(?:\.js|\.ts)?["']|import\(\s*["'][^"']*md-importer(?:\.js|\.ts)?["']\s*\)|require\(\s*["'][^"']*md-importer(?:\.js|\.ts)?["']\s*\)/;

  const productionFiles: string[] = [];
  const stack = [gsdSourceDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "tests" && entry.name !== "node_modules") stack.push(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
        productionFiles.push(full);
      }
    }
  }
  assert.ok(productionFiles.length > 0, "should find GSD production source files");

  const offenders = productionFiles
    .filter((file) => MD_IMPORTER_RE.test(readFileSync(file, "utf-8")))
    .map((file) => file.slice(gsdSourceDir.length + 1));
  assert.deepEqual(
    offenders,
    [],
    `Production modules must not import the test-only legacy markdown importer ` +
      `(md-importer); route markdown→DB imports through the Import Application ` +
      `instead. Offenders:\n  ${offenders.join("\n  ")}`,
  );
});
