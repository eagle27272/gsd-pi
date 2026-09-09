/**
 * Configuration for the gsd-pi self-report extension. Env reads only — no I/O.
 */

export const DEFAULT_REPO = "eagle27272/gsd-pi";
export const SOFT_CAP = 3;

const DISABLED_VALUES = new Set(["off", "0", "false"]);

export function isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GSD_BUG_REPORT;
  if (raw === undefined) return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

export function targetRepo(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.GSD_BUG_REPORT_REPO?.trim();
  if (raw && /^[\w.-]+\/[\w.-]+$/.test(raw)) return raw;
  return DEFAULT_REPO;
}
