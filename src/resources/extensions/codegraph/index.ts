// gsd-pi — CodeGraph extension.
//
// Gives the agent symbol-graph exploration in projects that already have a
// .codegraph/ index. A hard no-op otherwise: no tools, no prompt text, no cost.
// Read-only — this extension never creates or updates an index.

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { createExecFileRunner, type CodegraphRunner } from "./cli.js";
import { detectCodegraph, type CodegraphEnv } from "./detect.js";
import { createExploreTool, createNodeTool } from "./tools.js";

/** Testable wiring seam — see tests/registration.test.ts. */
export function __wire(pi: ExtensionAPI, env: CodegraphEnv, run: CodegraphRunner): void {
  const deps = { env, run };
  pi.registerTool(createExploreTool(deps));
  pi.registerTool(createNodeTool(deps));
}

export default function (pi: ExtensionAPI): void {
  const env = detectCodegraph();
  if (!env) return; // no index or no binary — register nothing
  __wire(pi, env, createExecFileRunner());
}
