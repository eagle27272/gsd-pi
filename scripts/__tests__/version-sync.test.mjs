// Project/App: gsd-pi
// File Purpose: Regression coverage for release version surface sync.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  RELEASE_WORKSPACE_PACKAGE_DIRS,
  resolveEngineOptionalDependencyVersion,
  syncVersionSurfaces,
  verifyVersionSync,
} = require("../lib/version-sync.cjs");

test("resolveEngineOptionalDependencyVersion keeps prerelease publishes on stable engine packages", () => {
  // dev and next channels both reuse the stable engine packages — neither
  // builds per-platform engines, so the suffix must be stripped to the base
  // X.Y.Z that actually exists on npm.
  assert.equal(resolveEngineOptionalDependencyVersion("1.0.2-dev.adee50b"), "1.0.2");
  assert.equal(resolveEngineOptionalDependencyVersion("1.0.2-next.adee50b"), "1.0.2");
  assert.equal(resolveEngineOptionalDependencyVersion("1.0.2"), "1.0.2");
  // A non-dev/next prerelease (e.g. a real custom channel) is left intact.
  assert.equal(resolveEngineOptionalDependencyVersion("1.0.2-rc.1"), "1.0.2-rc.1");
});

test("version sync keeps the workflow MCP server and excludes retired products", () => {
  assert.ok(RELEASE_WORKSPACE_PACKAGE_DIRS.includes("packages/mcp-server"));
  assert.ok(!RELEASE_WORKSPACE_PACKAGE_DIRS.includes("packages/daemon"));
  assert.ok(!RELEASE_WORKSPACE_PACKAGE_DIRS.includes("packages/cloud-mcp-gateway"));
  assert.ok(!RELEASE_WORKSPACE_PACKAGE_DIRS.includes("packages/gsd-cloud"));
});

test("syncVersionSurfaces rewrites internal deps to the stamped prerelease version", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-version-sync-"));
  const devVersion = "1.0.2-dev.abc1234";

  try {
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "@opengsd/gsd-pi", version: "1.0.2" }, null, 2)}\n`,
    );

    mkdirSync(join(root, "packages", "rpc-client"), { recursive: true });
    writeFileSync(
      join(root, "packages", "rpc-client", "package.json"),
      `${JSON.stringify({
        name: "@opengsd/rpc-client",
        version: "1.0.2",
      }, null, 2)}\n`,
    );

    mkdirSync(join(root, "packages", "mcp-server"), { recursive: true });
    writeFileSync(
      join(root, "packages", "mcp-server", "package.json"),
      `${JSON.stringify({
        name: "@opengsd/mcp-server",
        version: "1.0.2",
        dependencies: {
          "@opengsd/rpc-client": "^1.0.2",
        },
      }, null, 2)}\n`,
    );

    syncVersionSurfaces(root, devVersion);

    const rpcClient = JSON.parse(readFileSync(join(root, "packages", "rpc-client", "package.json"), "utf8"));
    const mcpServer = JSON.parse(readFileSync(join(root, "packages", "mcp-server", "package.json"), "utf8"));

    assert.equal(rpcClient.version, devVersion);
    assert.equal(mcpServer.version, devVersion);
    assert.equal(mcpServer.dependencies["@opengsd/rpc-client"], "workspace:*");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

