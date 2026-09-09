/**
 * Pure core for the gsd-pi self-report extension: model guidance, label
 * mapping, duplicate matching, body enrichment, and draft rendering.
 * No I/O, no extension context.
 */

export const BUG_REPORT_GUIDELINES: string[] = [
  "You are running inside the gsd-pi CLI while working on the user's current project. If you observe a defect in the gsd-pi CLI ITSELF — one of its `gsd` commands, its workflow MCP, its on-screen output, or a bundled doc/help text — you may report it with the report_gsd_bug tool.",
  "Only report defects in gsd-pi itself. Never report bugs in the project you are working on, and never report bugs in code you are writing or modifying for the current task — fix those in place.",
  "These are NOT bugs, do not report them: the ~23 baseline `pnpm run test:unit` failures on main (native setMutationBoundaryFaultForTest tests that need a --test-fault-injection build the dev environment does not produce); the known rotating flaky tests (SIGKILL-convergence, MCP-replay, write-gate CONTEXT.md) which pass in isolation.",
  "Before reporting, make sure it is a genuine, reproducible defect and not environment misconfiguration. Draft a specific, imperative title and a body with what happened, repro steps, expected vs actual, and affected files or `path:line`.",
  "Call report_gsd_bug with { title, body, category, area? }. It searches for duplicates, adds environment details, shows the user the draft, and files the issue only after the user approves in this session. If the tool says the per-session limit is reached, summarize any further findings to the user at the end of your turn instead of calling it again.",
  "If you are a subagent, do not call report_gsd_bug — report the suspected gsd-pi defect in your result text and let the main session decide.",
];

export type BugCategory = "runtime" | "docs" | "dx" | "test";

export function categoryToLabels(category: BugCategory): string[] {
  return category === "docs" ? ["bug", "documentation"] : ["bug"];
}

export interface IssueHit {
  number: number;
  title: string;
  url: string;
  state: string;
}

const STOP_TOKENS = new Set(["the", "a", "an", "on", "in", "of", "to", "is", "and", "or", "for", "with", "when"]);

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP_TOKENS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function matchExistingIssue(title: string, hits: IssueHit[]): IssueHit | null {
  const t = title.trim().toLowerCase();
  if (t.length === 0) return null;
  const tt = tokens(title);
  for (const h of hits) {
    const ht = h.title.trim().toLowerCase();
    if (ht.includes(t) || t.includes(ht)) return h;
    if (jaccard(tt, tokens(h.title)) >= 0.6) return h;
  }
  return null;
}

export interface ReportEnv {
  version: string;
  commit: string | null;
  platform: string;
  arch: string;
  node: string;
  cwdProject: string;
}

export function enrichBody(body: string, env: ReportEnv): string {
  const lines = [
    body.trimEnd(),
    "",
    "```",
    "--- environment ---",
    `gsd-pi: ${env.version}`,
    ...(env.commit ? [`commit: ${env.commit}`] : []),
    `platform: ${env.platform} ${env.arch}`,
    `node: ${env.node}`,
    `cwd project: ${env.cwdProject}`,
    "```",
    "",
    "_Filed via gsd-pi self-report._",
  ];
  return lines.join("\n");
}

export function renderDraft(input: { title: string; labels: string[]; body: string }): string {
  return [
    `Title:  ${input.title}`,
    `Labels: ${input.labels.join(", ")}`,
    "",
    input.body,
  ].join("\n");
}
