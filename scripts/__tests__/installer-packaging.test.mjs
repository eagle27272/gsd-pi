// Project/App: gsd-pi
// File Purpose: Regression tests for installer package dependencies.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

/** External deps that postinstall repair must be able to materialize from the package root. */
const REQUIRED_ROOT_EXTERNALS = [
  "@modelcontextprotocol/sdk",
  "minimatch",
  "picomatch",
  "proper-lockfile",
  "undici",
  "yaml",
];

test("installer deps module exposes postinstall orchestration", async () => {
  const { runPostinstallDeps, linkWorkspacePackages, repairPackageDependencies } =
    await import("../install/deps.js");
  assert.equal(typeof runPostinstallDeps, "function");
  assert.equal(typeof linkWorkspacePackages, "function");
  assert.equal(typeof repairPackageDependencies, "function");
});

test("installer tarball declares extension-critical externals at the package root", () => {
  for (const dep of REQUIRED_ROOT_EXTERNALS) {
    assert.ok(pkg.dependencies[dep], `root package must depend on ${dep}`);
  }
});
