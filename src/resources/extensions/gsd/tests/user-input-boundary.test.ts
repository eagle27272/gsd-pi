import test from "node:test";
import assert from "node:assert/strict";

import * as userInputBoundary from "../user-input-boundary.ts";
import {
  isAwaitingUserInput,
  messageHasPendingAskUserQuestionsTool,
  shouldPauseForUserApprovalQuestion,
} from "../user-input-boundary.ts";

test("lastAssistantText extracts the latest assistant text block content", () => {
  const lastAssistantText = (userInputBoundary as {
    lastAssistantText?: (messages: unknown[] | null | undefined) => string;
  }).lastAssistantText;

  assert.equal(typeof lastAssistantText, "function");
  assert.equal(
    lastAssistantText?.([
      { role: "assistant", content: "Older message" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "First line" },
          { type: "text", text: "Second line" },
        ],
      },
    ]),
    "First line\nSecond line",
  );
  assert.equal(lastAssistantText?.(null), "");
});

test("lastAssistantText includes thinking blocks so rate-limit notices are not dropped", () => {
  const lastAssistantText = (userInputBoundary as {
    lastAssistantText?: (messages: unknown[] | null | undefined) => string;
  }).lastAssistantText;

  assert.equal(typeof lastAssistantText, "function");
  // Turn with only a thinking block (no text block) — must not return ""
  const result = lastAssistantText?.([
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "You've hit your limit · resets in 2h" },
      ],
    },
  ]);
  assert.ok(result?.includes("You've hit your limit"), `expected rate-limit text, got: ${JSON.stringify(result)}`);
});

test("isAwaitingUserInput does not trigger on thinking-block question marks", () => {
  // A thinking block with a question mark must NOT pause auto-mode —
  // it's internal reasoning, not a user-visible prompt.
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Should I skip research? Let me check the config." },
      ],
    },
  ];
  assert.equal(isAwaitingUserInput(messages), false);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-project", messages), false);
});

test("isAwaitingUserInput does not trigger on thinking-block approval phrases", () => {
  // A thinking block with approval phrases must NOT pause auto-mode.
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "The user confirmed and approved the plan. Should I proceed?" },
      ],
    },
  ];
  assert.equal(isAwaitingUserInput(messages), false);
  assert.equal(shouldPauseForUserApprovalQuestion("discuss-requirements", messages), false);
});

test("messageHasPendingAskUserQuestionsTool detects in-flight structured question tools", () => {
  // No externalResult → still in-flight
  assert.equal(
    messageHasPendingAskUserQuestionsTool({
      role: "assistant",
      content: [
        { type: "text", text: "Which direction?" },
        { type: "toolCall", name: "mcp__gsd-workflow__ask_user_questions" },
      ],
    }),
    true,
  );
  // externalResult present → tool call completed, no longer pending
  assert.equal(
    messageHasPendingAskUserQuestionsTool({
      role: "assistant",
      content: [
        { type: "toolCall", name: "ask_user_questions", externalResult: { content: [], isError: false } },
      ],
    }),
    false,
  );
});

test("isAwaitingUserInput still triggers on text-block question marks when thinking is also present", () => {
  // When thinking + text are both present and the text asks a question, it should still pause.
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Internal reasoning without questions." },
        { type: "text", text: "Does this look correct?" },
      ],
    },
  ];
  assert.equal(isAwaitingUserInput(messages), true);
});
