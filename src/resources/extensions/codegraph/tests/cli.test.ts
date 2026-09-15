import test from "node:test";
import assert from "node:assert/strict";
import { buildExploreArgs, buildNodeArgs, createExecFileRunner } from "../cli.ts";

const ROOT = "/Users/dev/proj";

test("buildExploreArgs passes --no-color, the project root, and the query after --", () => {
  assert.deepEqual(buildExploreArgs(ROOT, { query: "how are extensions registered" }), [
    "--no-color",
    "explore",
    "-p",
    ROOT,
    "--",
    "how are extensions registered",
  ]);
});

test("buildExploreArgs includes --max-files only when given", () => {
  assert.deepEqual(buildExploreArgs(ROOT, { query: "detectHerdrEnv", maxFiles: 3 }), [
    "--no-color",
    "explore",
    "-p",
    ROOT,
    "--max-files",
    "3",
    "--",
    "detectHerdrEnv",
  ]);
});

test("buildExploreArgs keeps a leading-dash query as a positional, not a flag", () => {
  // The `--` separator is what makes this safe; without it commander would try
  // to parse the query as an option.
  const args = buildExploreArgs(ROOT, { query: "--symbols-only" });
  assert.deepEqual(args.slice(-2), ["--", "--symbols-only"]);
});

test("buildNodeArgs in symbol mode passes just the name", () => {
  assert.deepEqual(buildNodeArgs(ROOT, { name: "detectHerdrEnv" }), [
    "--no-color",
    "node",
    "-p",
    ROOT,
    "--",
    "detectHerdrEnv",
  ]);
});

test("buildNodeArgs in file mode passes -f and the range flags", () => {
  assert.deepEqual(
    buildNodeArgs(ROOT, { file: "src/cli.ts", offset: 40, limit: 120 }),
    ["--no-color", "node", "-p", ROOT, "-f", "src/cli.ts", "--offset", "40", "--limit", "120"],
  );
});

test("buildNodeArgs includes --symbols-only only when true", () => {
  assert.ok(buildNodeArgs(ROOT, { file: "src/cli.ts", symbolsOnly: true }).includes("--symbols-only"));
  assert.ok(!buildNodeArgs(ROOT, { file: "src/cli.ts", symbolsOnly: false }).includes("--symbols-only"));
});

test("buildNodeArgs supports a name disambiguated to a file", () => {
  assert.deepEqual(buildNodeArgs(ROOT, { name: "run", file: "src/cli.ts" }), [
    "--no-color",
    "node",
    "-p",
    ROOT,
    "-f",
    "src/cli.ts",
    "--",
    "run",
  ]);
});

test("createExecFileRunner reports a successful run", async () => {
  const run = createExecFileRunner();
  const result = await run(process.execPath, ["-e", "process.stdout.write('hi')"], undefined);
  assert.equal(result.stdout, "hi");
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
});

test("createExecFileRunner reports a nonzero exit with stderr, without throwing", async () => {
  const run = createExecFileRunner();
  const result = await run(
    process.execPath,
    ["-e", "process.stderr.write('boom'); process.exit(3)"],
    undefined,
  );
  assert.equal(result.code, 3);
  assert.match(result.stderr, /boom/);
});

test("createExecFileRunner reports a spawn failure with a null code", async () => {
  const run = createExecFileRunner();
  const result = await run("/nonexistent/codegraph", ["--version"], undefined);
  assert.equal(result.code, null);
  assert.equal(result.timedOut, false);
});

test("createExecFileRunner reports a timeout", async () => {
  const run = createExecFileRunner(50);
  const result = await run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], undefined);
  assert.equal(result.timedOut, true);
});

test("createExecFileRunner reports an abort", async () => {
  const controller = new AbortController();
  const run = createExecFileRunner();
  const pending = run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
});
