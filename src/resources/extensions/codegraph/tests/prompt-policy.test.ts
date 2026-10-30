import test from "node:test";
import assert from "node:assert/strict";
import { applyCodegraphPromptHookPolicy, isClearlyCodePrompt } from "../prompt-policy.ts";

test("ordinary prose and product names are not evidence of a code request", () => {
  for (const prompt of [
    "",
    "retry it",
    "Show today's sessions",
    "Review the validation details",
    "Change the GitHub issue title",
    "What's new in CodeGraph today?",
    "Which payment method should I use?",
    "What does the iPhone cost?",
    "Open the eBay listing",
    "What version of macOS is installed?",
    "Open https://example.com/status.js",
    "Summarize this email:\n```text\nretry it\n```",
    "Summarize this note:\n```markdown\nToday's sessions\n```",
  ]) {
    assert.equal(isClearlyCodePrompt(prompt), false, prompt);
  }
});

test("source files, code syntax, identifiers, and explicit programming terms are code evidence", () => {
  for (const prompt of [
    "Inspect src/auth.ts",
    "Inspect src\\auth.ts:42",
    "Inspect C:\\project\\src\\auth.ts:42",
    "Inspect /project/src/auth.ts",
    "Fix server.go",
    "Explain `ValidTitle`",
    "Inspect the ValidTitle function",
    "What calls the function named validate?",
    "Explain the class named User",
    "Find verifyToken()",
    "How does RetryOnlyPipeline work?",
    "Trace parseUserProfile",
    "Inspect get_user_profile",
    "Refactor the validation code",
    "Explain the source code",
    "Run the unit tests",
    "分析 `RetryOnlyPipeline`",
    "```python\nprint('hello')\n```",
    "Explain this snippet:\n```\nconst answer = 42;\n```",
  ]) {
    assert.equal(isClearlyCodePrompt(prompt), true, prompt);
  }
});

test("host reminders do not turn an ordinary user request into a code request", () => {
  for (const prompt of [
    "<system-reminder>Inspect src/auth.ts and its source code.</system-reminder>\nretry it",
    "<system_reminder>Use the function in src/auth.ts.</system_reminder>\nChange the issue title",
    "<current_datetime>2026-10-30</current_datetime>\n<copilot_working_context>current_working_directory: /repo/src/auth.ts</copilot_working_context>\nretry it",
    "<task-notification>RetryOnlyPipeline changed in src/auth.ts</task-notification>",
  ]) {
    assert.equal(isClearlyCodePrompt(prompt), false, prompt);
  }
  assert.equal(
    isClearlyCodePrompt("<system-reminder>Retry the request.</system-reminder>\nInspect src/auth.ts"),
    true,
  );
});

test("generic requests opt out of the hook without mutating other environment values", () => {
  const parent = {
    CODEGRAPH_NO_PROMPT_HOOK: "0",
    CODEGRAPH_PROMPT_HOOK: "1",
    UNRELATED_SETTING: "kept",
  };
  const child = applyCodegraphPromptHookPolicy(parent, "retry it");

  assert.equal(child.CODEGRAPH_NO_PROMPT_HOOK, "1");
  assert.equal(child.CODEGRAPH_PROMPT_HOOK, "1");
  assert.equal(child.UNRELATED_SETTING, "kept");
  assert.equal(parent.CODEGRAPH_NO_PROMPT_HOOK, "0");
});

test("clear code requests preserve an existing hook opt-out", () => {
  const env = applyCodegraphPromptHookPolicy(
    { CODEGRAPH_NO_PROMPT_HOOK: "1", CODEGRAPH_PROMPT_HOOK: "0" },
    "Inspect src/auth.ts",
  );
  assert.equal(env.CODEGRAPH_NO_PROMPT_HOOK, "1");
  assert.equal(env.CODEGRAPH_PROMPT_HOOK, "0");
});

test("clear code requests do not add a hook opt-out when none was configured", () => {
  const env = applyCodegraphPromptHookPolicy({}, "Inspect src/auth.ts");
  assert.equal(env.CODEGRAPH_NO_PROMPT_HOOK, undefined);
});

test("subagents always suppress the hook even when a code request explicitly enables it", () => {
  const env = applyCodegraphPromptHookPolicy(
    { GSD_SUBAGENT_CHILD: "1", CODEGRAPH_NO_PROMPT_HOOK: "0" },
    "Inspect src/auth.ts",
  );
  assert.equal(env.CODEGRAPH_NO_PROMPT_HOOK, "1");
});
