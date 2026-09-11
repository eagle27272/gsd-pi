// Project/App: gsd-pi
// File Purpose: The set of tool names the in-process bootstrap actually registers —
// the oracle for "is this name callable on a native session?".

import { registerDbTools } from "../bootstrap/db-tools.ts";
import { registerExecTools } from "../bootstrap/exec-tools.ts";
import { registerJournalTools } from "../bootstrap/journal-tools.ts";
import { registerMemoryTools } from "../bootstrap/memory-tools.ts";
import { registerQueryTools } from "../bootstrap/query-tools.ts";

/**
 * Run every native tool registrar against a recording stub and collect the names.
 *
 * Native registration is the only place the memory tools' in-process spellings
 * (`capture_thought`, `memory_query`, `gsd_graph`) exist; the `gsd_`-prefixed
 * canonical names come from the gsd-workflow MCP server. Tests that assert a name
 * is reachable on a native session must check against this, not the contract list.
 */
export function collectNativeRegisteredToolNames(): Set<string> {
  const tools: Array<{ name: string }> = [];
  const pi = {
    registerTool(tool: { name: string }) {
      tools.push(tool);
    },
  };
  registerDbTools(pi as never);
  registerExecTools(pi as never);
  registerQueryTools(pi as never);
  registerJournalTools(pi as never);
  registerMemoryTools(pi as never);
  return new Set(tools.map((tool) => tool.name));
}
