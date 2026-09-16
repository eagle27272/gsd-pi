import test from "node:test";
import assert from "node:assert/strict";
import { __wire } from "../index.ts";

test("__wire registers exactly the two CodeGraph tools", () => {
  const registered: string[] = [];
  const pi = { registerTool: (tool: { name: string }) => registered.push(tool.name) };
  __wire(
    pi as never,
    { binPath: "/usr/bin/codegraph", projectRoot: "/Users/dev/proj" },
    async () => ({ stdout: "", stderr: "", code: 0, timedOut: false, aborted: false }),
  );
  assert.deepEqual(registered.sort(), ["codegraph_explore", "codegraph_node"]);
});
