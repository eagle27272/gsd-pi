// gsd-pi — CodeGraph tools.
//
// Two tools mirroring what codegraph's own MCP server exposes. Both are only
// ever constructed when detect.ts says the project is indexed, so their prompt
// guidelines are automatically absent in projects without a graph.

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
  type AgentToolResult,
} from "@gsd/pi-coding-agent";
import { Type } from "@gsd/pi-ai";
import {
  CODEGRAPH_TIMEOUT_MS,
  buildExploreArgs,
  buildNodeArgs,
  type CodegraphRunner,
  type ExploreParams,
  type NodeParams,
} from "./cli.js";
import { hasIndex, type CodegraphEnv } from "./detect.js";

export interface CodegraphDetails {
  command: "explore" | "node";
  projectRoot: string;
  exitCode: number | null;
  truncated: boolean;
  error?: string;
}

export interface CodegraphToolDeps {
  env: CodegraphEnv;
  run: CodegraphRunner;
  isDirectory?: (path: string) => boolean;
}

function errorResult(
  command: "explore" | "node",
  projectRoot: string,
  message: string,
  exitCode: number | null = null,
): AgentToolResult<CodegraphDetails> {
  return {
    content: [{ type: "text", text: message }],
    details: { command, projectRoot, exitCode, truncated: false, error: message },
    isError: true,
  };
}

async function runTool(
  deps: CodegraphToolDeps,
  command: "explore" | "node",
  args: string[],
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<CodegraphDetails>> {
  const { projectRoot } = deps.env;
  if (!hasIndex(projectRoot, deps.isDirectory)) {
    return errorResult(
      command,
      projectRoot,
      `The CodeGraph index for ${projectRoot} is no longer present. Use grep and read instead.`,
    );
  }

  const run = await deps.run(deps.env.binPath, args, signal);
  if (run.aborted) return errorResult(command, projectRoot, "CodeGraph call was aborted.");
  if (run.timedOut) {
    return errorResult(command, projectRoot, `CodeGraph timed out after ${CODEGRAPH_TIMEOUT_MS}ms.`);
  }
  if (run.code !== 0) {
    const detail =
      (run.stderr || run.stdout).trim() || `codegraph exited with code ${String(run.code)}`;
    return errorResult(command, projectRoot, detail, run.code);
  }

  const truncation = truncateHead(run.stdout, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const text = truncation.truncated
    ? `${truncation.content}\n\n[truncated — ${truncation.outputLines} of ${truncation.totalLines} lines shown; narrow the query]`
    : truncation.content;
  return {
    content: [{ type: "text", text }],
    details: { command, projectRoot, exitCode: 0, truncated: truncation.truncated },
  };
}

export function createExploreTool(deps: CodegraphToolDeps) {
  return defineTool({
    name: "codegraph_explore",
    label: "CodeGraph Explore",
    description:
      "Explore an area of this codebase through its CodeGraph symbol index. Returns the relevant " +
      "symbols' verbatim, line-numbered source, the call paths between them (including dynamic-dispatch " +
      "hops grep cannot follow), and a blast-radius summary of what depends on them. One call replaces " +
      "a grep-then-read loop.",
    promptSnippet: "Explore code through the CodeGraph symbol index",
    promptGuidelines: [
      "This project has a CodeGraph index. Reach for codegraph_explore before grep or find when you need to locate or understand code.",
      "Name a file or symbol in the query to get its current line-numbered source; treat source returned this way as already read.",
      "Use grep for non-code text — log lines, config values, strings in data files — where a symbol graph cannot help.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Symbol names or a natural-language question, e.g. 'detectHerdrEnv' or 'how are extensions registered'",
      }),
      maxFiles: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 20,
          description: "Maximum number of files to include source from. Omit for codegraph's default.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      return runTool(deps, "explore", buildExploreArgs(deps.env.projectRoot, params as ExploreParams), signal);
    },
  });
}

export function createNodeTool(deps: CodegraphToolDeps) {
  return defineTool({
    name: "codegraph_node",
    label: "CodeGraph Node",
    description:
      "Read one symbol's source plus its caller/callee trail from the CodeGraph index, or read a whole " +
      "file with line numbers plus the files that depend on it. Pass `name` for symbol mode, `file` for " +
      "file mode, or both to disambiguate a symbol to a file.",
    promptSnippet: "Read a symbol or file, with dependents, from the CodeGraph index",
    promptGuidelines: [
      "Prefer codegraph_node over read when you want one symbol and its callers rather than a whole file.",
      "File mode returns the same line-numbered content as read, plus the files that depend on it; treat the file as read.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Symbol name, e.g. 'detectHerdrEnv'" })),
      file: Type.Optional(
        Type.String({
          description:
            "File path, repo-relative or absolute. Alone for file mode, or alongside `name` to disambiguate.",
        }),
      ),
      offset: Type.Optional(Type.Number({ minimum: 1, description: "File mode only: 1-based start line" })),
      limit: Type.Optional(Type.Number({ minimum: 1, description: "File mode only: maximum lines" })),
      symbolsOnly: Type.Optional(
        Type.Boolean({ description: "File mode only: return just the symbol map and dependents" }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const p = params as NodeParams;
      if (!p.name && !p.file) {
        return errorResult(
          "node",
          deps.env.projectRoot,
          "codegraph_node needs `name` for symbol mode or `file` for file mode.",
        );
      }
      return runTool(deps, "node", buildNodeArgs(deps.env.projectRoot, p), signal);
    },
  });
}
