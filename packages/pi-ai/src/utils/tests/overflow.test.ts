import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AssistantMessage } from "../../types.js";
import { isContextOverflow } from "../overflow.js";

function errorMessage(text: string, provider = "openai"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider,
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: text,
		timestamp: Date.now(),
	} as AssistantMessage;
}

describe("isContextOverflow", () => {
	const overflowing: Array<[string, string]> = [
		["GitHub Copilot request body too large", 'github-copilot API error (413): {"message":"failed to parse request","code":""}'],
		["bare HTTP 413", "413 Request Entity Too Large"],
		["z.ai prompt too long", '{"code":"1261","message":"Prompt too long"}'],
		["z.ai CN endpoint", '{"code":"1261","message":"Prompt exceeds max length"}'],
		["LiteLLM pre-call check", "litellm.ContextWindowExceededError: Context Window exceeded for given call."],
		["parenthesized max context length", "Input length (265330) exceeds model's maximum context length (262144)."],
		["Poolside", "Input length 300000 exceeds the maximum allowed input length of 262144 tokens."],
		["DS4", "Prompt has 120000 tokens, but the configured context size is 100000 tokens"],
		["DashScope", "Range of input length should be [1, 129024]"],
	];
	for (const [name, text] of overflowing) {
		it(`detects ${name}`, () => {
			assert.equal(isContextOverflow(errorMessage(text)), true);
		});
	}

	it("only treats a Cerebras body-less 400 as overflow for the cerebras provider", () => {
		assert.equal(isContextOverflow(errorMessage("400 status code (no body)", "cerebras")), true);
		assert.equal(isContextOverflow(errorMessage("400 status code (no body)", "openai")), false);
	});

	it("does not treat a status mentioned in the body as overflow", () => {
		assert.equal(isContextOverflow(errorMessage('500 {"detail":"upstream said 413 earlier"}')), false);
	});

	it("keeps throttling out of overflow", () => {
		assert.equal(isContextOverflow(errorMessage("Throttling error: Too many tokens, please wait")), false);
	});
});
