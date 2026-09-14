import test from "node:test";
import assert from "node:assert/strict";
import { classifyTraceProgress, type ExecutionTrace } from "../session-forensics.ts";

function traceWithToolCalls(toolCalls: ExecutionTrace["toolCalls"]): ExecutionTrace {
  return {
    toolCalls,
    filesWritten: [],
    filesRead: [],
    commandsRun: [],
    errors: [],
    lastReasoning: "",
    toolCallCount: toolCalls.length,
  };
}

test("classifyTraceProgress treats skill + read-only gsd_exec as reconnaissance-only", () => {
  const trace = traceWithToolCalls([
    { name: "skill", input: { name: "diagnose" }, isError: false },
    { name: "gsd_exec", input: { command: "rg -n TODO src" }, isError: false },
  ]);
  const result = classifyTraceProgress(trace);
  assert.equal(result.isReadOnlyReconnaissanceOnly, true);
});

test("classifyTraceProgress treats skill alone as reconnaissance-only", () => {
  const trace = traceWithToolCalls([
    { name: "skill", input: { name: "diagnose" }, isError: false },
  ]);
  const result = classifyTraceProgress(trace);
  assert.equal(result.isReadOnlyReconnaissanceOnly, true);
});

test("classifyTraceProgress treats read-only gsd_exec alone as reconnaissance-only", () => {
  const trace = traceWithToolCalls([
    { name: "gsd_exec", input: { command: "rg -n TODO src" }, isError: false },
  ]);
  const result = classifyTraceProgress(trace);
  assert.equal(result.isReadOnlyReconnaissanceOnly, true);
});

test("classifyTraceProgress treats empty trace as not reconnaissance-only", () => {
  const trace = traceWithToolCalls([]);
  const result = classifyTraceProgress(trace);
  assert.equal(result.isReadOnlyReconnaissanceOnly, false);
});

test("classifyTraceProgress rejects mutating gsd_exec command", () => {
  const trace = traceWithToolCalls([
    { name: "gsd_exec", input: { command: "npm run build" }, isError: false },
  ]);
  const result = classifyTraceProgress(trace);
  assert.equal(result.isReadOnlyReconnaissanceOnly, false);
});

test("classifyTraceProgress rejects shell-chained gsd_exec command", () => {
  const trace = traceWithToolCalls([
    { name: "gsd_exec", input: { command: "cat file && echo x > y" }, isError: false },
  ]);
  const result = classifyTraceProgress(trace);
  assert.equal(result.isReadOnlyReconnaissanceOnly, false);
});

test("classifyTraceProgress rejects script-eval gsd_exec command", () => {
  const trace = traceWithToolCalls([
    { name: "gsd_exec", input: { command: "python -c \"import pathlib; pathlib.Path('x').write_text('y')\"" }, isError: false },
  ]);
  const result = classifyTraceProgress(trace);
  assert.equal(result.isReadOnlyReconnaissanceOnly, false);
});

function classifiesAsReadOnly(command: string): boolean {
  return classifyTraceProgress(
    traceWithToolCalls([{ name: "gsd_exec", input: { command }, isError: false }]),
  ).isReadOnlyReconnaissanceOnly;
}

test("destructive arguments under a read-only command head are not reconnaissance (#17)", () => {
  // Every one of these passed: the head matched a read-only verb and the rest
  // of the line fell through the permissive `[\w\s./:@,+-]*` tail.
  for (const command of [
    "git branch -D main",
    "git branch --delete feature",
    "git branch -m old new",
    "git remote remove origin",
    "git remote set-url origin git@example.com:x/y.git",
    "git remote add upstream git@example.com:x/y.git",
    "find /tmp -type f -delete",
    "find . -name '*.ts' -exec rm {} +",
    "npm audit fix",
    "npm install left-pad",
  ]) {
    assert.equal(classifiesAsReadOnly(command), false, `must not classify as read-only: ${command}`);
  }
});

test("genuinely read-only reconnaissance still classifies as such", () => {
  for (const command of [
    "git status",
    "git log --oneline -20",
    "git diff --stat HEAD~1",
    "git branch",
    "git branch -a",
    "git branch --show-current",
    "git remote -v",
    "git remote show origin",
    "git remote get-url origin",
    "git rev-parse HEAD",
    "git ls-files src",
    "find . -name '*.ts'",
    "npm audit",
    "npm ls --depth 0",
    "npm view react version",
    "rg -n TODO src",
    "grep -ric todo src",
    "cat package.json",
    "tail -n 50 log.txt",
    "node --version",
    "python3 --version",
    "env",
  ]) {
    assert.equal(classifiesAsReadOnly(command), true, `must classify as read-only: ${command}`);
  }
});
