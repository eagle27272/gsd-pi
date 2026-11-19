import assert from "node:assert/strict";
import { it } from "node:test";

import type { AgentMessage } from "@gsd/pi-agent-core";
import type { AssistantMessage, Model } from "@gsd/pi-ai";

import { type CompactionPreparation, compact } from "./compaction.js";

const SUMMARY = `## Goal\n${"The user is migrating the billing service. ".repeat(10)}\n## Progress\n- Done: schema`;

it("summarizes the history and the split-turn prefix one after the other", async () => {
	const model = {
		id: "m",
		name: "m",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 4096,
	} as Model<any>;
	const user = (text: string) => ({ role: "user", content: text, timestamp: Date.now() }) as unknown as AgentMessage;
	const preparation = {
		firstKeptEntryId: "kept",
		messagesToSummarize: [user("earlier history")],
		turnPrefixMessages: [user("start of the split turn")],
		isSplitTurn: true,
		tokensBefore: 1000,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1000 },
	} as unknown as CompactionPreparation;

	let inFlight = 0;
	let maxInFlight = 0;
	let calls = 0;
	await compact(preparation, model, undefined, undefined, undefined, undefined, undefined, undefined, async () => {
		calls++;
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((resolve) => setImmediate(resolve));
		inFlight--;
		return { content: [{ type: "text", text: SUMMARY }], stopReason: "stop" } as unknown as AssistantMessage;
	});

	assert.equal(calls, 2);
	assert.equal(maxInFlight, 1);
});
