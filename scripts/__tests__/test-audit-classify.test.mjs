import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ACKNOWLEDGED_UNRUN_TEST_PATHS,
  ACKNOWLEDGED_UNRUN_RUNNERS,
  INTEGRATION_EXTENSION_GLOBS,
  UNIT_EXTENSION_GLOBS,
  VENDORED_PI_PACKAGE_DIRS,
  acknowledgedUnrunReason,
  classifyRunner,
  isAcknowledgedUnrunTest,
  isInNpmTest,
  isReachableTest,
  strictUnwiredFailures,
} from "../lib/test-audit-lib.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

test("classifyRunner maps packages/<pkg>/src tests to the packages runner", () => {
  // run-package-tests.cjs only ever globs dist-test/packages/<pkg>/src.
  assert.equal(classifyRunner("packages/gsd-agent-core/src/session.test.ts"), "packages");
  assert.equal(classifyRunner("packages/pi-ai/src/utils/tests/agent-shim.test.ts"), "packages");
  assert.equal(classifyRunner("packages/native/src/__tests__/engine.test.mjs"), "packages");
});

test("classifyRunner maps packages/pi-ai/test to the verify-merge runner", () => {
  // pi-ai's vitest include is test/**/*.test.ts and scripts/verify-merge.sh
  // runs `pnpm --filter @gsd/pi-ai test`.
  assert.equal(classifyRunner("packages/pi-ai/test/cache-retention.test.ts"), "verify-merge");
});

test("classifyRunner maps the other vendored pi test corpora to vendored-upstream", () => {
  assert.equal(
    classifyRunner("packages/pi-coding-agent/test/settings-manager.test.ts"),
    "vendored-upstream",
  );
  assert.equal(classifyRunner("packages/pi-tui/test/wrap-ansi.test.ts"), "vendored-upstream");
  assert.equal(classifyRunner("packages/pi-agent-core/test/agent.test.ts"), "vendored-upstream");
});

test("classifyRunner reports unreached package test directories as unwired", () => {
  assert.equal(classifyRunner("packages/db/tests/schema.test.ts"), "unwired");
  assert.equal(classifyRunner("packages/mcp-server/test/readers.test.ts"), "unwired");
});

// ci-fast-gates.sh globs scripts/__tests__/*.{mjs,cjs,ts} one level deep, so an
// extension or a nesting level outside that set is unrun even though the
// directory as a whole is wired.
test("classifyRunner maps only the extensions ci-fast-gates globs to scripts-fast-gates", () => {
  assert.equal(classifyRunner("scripts/__tests__/policy.test.mjs"), "scripts-fast-gates");
  assert.equal(classifyRunner("scripts/__tests__/policy.test.cjs"), "scripts-fast-gates");
  assert.equal(classifyRunner("scripts/__tests__/policy.test.ts"), "scripts-fast-gates");
});

test("classifyRunner reports script tests the fast-gates globs miss as unwired", () => {
  assert.equal(classifyRunner("scripts/__tests__/policy.test.js"), "unwired");
  assert.equal(classifyRunner("scripts/__tests__/policy.test.tsx"), "unwired");
  assert.equal(classifyRunner("scripts/__tests__/nested/policy.test.mjs"), "unwired");
});

test("verify-merge is reachable but outside the default npm test", () => {
  assert.equal(isInNpmTest("verify-merge"), false);
  assert.equal(isReachableTest("verify-merge"), true);
});

test("vendored-upstream is neither in npm test nor reachable", () => {
  assert.equal(isInNpmTest("vendored-upstream"), false);
  assert.equal(isReachableTest("vendored-upstream"), false);
});

test("packages runner stays inside the default npm test", () => {
  assert.equal(isInNpmTest("packages"), true);
  assert.equal(isReachableTest("packages"), true);
});

// test:unit:compiled entries come in two shapes: a wildcard over an extension's
// whole tests/ dir, and a single named file promoted out of an otherwise
// integration-only extension (browser-tools/har-session-flush, see #131). Only
// the first shape says "this extension is unit-tested", so the two are split.
function unitCompiledExtensionEntries() {
  const command = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts[
    "test:unit:compiled"
  ];
  const dirGlobs = new Set();
  const namedFiles = new Map();
  for (const [, ext, tail] of command.matchAll(
    /dist-test\/src\/resources\/extensions\/([^/]+)\/tests\/([^"\s]+)/g,
  )) {
    if (tail.startsWith("*")) dirGlobs.add(ext);
    else namedFiles.set(tail, ext);
  }
  return { dirGlobs, namedFiles };
}

test("UNIT_EXTENSION_GLOBS matches the extension test dirs test:unit:compiled globs", () => {
  const { dirGlobs } = unitCompiledExtensionEntries();
  assert.ok(dirGlobs.size > 0, "expected test:unit:compiled to glob extension test dirs");
  assert.deepEqual([...UNIT_EXTENSION_GLOBS].sort(), [...dirGlobs].sort());
});

test("single test files test:unit:compiled names belong to a known extension", () => {
  const { namedFiles } = unitCompiledExtensionEntries();
  for (const [file, ext] of namedFiles) {
    assert.ok(
      UNIT_EXTENSION_GLOBS.has(ext) || INTEGRATION_EXTENSION_GLOBS.has(ext),
      `${file} names extension "${ext}", which is in neither glob set — typo or a new extension needing classification`,
    );
  }
});

test("VENDORED_PI_PACKAGE_DIRS matches the vendored package map in pi-upstream.json", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "scripts/pi-upstream.json"), "utf8"));
  const vendored = Object.values(manifest.packageMap).map((p) => p.replace(/^packages\//, ""));
  assert.deepEqual([...VENDORED_PI_PACKAGE_DIRS].sort(), vendored.sort());
});

test("acknowledged unrun entries carry a reason", () => {
  for (const [runner, reason] of Object.entries(ACKNOWLEDGED_UNRUN_RUNNERS)) {
    assert.ok(reason.length > 40, `${runner} needs a substantive reason`);
  }
  for (const [path, reason] of ACKNOWLEDGED_UNRUN_TEST_PATHS) {
    assert.ok(reason.length > 40, `${path} needs a substantive reason`);
  }
});

test("isAcknowledgedUnrunTest covers the vendored corpora and the recorded paths", () => {
  assert.equal(isAcknowledgedUnrunTest("packages/pi-coding-agent/test/foo.test.ts"), true);
  assert.equal(isAcknowledgedUnrunTest("packages/db/tests/schema.test.ts"), true);
  assert.match(acknowledgedUnrunReason("packages/db/tests/schema.test.ts"), /workspace package/i);
  assert.match(
    acknowledgedUnrunReason("packages/pi-tui/test/wrap-ansi.test.ts"),
    /ADR-010|vendored/i,
  );
});

test("isAcknowledgedUnrunTest does not swallow a newly added dead test", () => {
  assert.equal(isAcknowledgedUnrunTest("packages/db/tests/new-dead.test.ts"), false);
  assert.equal(isAcknowledgedUnrunTest("packages/rpc-client/test/dead.test.ts"), false);
  assert.equal(
    isAcknowledgedUnrunTest("src/resources/extensions/nope/tests/dead.test.ts"),
    false,
  );
});

test("strictUnwiredFailures reports unacknowledged dead tests only", () => {
  assert.deepEqual(
    strictUnwiredFailures([
      "packages/db/tests/schema.test.ts",
      "packages/db/tests/new-dead.test.ts",
      "packages/pi-coding-agent/test/settings-manager.test.ts",
      "packages/pi-ai/test/cache-retention.test.ts",
      "packages/gsd-agent-core/src/session.test.ts",
    ]),
    ["packages/db/tests/new-dead.test.ts"],
  );
});
