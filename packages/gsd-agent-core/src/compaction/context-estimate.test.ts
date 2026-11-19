import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentMessage } from "@gsd/pi-agent-core";
import type { AssistantMessage } from "@gsd/pi-ai";

import { estimateContextTokens, estimateTokens } from "./compaction.js";

function assistant(text: string, usage: { input: number; output: number; totalTokens?: number }): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "local",
		model: "mock",
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: usage.totalTokens ?? usage.input + usage.output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as unknown as AgentMessage;
}

describe("estimateContextTokens with providers that report no usage", () => {
	it("ignores an all-zero assistant usage and falls back to estimating the text", () => {
		const text = "x".repeat(40_000);
		const estimate = estimateContextTokens([user(text), assistant(text, { input: 0, output: 0 })]);

		assert.equal(estimate.lastUsageIndex, null);
		assert.equal(estimate.tokens, 20_000);
	});

	it("keeps counting from the last real usage when a later reply reports none", () => {
		const text = "y".repeat(4_000);
		const estimate = estimateContextTokens([
			user("first"),
			assistant("reply", { input: 50_000, output: 100 }),
			user(text),
			assistant(text, { input: 0, output: 0 }),
		]);

		assert.equal(estimate.lastUsageIndex, 1);
		assert.equal(estimate.usageTokens, 50_000);
		assert.equal(estimate.trailingTokens, 2_000);
	});
});

describe("estimateTokens for user images", () => {
	it("counts an image attached to a user message the same as one in a tool result", () => {
		const withImage = {
			role: "user",
			content: [
				{ type: "text", text: "look at this" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const textOnly = user("look at this");

		assert.equal(estimateTokens(withImage) - estimateTokens(textOnly), 1_200);
	});
});
