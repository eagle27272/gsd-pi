import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@gsd/pi-ai";
import { agentLoop } from "./agent-loop.js";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "./types.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 10,
			output: 2048,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2058,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 2048,
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function createStream(message: AssistantMessage): MockAssistantStream {
	const stream = new MockAssistantStream();
	queueMicrotask(() => {
		stream.push({ type: "done", reason: message.stopReason === "length" ? "length" : "stop", message });
	});
	return stream;
}

function createRecordingTool(executedWith: Array<Record<string, unknown>>): AgentTool {
	return {
		name: "write",
		label: "write",
		description: "write",
		parameters: { type: "object", properties: {} } as AgentTool["parameters"],
		execute: async (_id, params) => {
			executedWith.push(params as Record<string, unknown>);
			return { content: [{ type: "text", text: "written" }], details: undefined };
		},
	};
}

test("a tool call cut off by the output cap is reported back instead of executed", async () => {
	const executedWith: Array<Record<string, unknown>> = [];
	const completeCall = { type: "toolCall" as const, id: "call-complete", name: "write", arguments: { path: "a.ts" } };
	const truncatedCall = { type: "toolCall" as const, id: "call-truncated", name: "write", arguments: { path: "b.ts" } };

	const responses = [
		createAssistantMessage([completeCall, truncatedCall], "length"),
		createAssistantMessage([{ type: "text", text: "done" }], "stop"),
	];
	const streamFn = () => createStream(responses.shift() as AssistantMessage);

	const context: AgentContext = { systemPrompt: "", messages: [], tools: [createRecordingTool(executedWith)] };
	const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
	const user: UserMessage = { role: "user", content: "write two files", timestamp: Date.now() };

	const toolResults: Array<{ toolCallId: string; isError: boolean; text: string }> = [];
	for await (const event of agentLoop([user], context, config, undefined, streamFn)) {
		if (event.type === "message_end" && event.message.role === "toolResult") {
			const first = event.message.content[0];
			toolResults.push({
				toolCallId: event.message.toolCallId,
				isError: event.message.isError,
				text: first?.type === "text" ? first.text : "",
			});
		}
	}

	assert.deepEqual(executedWith, [{ path: "a.ts" }], "only the fully-streamed call may run");
	assert.equal(toolResults.length, 2, "every tool call still gets a result so provider transcripts stay valid");
	const complete = toolResults.find((r) => r.toolCallId === "call-complete");
	const truncated = toolResults.find((r) => r.toolCallId === "call-truncated");
	assert.equal(complete?.isError, false);
	assert.equal(truncated?.isError, true);
	assert.match(truncated?.text ?? "", /output (token )?limit|truncated/i);
});

test("a length stop whose last block is text leaves every tool call executable", async () => {
	const executedWith: Array<Record<string, unknown>> = [];
	const completeCall = { type: "toolCall" as const, id: "call-complete", name: "write", arguments: { path: "a.ts" } };

	const responses = [
		createAssistantMessage([completeCall, { type: "text", text: "and then I was going to" }], "length"),
		createAssistantMessage([{ type: "text", text: "done" }], "stop"),
	];
	const streamFn = () => createStream(responses.shift() as AssistantMessage);

	const context: AgentContext = { systemPrompt: "", messages: [], tools: [createRecordingTool(executedWith)] };
	const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
	const user: UserMessage = { role: "user", content: "write a file", timestamp: Date.now() };

	for await (const _event of agentLoop([user], context, config, undefined, streamFn)) {
		// drain
	}

	assert.deepEqual(executedWith, [{ path: "a.ts" }]);
});
