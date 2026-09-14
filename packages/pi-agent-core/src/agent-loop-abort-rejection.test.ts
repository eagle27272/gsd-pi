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

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
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
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((message) =>
		message.role === "user" || message.role === "assistant" || message.role === "toolResult"
	) as Message[];
}

function createTool(name: string, execute: AgentTool["execute"]): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: {} } as AgentTool["parameters"],
		execute,
	};
}

/** Drain the microtask + macrotask queues so Node can classify a rejection as unhandled. */
async function settleRejectionTracking(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

// In the parallel path the first tool call is prepared and deferred into a thunk
// that only runs inside Promise.all. Preparing a *later* tool call awaits
// `beforeToolCall` in between, so the signal can abort after the first call passed
// its own abort checks. Its thunk then invokes tool.execute() against an
// already-aborted signal. The tool's promise must still be given a handler: the
// repo installs process-level `unhandledRejection` guards that write a crash log
// and exit(1), so a stray rejection here takes the whole process down.
test("a tool that rejects after abort does not produce an unhandled rejection", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);

	const abortController = new AbortController();
	let rejectSlowTool: ((error: Error) => void) | undefined;
	let slowToolSawAbortedSignal = false;

	const slowTool = createTool("slow", () => {
		slowToolSawAbortedSignal = abortController.signal.aborted;
		return new Promise((_resolve, reject) => {
			rejectSlowTool = reject;
		});
	});
	const fastTool = createTool("fast", async () => ({ output: "ok", details: undefined }));

	const context: AgentContext = { systemPrompt: "", messages: [], tools: [slowTool, fastTool] };
	const config: AgentLoopConfig = {
		model: createModel(),
		convertToLlm: identityConverter,
		beforeToolCall: async ({ toolCall }) => {
			if (toolCall.name === "fast") abortController.abort();
			return undefined;
		},
	};

	const slowCall = { type: "toolCall" as const, id: "call-slow", name: "slow", arguments: {} };
	const fastCall = { type: "toolCall" as const, id: "call-fast", name: "fast", arguments: {} };

	const streamFn = () => {
		const stream = new MockAssistantStream();
		setImmediate(() => {
			stream.push({
				type: "done",
				reason: "toolUse",
				message: createAssistantMessage([slowCall, fastCall]),
			});
		});
		return stream;
	};

	try {
		const stream = agentLoop(
			[createUserMessage("go")],
			context,
			config,
			abortController.signal,
			streamFn,
		);
		for await (const _event of stream) {
			// drain
		}

		assert.ok(
			slowToolSawAbortedSignal,
			"test no longer exercises the window: slow tool started before the abort",
		);
		assert.ok(rejectSlowTool, "slow tool was never invoked");
		rejectSlowTool?.(new Error("tool failed after the turn moved on"));
		await settleRejectionTracking();

		assert.deepEqual(unhandled, [], `unexpected unhandled rejection(s): ${unhandled.join(", ")}`);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
