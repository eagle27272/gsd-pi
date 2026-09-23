import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { arch as osArch } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import extractZip from "extract-zip";
import {
  GSD_RTK_DISABLED_ENV,
  GSD_RTK_PATH_ENV,
  applyRtkProcessEnv,
  buildRtkEnv,
  getManagedRtkDir,
  getPathValue,
  getRtkBinaryName,
  isTruthy,
  isRtkEnabled,
  prependPathEntry,
  resolveSystemRtkPath,
} from "./rtk-shared.js";

// 0.33.1 re-injected a tool's own subcommand during `rewrite`, so `golangci-lint run`
// reached the binary as `golangci-lint run … run` and failed clean repos (#247).
const RTK_VERSION = "0.49.0";
export const GSD_SKIP_RTK_INSTALL_ENV = "GSD_SKIP_RTK_INSTALL";
export {
  GSD_RTK_DISABLED_ENV,
  GSD_RTK_PATH_ENV,
  buildRtkEnv,
  getManagedRtkDir,
  prependPathEntry,
};

const RTK_REPO = "rtk-ai/rtk";
const RTK_REWRITE_TIMEOUT_MS = 5_000;

/** `rtk rewrite` signals a successful rewrite with 0 on older builds and 3 from 0.4x on. */
function isRewriteStatus(status: number | null): boolean {
  return status === 0 || status === 3;
}

export interface EnsureRtkOptions {
  targetDir?: string;
  allowDownload?: boolean;
  env?: NodeJS.ProcessEnv;
  pathValue?: string;
  releaseVersion?: string;
  log?: (message: string) => void;
}

export interface EnsureRtkResult {
  enabled: boolean;
  supported: boolean;
  available: boolean;
  source: "disabled" | "unsupported" | "managed" | "system" | "downloaded" | "missing";
  binaryPath?: string;
  reason?: string;
}

function getManagedRtkPath(
  platform: NodeJS.Platform = process.platform,
  targetDir: string = getManagedRtkDir(),
): string {
  return join(targetDir, getRtkBinaryName(platform));
}

export function resolveRtkAssetName(
  platform: NodeJS.Platform,
  arch: string,
  version: string = RTK_VERSION,
): string | null {
  void version;
  if (platform === "darwin" && arch === "arm64") return "rtk-aarch64-apple-darwin.tar.gz";
  if (platform === "darwin" && arch === "x64") return "rtk-x86_64-apple-darwin.tar.gz";
  if (platform === "linux" && arch === "arm64") return "rtk-aarch64-unknown-linux-gnu.tar.gz";
  if (platform === "linux" && arch === "x64") return "rtk-x86_64-unknown-linux-musl.tar.gz";
  if (platform === "win32" && arch === "x64") return "rtk-x86_64-pc-windows-msvc.zip";
  return null;
}

function getReleaseBaseUrl(version: string): string {
  return `https://github.com/${RTK_REPO}/releases/download/v${version}`;
}

function getChecksumsUrl(version: string): string {
  return `${getReleaseBaseUrl(version)}/checksums.txt`;
}

function buildAssetUrl(version: string, assetName: string): string {
  return `${getReleaseBaseUrl(version)}/${assetName}`;
}

function parseChecksums(content: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (!match) continue;
    checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

async function downloadToFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": "gsd-pi-rtk" },
  });

  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  if (!response.body) {
    throw new Error(`download returned no body for ${url}`);
  }

  const output = createWriteStream(destination);
  await finished(Readable.fromWeb(response.body as never).pipe(output));
}

function findBinaryRecursively(rootDir: string, binaryName: string): string | null {
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isFile() && entry.name === binaryName) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
  return null;
}

function extractArchive(assetName: string, archivePath: string, extractDir: string): void {
  if (!assetName.endsWith(".tar.gz")) {
    throw new Error(`unsupported RTK archive format: ${assetName}`);
  }

  mkdirSync(extractDir, { recursive: true });
  const result = spawnSync("tar", ["xzf", archivePath, "-C", extractDir], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr?.trim() ?? `tar extraction failed for ${assetName}`);
  }
}

async function extractArchiveAsync(assetName: string, archivePath: string, extractDir: string): Promise<void> {
  if (assetName.endsWith(".zip")) {
    mkdirSync(extractDir, { recursive: true });
    await extractZip(archivePath, { dir: extractDir });
    return;
  }
  extractArchive(assetName, archivePath, extractDir);
}


export interface ResolveRtkBinaryPathOptions {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  pathValue?: string;
  platform?: NodeJS.Platform;
  targetDir?: string;
}

export function resolveRtkBinaryPath(options: ResolveRtkBinaryPathOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (options.binaryPath) return options.binaryPath;
  const explicitPath = env[GSD_RTK_PATH_ENV];
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }

  const managedPath = getManagedRtkPath(platform, options.targetDir ?? getManagedRtkDir(env));
  if (existsSync(managedPath)) {
    return managedPath;
  }
  // On Windows, also check for rtk.cmd in the managed dir (used by test fake RTK
  // and any wrapper-style installs where a .cmd launcher accompanies the binary).
  if (platform === "win32") {
    const managedDir = options.targetDir ?? getManagedRtkDir(env);
    const managedCmd = join(managedDir, "rtk.cmd");
    if (existsSync(managedCmd)) {
      return managedCmd;
    }
  }

  return resolveSystemRtkPath(options.pathValue ?? getPathValue(env), platform);
}

export interface RewriteCommandOptions {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawnSyncImpl?: typeof spawnSync;
}

export function rewriteCommandWithRtk(command: string, options: RewriteCommandOptions = {}): string {
  if (!command.trim()) return command;
  if (!isRtkEnabled(options.env ?? process.env)) return command;

  const env = options.env ?? process.env;
  const binaryPath = resolveRtkBinaryPath({
    env,
    binaryPath: options.binaryPath,
  });

  if (!binaryPath) return command;

  const run = options.spawnSyncImpl ?? spawnSync;
  const result = run(binaryPath, ["rewrite", command], {
    encoding: "utf-8",
    env: buildRtkEnv(options.env ?? process.env),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: options.timeoutMs ?? RTK_REWRITE_TIMEOUT_MS,
    // .cmd/.bat wrappers (used by fake-rtk in tests) require shell:true on Windows
    shell: /\.(cmd|bat)$/i.test(binaryPath),
  });

  if (result.error) return command;
  if (!isRewriteStatus(result.status)) return command;

  const rewritten = (result.stdout ?? "").trimEnd();
  return rewritten || command;
}

export interface ValidateRtkBinaryOptions {
  spawnSyncImpl?: typeof spawnSync;
  env?: NodeJS.ProcessEnv;
}

export type ValidateRtkBinaryResult = { valid: true } | { valid: false; error: string };

function trimSpawnOutput(output: string | Buffer | null | undefined): string {
  return output?.toString().trim() ?? "";
}

export function validateRtkBinary(binaryPath: string, options: ValidateRtkBinaryOptions = {}): ValidateRtkBinaryResult {
  const run = options.spawnSyncImpl ?? spawnSync;
  const result = run(binaryPath, ["rewrite", "git status"], {
    encoding: "utf-8",
    env: buildRtkEnv(options.env ?? process.env),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: RTK_REWRITE_TIMEOUT_MS,
  });

  if (result.error) return { valid: false, error: result.error.message };
  if (!isRewriteStatus(result.status)) {
    const stderr = trimSpawnOutput(result.stderr);
    return { valid: false, error: stderr || `exit code ${result.status ?? "unknown"}` };
  }

  const stdout = trimSpawnOutput(result.stdout);
  if (stdout !== "rtk git status") {
    return { valid: false, error: stdout ? `unexpected output: ${stdout}` : "unexpected empty output" };
  }

  return { valid: true };
}

interface ReadRtkVersionOptions {
  spawnSyncImpl?: typeof spawnSync;
  env?: NodeJS.ProcessEnv;
}

/** Semantic version reported by an RTK binary, or null when it cannot be determined. */
export function readRtkVersion(binaryPath: string, options: ReadRtkVersionOptions = {}): string | null {
  const run = options.spawnSyncImpl ?? spawnSync;
  const result = run(binaryPath, ["--version"], {
    encoding: "utf-8",
    env: buildRtkEnv(options.env ?? process.env),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: RTK_REWRITE_TIMEOUT_MS,
  });

  if (result.error || result.status !== 0) return null;
  return trimSpawnOutput(result.stdout).match(/\d+(?:\.\d+)+/)?.[0] ?? null;
}

/** Negative when `a` predates `b`, positive when it is newer, zero when equivalent. */
export function compareRtkVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * An unreadable version is treated as current: re-downloading on every startup
 * would be worse than running a binary that already passes the rewrite contract.
 */
function isRtkOutdated(installed: string | null, required: string): boolean {
  return installed !== null && compareRtkVersions(installed, required) < 0;
}

export async function ensureRtkAvailable(options: EnsureRtkOptions = {}): Promise<EnsureRtkResult> {
  const env = options.env ?? process.env;
  if (!isRtkEnabled(env)) {
    return { enabled: false, supported: true, available: false, source: "disabled", reason: `${GSD_RTK_DISABLED_ENV} is set` };
  }
  if (isTruthy(env[GSD_SKIP_RTK_INSTALL_ENV])) {
    const configuredPath = env[GSD_RTK_PATH_ENV];
    if (configuredPath && existsSync(configuredPath)) {
      return { enabled: true, supported: true, available: true, source: "managed", binaryPath: configuredPath };
    }
    return { enabled: true, supported: true, available: false, source: "missing", reason: `${GSD_SKIP_RTK_INSTALL_ENV} is set` };
  }

  const targetDir = options.targetDir ?? getManagedRtkDir(env);
  const managedPath = getManagedRtkPath(process.platform, targetDir);
  const version = options.releaseVersion ?? RTK_VERSION;

  // An RTK that works but predates the pin stays in reserve: it is still better
  // than no RTK at all if the upgrade turns out to be impossible.
  let outdated: { result: EnsureRtkResult; installed: string | null } | undefined;

  for (const candidate of [
    { path: existsSync(managedPath) ? managedPath : null, source: "managed" as const },
    { path: resolveSystemRtkPath(options.pathValue ?? getPathValue(env)), source: "system" as const },
  ]) {
    if (!candidate.path) continue;
    if (!validateRtkBinary(candidate.path, { env }).valid) continue;

    const installed = readRtkVersion(candidate.path, { env });
    const usable: EnsureRtkResult = {
      enabled: true,
      supported: true,
      available: true,
      source: candidate.source,
      binaryPath: candidate.path,
    };
    if (!isRtkOutdated(installed, version)) return usable;
    outdated ??= { result: usable, installed };
  }

  const keepOutdated = (why: string): EnsureRtkResult | null =>
    outdated
      ? { ...outdated.result, reason: `RTK ${outdated.installed} predates ${version}; upgrade skipped: ${why}` }
      : null;

  const assetName = resolveRtkAssetName(process.platform, osArch(), version);
  if (!assetName) {
    const unsupportedReason = `RTK release asset unavailable for ${process.platform}/${osArch()}`;
    return keepOutdated(unsupportedReason) ?? {
      enabled: true,
      supported: false,
      available: false,
      source: "unsupported",
      reason: unsupportedReason,
    };
  }

  if (options.allowDownload === false) {
    return keepOutdated("download disabled")
      ?? { enabled: true, supported: true, available: false, source: "missing", reason: "download disabled" };
  }

  mkdirSync(targetDir, { recursive: true });

  const tempRoot = join(targetDir, `.rtk-install-${randomUUID().slice(0, 8)}`);
  const archivePath = join(tempRoot, assetName);
  const extractDir = join(tempRoot, "extract");

  mkdirSync(tempRoot, { recursive: true });

  try {
    const checksumsUrl = getChecksumsUrl(version);
    const checksumsResponse = await fetch(checksumsUrl, { headers: { "User-Agent": "gsd-pi-rtk" } });
    if (!checksumsResponse.ok) {
      throw new Error(`failed to fetch RTK checksums (${checksumsResponse.status})`);
    }
    const checksums = parseChecksums(await checksumsResponse.text());
    const expectedSha = checksums.get(assetName);
    if (!expectedSha) {
      throw new Error(`missing checksum for ${assetName}`);
    }

    await downloadToFile(buildAssetUrl(version, assetName), archivePath);
    const actualSha = sha256File(archivePath);
    if (actualSha !== expectedSha) {
      throw new Error(`checksum mismatch for ${assetName}`);
    }

    await extractArchiveAsync(assetName, archivePath, extractDir);
    const extractedBinary = findBinaryRecursively(extractDir, getRtkBinaryName(process.platform));
    if (!extractedBinary) {
      throw new Error(`RTK binary not found in ${assetName}`);
    }

    // Validate in place before overwriting: a replacement that fails the contract
    // must not cost us a working older binary already sitting at managedPath.
    if (process.platform !== "win32") {
      chmodSync(extractedBinary, 0o755);
    }
    const downloadedValidation = validateRtkBinary(extractedBinary, { env });
    if (!downloadedValidation.valid) {
      throw new Error(`downloaded RTK binary failed validation: ${downloadedValidation.error}`);
    }

    copyFileSync(extractedBinary, managedPath);
    if (process.platform !== "win32") {
      chmodSync(managedPath, 0o755);
    }

    options.log?.(`installed RTK ${version} to ${managedPath}`);
    return { enabled: true, supported: true, available: true, source: "downloaded", binaryPath: managedPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.log?.(`RTK install skipped: ${message}`);
    return keepOutdated(message) ?? {
      enabled: true,
      supported: true,
      available: false,
      source: "missing",
      reason: message,
    };
  } finally {
    // best-effort: on Windows the extracted files can be held briefly by
    // AV/indexers; EPERM here must not escape over the real result
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

export async function bootstrapRtk(options: EnsureRtkOptions = {}): Promise<EnsureRtkResult> {
  const result = await ensureRtkAvailable(options);
  applyRtkProcessEnv(process.env);
  if (result.binaryPath) {
    process.env[GSD_RTK_PATH_ENV] = result.binaryPath;
  }
  return result;
}
