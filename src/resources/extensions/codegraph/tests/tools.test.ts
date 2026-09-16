import test from "node:test";
import assert from "node:assert/strict";
import { createExploreTool, createNodeTool, type CodegraphToolDeps } from "../tools.ts";
import type { CodegraphRun } from "../cli.ts";

const ENV = { binPath: "/usr/bin/codegraph", projectRoot: "/Users/dev/proj" };

interface Recorded {
  bin: string;
  args: string[];
}

/** Deps whose runner records its invocation and returns a canned result. */
function deps(
  result: Partial<CodegraphRun> = {},
  overrides: Partial<CodegraphToolDeps> = {},
): { deps: CodegraphToolDeps; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const base: CodegraphToolDeps = {
    env: ENV,
    isDirectory: () => true,
    run: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: "", stderr: "", code: 0, timedOut: false, aborted: false, ...result };
    },
  };
  return { deps: { ...base, ...overrides }, calls };
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => ("text" in c ? (c.text ?? "") : "")).join("");
}

test("codegraph_explore is named and described for the model", () => {
  const tool = createExploreTool(deps().deps);
  assert.equal(tool.name, "codegraph_explore");
  assert.ok(tool.promptSnippet);
  assert.ok(tool.promptGuidelines && tool.promptGuidelines.length > 0);
  assert.match(tool.promptGuidelines.join(" "), /before grep/i);
});

test("codegraph_explore invokes the binary with the built argv and returns stdout", async () => {
  const { deps: d, calls } = deps({ stdout: "**Exploration: foo**\n" });
  const tool = createExploreTool(d);
  const result = await tool.execute("id", { query: "foo" }, undefined, undefined, {} as never);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "/usr/bin/codegraph");
  assert.deepEqual(calls[0].args, ["--no-color", "explore", "-p", ENV.projectRoot, "--", "foo"]);
  assert.equal(textOf(result), "**Exploration: foo**\n");
  assert.equal(result.isError, undefined);
  assert.equal(result.details.command, "explore");
});

test("a nonzero exit becomes an error result carrying stderr, not a throw", async () => {
  const { deps: d } = deps({ code: 1, stderr: "✗ CodeGraph isn't available here" });
  const tool = createExploreTool(d);
  const result = await tool.execute("id", { query: "foo" }, undefined, undefined, {} as never);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /isn't available here/);
  assert.equal(result.details.exitCode, 1);
});

test("a not-found answer exits 0 and is passed through as a normal result", async () => {
  // Verified against the real binary: `node -- missingSymbol` exits 0 and prints
  // the not-found line on stdout. Never treat it as an error.
  const { deps: d } = deps({ stdout: 'Symbol "zzz" not found in the codebase\n', code: 0 });
  const tool = createNodeTool(d);
  const result = await tool.execute("id", { name: "zzz" }, undefined, undefined, {} as never);
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /not found in the codebase/);
});

test("a timeout becomes an error result naming the timeout", async () => {
  const { deps: d } = deps({ timedOut: true, code: null });
  const tool = createExploreTool(d);
  const result = await tool.execute("id", { query: "foo" }, undefined, undefined, {} as never);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /timed out/i);
});

test("an abort becomes an error result and says so", async () => {
  const { deps: d } = deps({ aborted: true, code: null });
  const tool = createExploreTool(d);
  const result = await tool.execute("id", { query: "foo" }, undefined, undefined, {} as never);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /abort/i);
});

test("an index removed mid-session is an error result and spawns nothing", async () => {
  const { deps: d, calls } = deps({}, { isDirectory: () => false });
  const tool = createExploreTool(d);
  const result = await tool.execute("id", { query: "foo" }, undefined, undefined, {} as never);
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  assert.match(textOf(result), /grep/i);
});

test("oversized output is truncated and says so", async () => {
  // DEFAULT_MAX_LINES is 2000; 3000 lines trips the line limit before the byte limit.
  const huge = `${Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n")}\n`;
  const { deps: d } = deps({ stdout: huge });
  const tool = createExploreTool(d);
  const result = await tool.execute("id", { query: "foo" }, undefined, undefined, {} as never);
  assert.equal(result.details.truncated, true);
  assert.ok(textOf(result).length < huge.length);
  assert.match(textOf(result), /truncated/i);
});

test("codegraph_node rejects a call with neither name nor file, without spawning", async () => {
  const { deps: d, calls } = deps();
  const tool = createNodeTool(d);
  const result = await tool.execute("id", {}, undefined, undefined, {} as never);
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  assert.match(textOf(result), /name.*file|file.*name/i);
});

test("codegraph_node file mode builds file-mode argv", async () => {
  const { deps: d, calls } = deps({ stdout: "ok" });
  const tool = createNodeTool(d);
  await tool.execute("id", { file: "src/cli.ts", symbolsOnly: true }, undefined, undefined, {} as never);
  assert.deepEqual(calls[0].args, [
    "--no-color",
    "node",
    "-p",
    ENV.projectRoot,
    "-f",
    "src/cli.ts",
    "--symbols-only",
  ]);
});
