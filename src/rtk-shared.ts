import { existsSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { delimiter, join } from "node:path";

export const GSD_RTK_DISABLED_ENV = "GSD_RTK_DISABLED";
export const GSD_RTK_PATH_ENV = "GSD_RTK_PATH";
export const RTK_TELEMETRY_DISABLED_ENV = "RTK_TELEMETRY_DISABLED";

export function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function isRtkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isTruthy(env[GSD_RTK_DISABLED_ENV]);
}

export function getManagedRtkDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.GSD_HOME || join(osHomedir(), ".gsd"), "agent", "bin");
}

export function getRtkBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "rtk.exe" : "rtk";
}

export function getPathValue(env: NodeJS.ProcessEnv): string | undefined {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return pathKey ? env[pathKey] : env.PATH;
}

function resolvePathCandidates(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return pathValue
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function resolveSystemRtkPath(
  pathValue: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const candidates = platform === "win32"
    ? ["rtk.exe", "rtk.cmd", "rtk.bat", "rtk"]
    : ["rtk"];

  for (const dir of resolvePathCandidates(pathValue)) {
    for (const candidate of candidates) {
      const fullPath = join(dir, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return null;
}

/** Moves an entry already on PATH to the front rather than leaving it where it is. */
export function prependPathEntry(env: NodeJS.ProcessEnv, entry: string): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? (process.platform === "win32" ? "Path" : "PATH");
  const parts = (env[pathKey] ?? "").split(delimiter).filter(Boolean).filter((part) => part !== entry);
  env[pathKey] = [entry, ...parts].join(delimiter);
  return env;
}

/**
 * `binDir` must hold the RTK that was actually selected. Rewritten commands run
 * `rtk …` as a bare word, so whatever PATH resolves first is what executes — pinning
 * the managed directory here while a different binary was chosen means GSD validates
 * one RTK and runs another (#247).
 */
export function applyRtkProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
  binDir: string = getManagedRtkDir(env),
): NodeJS.ProcessEnv {
  prependPathEntry(env, binDir);
  env[RTK_TELEMETRY_DISABLED_ENV] = "1";
  return env;
}

export function buildRtkEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return applyRtkProcessEnv({ ...env });
}
