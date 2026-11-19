import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentMessage } from "@gsd/pi-agent-core";
import type { AssistantMessage, Model } from "@gsd/pi-ai";

import { generateBranchSummary } from "./branch-summarization.js";
import {
	type CompactionPreparation,
	CompactionSummaryTruncatedError,
	compact,
	generateSummary,
} from "./compaction.js";

function makeModel(): Model<any> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 4096,
	} as Model<any>;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as unknown as AgentMessage;
}

const LONG_PARTIAL_SUMMARY = `## Goal\n${"The user is migrating the billing service. ".repeat(10)}\n## Progress\n- Done: schema`;

function response(stopReason: string, text = LONG_PARTIAL_SUMMARY): AssistantMessage {
	return { content: [{ type: "text", text }], stopReason } as unknown as AssistantMessage;
}

describe("summaries cut off at the output token limit", () => {
	it("generateSummary rejects a truncated summary instead of returning it", async () => {
		await assert.rejects(
			generateSummary(
				[userMessage("hello"), userMessage("world")],
				makeModel(),
				16_384,
				undefined,
				undefined,
				undefined,
				undefined,
				async () => response("length"),
			),
			(error: unknown) => error instanceof CompactionSummaryTruncatedError,
		);
	});

	it("compact rejects a truncated turn-prefix summary", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: [userMessage("earlier history")],
			turnPrefixMessages: [userMessage("start of the split turn")],
			isSplitTurn: true,
			tokensBefore: 1000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1000 },
		} as unknown as CompactionPreparation;

		let calls = 0;
		await assert.rejects(
			compact(preparation, makeModel(), undefined, undefined, undefined, undefined, undefined, undefined, async () => {
				calls++;
				return calls === 1 ? response("stop") : response("length");
			}),
			(error: unknown) => error instanceof CompactionSummaryTruncatedError,
		);
	});

	it("generateSummary still accepts a summary that stopped on its own", async () => {
		const summary = await generateSummary(
			[userMessage("hello")],
			makeModel(),
			16_384,
			undefined,
			undefined,
			undefined,
			undefined,
			async () => response("stop"),
		);
		assert.equal(summary, LONG_PARTIAL_SUMMARY);
	});

	it("generateBranchSummary reports truncation as an error result", async () => {
		const entries = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: userMessage("work on the branch"),
			},
		] as any;

		const result = await generateBranchSummary(entries, {
			model: makeModel(),
			apiKey: "key",
			signal: new AbortController().signal,
			completeFn: async () => response("length"),
		} as any);

		assert.match(result.error ?? "", /output token limit|cut off/i);
		assert.equal(result.summary, undefined);
	});
});
