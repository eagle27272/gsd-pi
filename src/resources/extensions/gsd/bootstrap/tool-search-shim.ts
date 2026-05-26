// GSD does not implement Anthropic deferred-tool ToolSearch. Models trained on
// that API sometimes try `select:mcp__gsd-workflow__<tool>` and get a hard
// "Tool ToolSearch not found" failure. This shim returns explicit call guidance.

import { Type } from "@gsd/pi-ai";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";

/** @internal */
export function parseToolSearchSelectQuery(query: string): string | null {
  const trimmed = query.trim();
  const match = trimmed.match(/^select:(.+)$/i);
  if (!match) return null;
  const name = match[1]?.trim();
  return name && name.length > 0 ? name : null;
}

function formatDirectCallHint(toolName: string): string {
  if (toolName.startsWith("mcp__")) {
    return `Call \`${toolName}\` directly in a tool-use block. ToolSearch is not available in GSD.`;
  }
  if (toolName.startsWith("gsd_") || toolName === "memory_query" || toolName === "capture_thought") {
    return (
      `Call \`${toolName}\` directly (or \`mcp__gsd-workflow__${toolName}\` when running inside Claude Code). ` +
      "ToolSearch is not available in GSD."
    );
  }
  return `Call \`${toolName}\` directly. ToolSearch is not available in GSD.`;
}

export function registerToolSearchShim(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ToolSearch",
    label: "Tool Search (unsupported)",
    description:
      "Not supported in GSD. Workflow tools are already in your tool list — invoke them by name " +
      "(e.g. gsd_save_gate_result or mcp__gsd-workflow__gsd_save_gate_result). Do not use ToolSearch.",
    parameters: Type.Object({
      query: Type.String({ description: "Ignored — use a direct tool call instead" }),
      max_results: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      const query = typeof params?.query === "string" ? params.query : "";
      const selected = parseToolSearchSelectQuery(query);
      const text = selected
        ? formatDirectCallHint(selected)
        : "ToolSearch is not available in GSD. Call the workflow tool you need directly by name.";
      return {
        content: [{ type: "text" as const, text }],
        details: { operation: "tool_search_shim", query, resolvedTool: selected },
      };
    },
    renderCall(args: any, theme: any) {
      const q = args.query ?? "";
      return new Text(theme.fg("toolTitle", theme.bold("ToolSearch ")) + theme.fg("dim", q), 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const text = result.content?.[0]?.text ?? "Use a direct tool call instead of ToolSearch.";
      return new Text(theme.fg("warning", text), 0, 0);
    },
  });
}
