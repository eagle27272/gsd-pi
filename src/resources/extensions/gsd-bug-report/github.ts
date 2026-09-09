/**
 * Self-contained `gh` CLI wrapper for the self-report extension.
 * Every function returns GhResult<T> and never throws. Patterns copied from
 * src/resources/extensions/github-sync/cli.ts (not imported — extension isolation).
 */

import { execFileSync } from "node:child_process";
import type { IssueHit } from "./report.js";

export interface GhResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

type ExecFn = (file: string, args: string[]) => string;

let execImpl: ExecFn = (file, args) =>
  execFileSync(file, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  }).trim();

let availableCache: boolean | null = null;

export function _setExecForTest(fn: ExecFn | null): void {
  execImpl = fn ?? ((file, args) =>
    execFileSync(file, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 }).trim());
}

export function _resetGithubCacheForTest(): void {
  availableCache = null;
}

export function ghAvailable(): boolean {
  if (availableCache !== null) return availableCache;
  try {
    execImpl("gh", ["--version"]);
    execImpl("gh", ["auth", "status"]);
    availableCache = true;
  } catch {
    availableCache = false;
  }
  return availableCache;
}

export function searchIssues(repo: string, query: string): GhResult<IssueHit[]> {
  try {
    const raw = execImpl("gh", [
      "issue", "list",
      "--repo", repo,
      "--state", "all",
      "--search", query,
      "--limit", "20",
      "--json", "number,title,url,state",
    ]);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false, error: `Unexpected output: ${raw.slice(0, 200)}` };
    return { ok: true, data: parsed as IssueHit[] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function createIssue(
  repo: string,
  input: { title: string; body: string; labels: string[] },
): GhResult<string> {
  try {
    const args = [
      "issue", "create",
      "--repo", repo,
      "--title", input.title,
      "--body", input.body,
    ];
    if (input.labels.length) args.push("--label", input.labels.join(","));
    const out = execImpl("gh", args);
    const match = out.match(/https?:\/\/\S+\/issues\/\d+/);
    if (!match) return { ok: false, error: `Could not parse issue URL from: ${out.slice(0, 200)}` };
    return { ok: true, data: match[0] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
