// Project/App: gsd-pi
// File Purpose: Regression coverage for vendor-pi.cjs dry-run previews and missing-upstream errors.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

function stageScript(prefix, config) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(join(repoRoot, "scripts", "vendor-pi.cjs"), join(root, "scripts", "vendor-pi.cjs"));
  if (config) {
    writeFileSync(join(root, "scripts", "pi-upstream.json"), `${JSON.stringify(config, null, 2)}\n`);
  } else {
    copyFileSync(join(repoRoot, "scripts", "pi-upstream.json"), join(root, "scripts", "pi-upstream.json"));
  }
  return root;
}

function runVendorPi(root, args) {
  return spawnSync(process.execPath, [join(root, "scripts", "vendor-pi.cjs"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("vendor-pi --dry-run previews every mapped package without an upstream checkout", () => {
  const root = stageScript("gsd-vendor-pi-dry-");

  try {
    const config = JSON.parse(readFileSync(join(root, "scripts", "pi-upstream.json"), "utf8"));
    const result = runVendorPi(root, ["--dry-run"]);

    assert.equal(result.status, 0, `expected clean exit, got ${result.status}:\n${result.stderr}`);

    const planned = Object.entries(config.packageMap);
    for (const [upstreamPath, targetPath] of planned) {
      assert.ok(
        result.stderr.includes(`[dry-run] Copy ${upstreamPath} → ${targetPath}`),
        `missing plan line for ${upstreamPath}:\n${result.stderr}`,
      );
    }
    assert.equal(result.stderr.match(/Copy .+ → .+/g)?.length, planned.length);

    assert.equal(existsSync(join(root, ".cache")), false, "dry run must not create an upstream checkout");
    assert.equal(existsSync(join(root, "packages")), false, "dry run must not touch the working tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vendor-pi still fails when a real vendor run is missing an upstream package", () => {
  const upstream = mkdtempSync(join(tmpdir(), "gsd-vendor-pi-upstream-"));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], {
      cwd: upstream,
      stdio: "pipe",
    });

  // packages/agent is deliberately absent so the first mapped package is missing upstream.
  for (const dir of ["packages/ai", "packages/tui", "packages/coding-agent"]) {
    mkdirSync(join(upstream, dir), { recursive: true });
    writeFileSync(join(upstream, dir, "package.json"), `${JSON.stringify({ name: dir }, null, 2)}\n`);
  }

  git("init", "--quiet", "--initial-branch=main");
  git("add", "--all");
  git("commit", "--quiet", "-m", "fixture");

  const baseConfig = JSON.parse(readFileSync(join(repoRoot, "scripts", "pi-upstream.json"), "utf8"));
  const root = stageScript("gsd-vendor-pi-missing-", {
    ...baseConfig,
    repository: `file://${upstream}`,
    pinnedRef: "main",
  });

  try {
    const result = runVendorPi(root, []);

    assert.equal(result.status, 1, `expected failure, got ${result.status}:\n${result.stderr}`);
    assert.match(result.stderr, /Upstream package not found: .*packages\/agent/);
    assert.equal(existsSync(join(root, "packages")), false, "nothing should be vendored before the error");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(upstream, { recursive: true, force: true });
  }
});
