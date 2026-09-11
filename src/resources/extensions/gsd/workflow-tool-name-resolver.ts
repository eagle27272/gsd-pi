// Project/App: gsd-pi
// File Purpose: Resolve a canonical workflow tool name to the spelling the active
// session actually registers.

/**
 * Canonical workflow tool names whose in-process registration uses a different
 * token. `bootstrap/memory-tools.ts` registers these three under the names they
 * shipped with; only the gsd-workflow MCP server exposes the `gsd_`-prefixed
 * canonical spellings, and the contract declares no aliases for them.
 */
export const NATIVE_WORKFLOW_TOOL_NAMES: Readonly<Record<string, string>> = {
  gsd_capture_thought: "capture_thought",
  gsd_memory_query: "memory_query",
  gsd_memory_graph: "gsd_graph",
};

/**
 * The workflow MCP server is prepared only for the `claude-code` provider
 * (`shouldAutoPrepareWorkflowMcp`), so every other provider runs the in-process
 * tools. Mirrors `resolveSubagentRoleForProvider`, which resolves the other half
 * of the advertised surface — subagent types — off the same signal.
 *
 * Advertising a name the session cannot call is worse than advertising nothing:
 * the tool-surface prompt states that near-miss variants are rejected, so a unit
 * that follows it precisely gets `Tool gsd_capture_thought not found` (issue #28).
 */
export function resolveWorkflowToolNameForProvider(toolName: string, provider?: string): string {
  if (provider?.toLowerCase() === "claude-code") return toolName;
  return NATIVE_WORKFLOW_TOOL_NAMES[toolName] ?? toolName;
}
