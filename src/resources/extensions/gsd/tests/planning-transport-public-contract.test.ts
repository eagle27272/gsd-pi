// Project/App: gsd-pi
// File Purpose: Public schema parity contract for every planning transport surface.

import assert from "node:assert/strict";
import test from "node:test";

import { registerDbTools } from "../bootstrap/db-tools.ts";
import { registerWorkflowTools } from "../../../../../packages/mcp-server/src/workflow-tools.ts";

const ALIASES = new Map([
  ["gsd_plan_milestone", "gsd_milestone_plan"],
  ["gsd_plan_slice", "gsd_slice_plan"],
  ["gsd_plan_task", "gsd_task_plan"],
  ["gsd_replan_slice", "gsd_slice_replan"],
  ["gsd_reassess_roadmap", "gsd_roadmap_reassess"],
]);
const CANONICAL = [...ALIASES.keys(), "gsd_replan_task"];
const PRIVATE_FIELDS = [
  "idempotencyKey",
  "expectedRevision",
  "expectedAuthorityEpoch",
  "invocation",
  "sourceTransport",
  "traceId",
  "turnId",
];

test("Pi and MCP planning schemas keep invocation identity private, and MCP aliases stay schema-identical", () => {
  const piTools: Array<{ name: string; parameters: { properties?: Record<string, unknown> } }> = [];
  registerDbTools({
    registerTool(tool: { name: string; parameters: { properties?: Record<string, unknown> } }) {
      piTools.push(tool);
    },
  } as unknown as Parameters<typeof registerDbTools>[0]);

  const mcpTools: Array<{ name: string; params: Record<string, unknown> }> = [];
  registerWorkflowTools({
    tool(name: string, _description: string, params: Record<string, unknown>) {
      mcpTools.push({ name, params });
    },
  } as Parameters<typeof registerWorkflowTools>[0]);

  for (const canonical of CANONICAL) {
    const pi = piTools.find((tool) => tool.name === canonical);
    const mcp = mcpTools.find((tool) => tool.name === canonical);
    assert.ok(pi, `Pi must register ${canonical}`);
    assert.ok(mcp, `MCP must register ${canonical}`);
    for (const field of PRIVATE_FIELDS) {
      assert.equal(pi.parameters.properties?.[field], undefined, `${canonical} Pi schema leaked ${field}`);
      assert.equal(mcp.params[field], undefined, `${canonical} MCP schema leaked ${field}`);
    }

    const aliasName = ALIASES.get(canonical);
    if (!aliasName) continue;
    const mcpAlias = mcpTools.find((tool) => tool.name === aliasName);
    assert.ok(mcpAlias, `MCP must register ${aliasName}`);
    assert.strictEqual(mcpAlias.params, mcp.params, `${aliasName} MCP schema must be canonical-identical`);
  }
});
