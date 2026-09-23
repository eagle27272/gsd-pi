import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  buildRtkEnv,
  compareRtkVersions,
  ensureRtkAvailable,
  GSD_RTK_DISABLED_ENV,
  GSD_RTK_PATH_ENV,
  GSD_SKIP_RTK_INSTALL_ENV,
  getManagedRtkDir,
  prependPathEntry,
  readRtkVersion,
  resolveRtkAssetName,
  resolveRtkBinaryPath,
  rewriteCommandWithRtk,
  validateRtkBinary,
} from "../rtk.ts";
import { createFakeRtk } from "./rtk-test-utils.ts";
import type { FakeRtkResponse } from "./rtk-test-utils.ts";

/** Install a fake RTK as the managed binary under a throwaway GSD_HOME. */
function installFakeRtk(
  dir: string,
  mapping: Record<string, FakeRtkResponse>,
): { path: string; cleanup: () => void } {
  const fake = createFakeRtk(mapping);
  const binaryPath = join(dir, process.platform === "win32" ? "rtk.cmd" : "rtk");
  mkdirSync(dir, { recursive: true });
  copyFileSync(fake.path, binaryPath);
  if (process.platform !== "win32") {
    chmodSync(binaryPath, 0o755);
  }
  return { path: binaryPath, cleanup: fake.cleanup };
}

// Store original env values for restoration
let originalRtkDisabled: string | undefined;

beforeEach(() => {
  // Save and clear GSD_RTK_DISABLED so tests can use fake RTK binaries
  originalRtkDisabled = process.env.GSD_RTK_DISABLED;
  delete process.env.GSD_RTK_DISABLED;
});

afterEach(() => {
  // Restore original env
  if (originalRtkDisabled !== undefined) {
    process.env.GSD_RTK_DISABLED = originalRtkDisabled;
  } else {
    delete process.env.GSD_RTK_DISABLED;
  }
});

test("resolveRtkAssetName maps supported release assets correctly", () => {
  assert.equal(resolveRtkAssetName("darwin", "arm64"), "rtk-aarch64-apple-darwin.tar.gz");
  assert.equal(resolveRtkAssetName("darwin", "x64"), "rtk-x86_64-apple-darwin.tar.gz");
  assert.equal(resolveRtkAssetName("linux", "arm64"), "rtk-aarch64-unknown-linux-gnu.tar.gz");
  assert.equal(resolveRtkAssetName("linux", "x64"), "rtk-x86_64-unknown-linux-musl.tar.gz");
  assert.equal(resolveRtkAssetName("win32", "x64"), "rtk-x86_64-pc-windows-msvc.zip");
  assert.equal(resolveRtkAssetName("win32", "arm64"), null);
});

test("prependPathEntry preserves the original PATH key casing and avoids duplicates", () => {
  const env: NodeJS.ProcessEnv = { Path: "/usr/bin" };
  prependPathEntry(env, "/tmp/gsd-bin");
  assert.equal(env.Path, `/tmp/gsd-bin${delimiter}${"/usr/bin"}`);
  prependPathEntry(env, "/tmp/gsd-bin");
  assert.equal(env.Path, `/tmp/gsd-bin${delimiter}${"/usr/bin"}`);
});

test("buildRtkEnv prepends the managed bin dir and disables telemetry", () => {
  const input = { PATH: "/usr/bin" };
  const env = buildRtkEnv(input);
  // Resolve the expected dir from the same env buildRtkEnv was given — reading
  // process.env here would pick up a different GSD_HOME than the call under test.
  assert.ok(env.PATH?.startsWith(`${getManagedRtkDir(input)}${delimiter}`));
  assert.equal(env.RTK_TELEMETRY_DISABLED, "1");
});

test("rewriteCommandWithRtk rewrites when RTK returns exit 0 or 3", () => {
  const spawnSyncImpl = ((_binary: string, _args: string[]) => ({ status: 0, stdout: "rtk git status", error: undefined })) as typeof import("node:child_process").spawnSync;
  assert.equal(rewriteCommandWithRtk("git status", { binaryPath: "/tmp/rtk", spawnSyncImpl }), "rtk git status");

  const askSpawn = ((_binary: string, _args: string[]) => ({ status: 3, stdout: "rtk npm run test", error: undefined })) as typeof import("node:child_process").spawnSync;
  assert.equal(rewriteCommandWithRtk("npm run test", { binaryPath: "/tmp/rtk", spawnSyncImpl: askSpawn }), "rtk npm run test");
});

test("rewriteCommandWithRtk passes commands through on no-match or process error", () => {
  const passthroughSpawn = ((_binary: string, _args: string[]) => ({ status: 1, stdout: "", error: undefined })) as typeof import("node:child_process").spawnSync;
  assert.equal(rewriteCommandWithRtk("echo hello", { binaryPath: "/tmp/rtk", spawnSyncImpl: passthroughSpawn }), "echo hello");

  const failingSpawn = ((_binary: string, _args: string[]) => ({ status: null, stdout: "", error: new Error("boom") })) as typeof import("node:child_process").spawnSync;
  assert.equal(rewriteCommandWithRtk("git status", { binaryPath: "/tmp/rtk", spawnSyncImpl: failingSpawn }), "git status");
});

test("rewriteCommandWithRtk respects the disable flag", () => {
  const spawnSyncImpl = (() => {
    throw new Error("should not be called");
  }) as unknown as typeof import("node:child_process").spawnSync;

  assert.equal(
    rewriteCommandWithRtk("git status", {
      binaryPath: "/tmp/rtk",
      spawnSyncImpl,
      env: { [GSD_RTK_DISABLED_ENV]: "1" },
    }),
    "git status",
  );
});

test("rewriteCommandWithRtk falls back to the managed RTK path when GSD_RTK_PATH is unset", () => {
  const fake = createFakeRtk({ "git status": "rtk git status" });
  const managedHome = mkdtempSync(join(tmpdir(), "gsd-rtk-managed-home-"));
  const managedDir = join(managedHome, "agent", "bin");
  const managedPath = join(managedDir, process.platform === "win32" ? "rtk.cmd" : "rtk");

  mkdirSync(managedDir, { recursive: true });
  copyFileSync(fake.path, managedPath);
  if (process.platform !== "win32") {
    chmodSync(managedPath, 0o755);
  }

  try {
    const env = {
      ...process.env,
      GSD_HOME: managedHome,
    };
    delete env.GSD_RTK_PATH;

    assert.equal(resolveRtkBinaryPath({ env }), managedPath);
    assert.equal(rewriteCommandWithRtk("git status", { env }), "rtk git status");
  } finally {
    fake.cleanup();
    rmSync(managedHome, { recursive: true, force: true });
  }
});

test("validateRtkBinary checks the rewrite contract", () => {
  const validSpawn = ((_binary: string, _args: string[]) => ({ status: 0, stdout: "rtk git status", error: undefined })) as typeof import("node:child_process").spawnSync;
  assert.deepEqual(validateRtkBinary("/tmp/rtk", { spawnSyncImpl: validSpawn }), { valid: true });

  const invalidSpawn = ((_binary: string, _args: string[]) => ({ status: 0, stdout: "wrong output", error: undefined })) as typeof import("node:child_process").spawnSync;
  assert.deepEqual(validateRtkBinary("/tmp/rtk", { spawnSyncImpl: invalidSpawn }), {
    valid: false,
    error: "unexpected output: wrong output",
  });
});

test("validateRtkBinary surfaces subprocess stderr", () => {
  const glibcError = "/tmp/rtk: /lib/aarch64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found";
  const failingSpawn = ((_binary: string, _args: string[]) => ({
    status: 1,
    stdout: "",
    stderr: glibcError,
    error: undefined,
  })) as typeof import("node:child_process").spawnSync;

  assert.deepEqual(validateRtkBinary("/tmp/rtk", { spawnSyncImpl: failingSpawn }), {
    valid: false,
    error: glibcError,
  });
});

test("validateRtkBinary accepts the exit-3 rewrite status modern RTK returns", () => {
  const askSpawn = ((_binary: string, _args: string[]) => ({ status: 3, stdout: "rtk git status", error: undefined })) as typeof import("node:child_process").spawnSync;
  assert.deepEqual(validateRtkBinary("/tmp/rtk", { spawnSyncImpl: askSpawn }), { valid: true });
});

test("readRtkVersion parses the version banner and tolerates unreadable binaries", () => {
  const versionSpawn = ((_binary: string, _args: string[]) => ({ status: 0, stdout: "rtk 0.49.0\n", error: undefined })) as typeof import("node:child_process").spawnSync;
  assert.equal(readRtkVersion("/tmp/rtk", { spawnSyncImpl: versionSpawn }), "0.49.0");

  const failingSpawn = ((_binary: string, _args: string[]) => ({ status: 1, stdout: "", error: undefined })) as typeof import("node:child_process").spawnSync;
  assert.equal(readRtkVersion("/tmp/rtk", { spawnSyncImpl: failingSpawn }), null);

  const garbageSpawn = ((_binary: string, _args: string[]) => ({ status: 0, stdout: "not a version", error: undefined })) as typeof import("node:child_process").spawnSync;
  assert.equal(readRtkVersion("/tmp/rtk", { spawnSyncImpl: garbageSpawn }), null);
});

test("compareRtkVersions orders releases numerically, not lexically", () => {
  assert.ok(compareRtkVersions("0.33.1", "0.49.0") < 0);
  assert.ok(compareRtkVersions("0.49.0", "0.33.1") > 0);
  assert.equal(compareRtkVersions("0.49.0", "0.49.0"), 0);
  // lexical ordering would put "0.9.0" above "0.49.0"
  assert.ok(compareRtkVersions("0.9.0", "0.49.0") < 0);
  assert.ok(compareRtkVersions("1.0", "0.49.0") > 0);
});

test("ensureRtkAvailable prefers a current system RTK over an outdated managed one", async () => {
  const home = mkdtempSync(join(tmpdir(), "gsd-rtk-stale-"));
  const managedDir = join(home, "agent", "bin");
  const systemDir = join(home, "system-bin");
  const managed = installFakeRtk(managedDir, { "git status": "rtk git status", "--version": "rtk 0.33.1" });
  const system = installFakeRtk(systemDir, { "git status": "rtk git status", "--version": "rtk 0.49.0" });

  try {
    const result = await ensureRtkAvailable({
      env: { PATH: process.env.PATH ?? "" },
      targetDir: managedDir,
      pathValue: systemDir,
      releaseVersion: "0.49.0",
      allowDownload: false,
    });

    assert.equal(result.available, true);
    assert.equal(result.source, "system");
    assert.equal(result.binaryPath, system.path);
  } finally {
    managed.cleanup();
    system.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensureRtkAvailable keeps an outdated managed RTK usable when the upgrade cannot run", async () => {
  const home = mkdtempSync(join(tmpdir(), "gsd-rtk-stale-nodl-"));
  const managedDir = join(home, "agent", "bin");
  const managed = installFakeRtk(managedDir, { "git status": "rtk git status", "--version": "rtk 0.33.1" });

  try {
    const result = await ensureRtkAvailable({
      env: { PATH: process.env.PATH ?? "" },
      targetDir: managedDir,
      pathValue: "",
      releaseVersion: "0.49.0",
      allowDownload: false,
    });

    assert.equal(result.available, true);
    assert.equal(result.binaryPath, managed.path);
    assert.match(result.reason ?? "", /0\.33\.1/);
  } finally {
    managed.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensureRtkAvailable leaves an up-to-date managed RTK alone", async () => {
  const home = mkdtempSync(join(tmpdir(), "gsd-rtk-current-"));
  const managedDir = join(home, "agent", "bin");
  const managed = installFakeRtk(managedDir, { "git status": "rtk git status", "--version": "rtk 0.49.0" });

  try {
    const result = await ensureRtkAvailable({
      env: { PATH: process.env.PATH ?? "" },
      targetDir: managedDir,
      pathValue: "",
      releaseVersion: "0.49.0",
      allowDownload: false,
    });

    assert.equal(result.source, "managed");
    assert.equal(result.binaryPath, managed.path);
    assert.equal(result.reason, undefined);
  } finally {
    managed.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensureRtkAvailable respects explicit disable and skip flags without downloading", async () => {
  const disabled = await ensureRtkAvailable({
    env: { [GSD_RTK_DISABLED_ENV]: "1" },
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.source, "disabled");

  const skipped = await ensureRtkAvailable({
    env: {
      [GSD_SKIP_RTK_INSTALL_ENV]: "1",
      [GSD_RTK_PATH_ENV]: "/tmp/nonexistent-rtk",
    },
  });
  assert.equal(skipped.available, false);
  assert.equal(skipped.source, "missing");
});
