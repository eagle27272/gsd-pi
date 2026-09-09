/**
 * gsd-pi Self-Report extension.
 *
 * report_gsd_bug tool + /report-gsd-bug command: draft a GitHub issue for a
 * defect in the gsd-pi CLI itself and file it to the fork repo after the user
 * confirms in-session. All guarantees (enable flag, soft cap, dedupe,
 * environment capture, gh-missing fallback) are enforced in runReport().
 */

import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { GIT_NO_PROMPT_ENV } from "../gsd/git-constants.js";
import { isEnabled, targetRepo, SOFT_CAP } from "./config.js";
import {
  BUG_REPORT_GUIDELINES,
  categoryToLabels,
  matchExistingIssue,
  enrichBody,
  renderDraft,
  type BugCategory,
  type ReportEnv,
} from "./report.js";
import {
  ghAvailable as realGhAvailable,
  searchIssues as realSearchIssues,
  createIssue as realCreateIssue,
  truncateBody,
} from "./github.js";
import { filedThisSession, recordFiled, resetSession } from "./session-state.js";

export interface ReportInput {
  title: string;
  body: string;
  category: BugCategory;
  area?: string;
}

export interface ReportDeps {
  env?: NodeJS.ProcessEnv;
  gh?: {
    ghAvailable: typeof realGhAvailable;
    searchIssues: typeof realSearchIssues;
    createIssue: typeof realCreateIssue;
  };
  confirm: (draft: string, repo: string) => Promise<boolean | "no-ui">;
  now?: () => ReportEnv;
}

export interface ReportResult {
  status: "disabled" | "capped" | "duplicate" | "declined" | "filed" | "manual";
  message: string;
  url?: string;
}

function defaultEnvSnapshot(env: NodeJS.ProcessEnv): ReportEnv {
  let commit: string | null = null;
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: env.GSD_PKG_ROOT ?? (env.GSD_BIN_PATH ? dirname(env.GSD_BIN_PATH) : process.cwd()),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
      env: GIT_NO_PROMPT_ENV,
    }).trim() || null;
  } catch {
    commit = null;
  }
  return {
    version: env.GSD_VERSION || "0.0.0",
    commit,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cwdProject: basename(process.cwd()),
  };
}

function prefilledIssueUrl(repo: string, title: string, body: string, labels: string[]): string {
  const q = new URLSearchParams({ title, body, labels: labels.join(",") });
  return `https://github.com/${repo}/issues/new?${q.toString()}`;
}

/**
 * The full manual-fallback payload: rendered draft, a paste-ready
 * `gh issue create` command, and a prefilled `issues/new` URL. Used by every
 * `status: "manual"` branch so the caller can always file the issue by hand.
 */
function manualInstructions(
  repo: string,
  title: string,
  body: string,
  labels: string[],
  draft: string,
  reason: string,
): string {
  const cmd =
    `gh issue create --repo ${repo} --title ${JSON.stringify(title)} ` +
    `--body-file - --label ${labels.join(",")}   # paste the body on stdin`;
  return [
    reason,
    "",
    draft,
    "",
    "Paste-ready command:",
    cmd,
    "",
    prefilledIssueUrl(repo, title, truncateBody(body), labels),
  ].join("\n");
}

export async function runReport(input: ReportInput, deps: ReportDeps): Promise<ReportResult> {
  const env = deps.env ?? process.env;
  const gh = deps.gh ?? {
    ghAvailable: realGhAvailable,
    searchIssues: realSearchIssues,
    createIssue: realCreateIssue,
  };
  const repo = targetRepo(env);
  const labels = categoryToLabels(input.category);

  if (!isEnabled(env)) {
    return { status: "disabled", message: "gsd-pi self-report is disabled (GSD_BUG_REPORT=off)." };
  }

  if (filedThisSession() >= SOFT_CAP) {
    return {
      status: "capped",
      message: `Already filed ${SOFT_CAP} issue(s) this session. Summarize any further gsd-pi findings to the user at the end of your turn instead of filing more.`,
    };
  }

  const snapshot = (deps.now ?? (() => defaultEnvSnapshot(env)))();
  const bodyIn = input.area ? `${input.body}\n\n_Area: ${input.area}_` : input.body;
  const body = enrichBody(bodyIn, snapshot);

  if (gh.ghAvailable()) {
    let dupCheckSkipped = false;
    const search = gh.searchIssues(repo, input.title);
    if (search.ok && search.data) {
      const dup = matchExistingIssue(input.title, search.data);
      if (dup) {
        return {
          status: "duplicate",
          message: `Likely duplicate of #${dup.number} (${dup.state}): ${dup.url} — not filed.`,
        };
      }
    } else {
      dupCheckSkipped = true;
    }
    const draft = renderDraft({ title: input.title, labels, body });
    const draftShown = dupCheckSkipped
      ? draft + "\n\n_Duplicate check skipped (issue search failed)._"
      : draft;
    const approved = await deps.confirm(draftShown, repo);
    if (approved === "no-ui") {
      return {
        status: "manual",
        message: manualInstructions(
          repo, input.title, body, labels, draftShown,
          "No interactive UI to confirm — file it manually:",
        ),
      };
    }
    if (!approved) return { status: "declined", message: "Not filed — declined by user." };

    const created = gh.createIssue(repo, { title: input.title, body, labels });
    if (!created.ok) {
      return {
        status: "manual",
        message: manualInstructions(
          repo, input.title, body, labels, draftShown,
          `gh issue create failed: ${created.error}`,
        ),
      };
    }
    recordFiled();
    return { status: "filed", message: `Filed: ${created.data}`, url: created.data };
  }

  const draft = renderDraft({ title: input.title, labels, body });
  return {
    status: "manual",
    message: manualInstructions(
      repo, input.title, body, labels, draft,
      "`gh` is not available.",
    ),
  };
}

const ReportParams = Type.Object({
  title: Type.String({ description: "Specific, imperative issue title." }),
  body: Type.String({
    description: "Markdown: what happened, repro steps, expected vs actual, affected files or path:line.",
  }),
  category: Type.Union(
    [Type.Literal("runtime"), Type.Literal("docs"), Type.Literal("dx"), Type.Literal("test")],
    { description: "runtime = wrong CLI/MCP behavior; docs = wrong doc/help text; dx = broken repo script/harness; test = genuine bug a test caught." },
  ),
  area: Type.Optional(Type.String({ description: "Short area tag, e.g. 'gsd auto', 'workflow-mcp'." })),
});

export default function gsdBugReport(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    resetSession();
  });

  const confirmViaUi = (ctx: { hasUI?: boolean; ui?: { select?: (t: string, o: string[], opts?: unknown) => Promise<string | undefined> } }) =>
    async (draft: string, repo: string): Promise<boolean | "no-ui"> => {
      if (!ctx.hasUI || typeof ctx.ui?.select !== "function") return "no-ui";
      // The confirm dialog is this feature's security boundary: model-authored
      // text must not be able to emit ANSI/control sequences into it. Keep only
      // \n and \t; drop C0/C1 control and escape characters and DEL.
      // eslint-disable-next-line no-control-regex
      const safeDraft = draft.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      const FILE = "File it";
      const choice = await ctx.ui.select(
        `File this issue to ${repo}?\n\n${safeDraft}`,
        [FILE, "Don't file"],
      );
      return choice === FILE;
    };

  pi.registerTool({
    name: "report_gsd_bug",
    label: "Report gsd-pi Bug",
    description:
      "Draft a GitHub issue for a defect in the gsd-pi CLI itself and file it to the fork repo after the user confirms. Searches for duplicates and adds environment details automatically.",
    promptSnippet: "Report a defect in the gsd-pi CLI itself (draft-then-confirm).",
    promptGuidelines: BUG_REPORT_GUIDELINES,
    parameters: ReportParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runReport(params as ReportInput, {
        confirm: confirmViaUi(ctx as never),
      });
      return { content: [{ type: "text", text: result.message }], details: result };
    },
  });

  pi.registerCommand("report-gsd-bug", {
    description: "Draft and file a gsd-pi bug report (interactive).",
    async handler(args: string, ctx) {
      const anyCtx = ctx as unknown as {
        hasUI?: boolean;
        ui?: {
          select?: (t: string, o: string[], opts?: unknown) => Promise<string | undefined>;
          input?: (t: string, ph?: string) => Promise<string | undefined>;
          notify?: (msg: string, level?: string) => void;
        };
      };
      const title = args.trim() || (await anyCtx.ui?.input?.("Bug title", "Short imperative title")) || "";
      if (!title) {
        anyCtx.ui?.notify?.("Cancelled — no title.", "warning");
        return;
      }
      const body = (await anyCtx.ui?.input?.("Details", "What happened, repro, expected vs actual")) || "(no details provided)";
      const result = await runReport(
        { title, body, category: "runtime" },
        { confirm: confirmViaUi(anyCtx as never) },
      );
      anyCtx.ui?.notify?.(result.message, result.status === "filed" ? "info" : "warning");
    },
  });
}
