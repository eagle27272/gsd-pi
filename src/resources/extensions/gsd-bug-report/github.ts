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

/** Hard upper bound on the issue body we hand to `gh` / the prefilled URL. */
export const MAX_ISSUE_BODY = 65_000;

export function truncateBody(body: string): string {
  return body.length <= MAX_ISSUE_BODY
    ? body
    : body.slice(0, MAX_ISSUE_BODY) + "\n\n---\n_Body truncated (exceeded 65k characters)._";
}

type ExecFn = (file: string, args: string[]) => string;

const realExec: ExecFn = (file, args) =>
  execFileSync(file, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  }).trim();

let execImpl: ExecFn = realExec;

let availableCache: boolean | null = null;

export function _setExecForTest(fn: ExecFn | null): void {
  execImpl = fn ?? realExec;
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
    // Strip GitHub search-syntax tokens (e.g. `foo: bar`, `#12`) so a literal
    // title fragment doesn't zero the result set.
    const q = query.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
    const raw = execImpl("gh", [
      "issue", "list",
      "--repo", repo,
      "--state", "all",
      "--search", q,
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
      "--body", truncateBody(input.body),
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
