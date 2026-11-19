import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getModel } from "../models.js";
import { stream } from "../stream.js";
import type { Context, Model, ToolResultMessage } from "../types.js";
import { convertMessages } from "./google-shared.js";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function capturePayload(model: Model<any>, context: Context): Promise<any> {
	let captured: unknown;
	const events = stream(model, context, {
		apiKey: "test-key",
		onPayload: (payload) => {
			captured = payload;
			throw new Error("payload captured");
		},
	});
	for await (const _event of events) {
		// drain
	}
	return captured;
}

function contextWithToolResult(model: Model<any>, result: Partial<ToolResultMessage>): Context {
	return {
		messages: [
			{ role: "user", content: "go", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "boom" }],
				isError: false,
				timestamp: 3,
				...result,
			},
		],
	} as Context;
}

const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };

function openAIModel(api: "openai-completions" | "openai-responses"): Model<any> {
	return {
		id: "gpt-test",
		name: "gpt-test",
		api,
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	} as Model<any>;
}

describe("Anthropic payload", () => {
	const model = getModel("anthropic", "claude-haiku-4-5");

	it("keeps root $defs so property $refs resolve", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [
				{
					name: "lookup",
					description: "lookup",
					parameters: {
						type: "object",
						properties: { target: { $ref: "#/$defs/Target" } },
						$defs: { Target: { type: "object", properties: { id: { type: "string" } } } },
					} as any,
				},
			],
		};

		const payload = await capturePayload(model, context);

		assert.deepEqual(payload.tools[0].input_schema.$defs, {
			Target: { type: "object", properties: { id: { type: "string" } } },
		});
	});

	it("sends images from an error tool result after the tool results instead of inside them", async () => {
		const payload = await capturePayload(
			model,
			contextWithToolResult(model, { isError: true, content: [{ type: "text", text: "boom" }, image] }),
		);

		const last = payload.messages[payload.messages.length - 1];
		assert.equal(last.role, "user");
		assert.equal(last.content[0].type, "tool_result");
		assert.equal(last.content[0].is_error, true);
		const inner = last.content[0].content;
		const innerTypes = Array.isArray(inner) ? inner.map((block: any) => block.type) : ["text"];
		assert.ok(!innerTypes.includes("image"), "an error tool_result must not contain images");
		assert.ok(
			last.content.slice(1).some((block: any) => block.type === "image"),
			"the image must still reach the model",
		);
	});

	it("leaves images inside a successful tool result", async () => {
		const payload = await capturePayload(
			model,
			contextWithToolResult(model, { isError: false, content: [{ type: "text", text: "ok" }, image] }),
		);

		const last = payload.messages[payload.messages.length - 1];
		assert.ok(last.content[0].content.some((block: any) => block.type === "image"));
	});
});

describe("Bedrock payload", () => {
	const model = getModel("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0");

	it("sends images from an error tool result after the tool results instead of inside them", async () => {
		const payload = await capturePayload(
			model,
			contextWithToolResult(model, { isError: true, content: [{ type: "text", text: "boom" }, image] }),
		);

		const last = payload.messages[payload.messages.length - 1];
		assert.equal(last.role, "user");
		const toolResult = last.content[0].toolResult;
		assert.equal(toolResult.status, "error");
		assert.ok(!toolResult.content.some((block: any) => block.image), "an error toolResult must not contain images");
		assert.ok(
			last.content.slice(1).some((block: any) => block.image),
			"the image must still reach the model",
		);
	});

	it("leaves images inside a successful tool result", async () => {
		const payload = await capturePayload(
			model,
			contextWithToolResult(model, { isError: false, content: [{ type: "text", text: "ok" }, image] }),
		);

		const last = payload.messages[payload.messages.length - 1];
		assert.ok(last.content[0].toolResult.content.some((block: any) => block.image));
	});
});

describe("whitespace-only tool output", () => {
	for (const api of ["openai-completions", "openai-responses"] as const) {
		it(`${api} sends a placeholder instead of the whitespace`, async () => {
			const model = openAIModel(api);
			const payload = await capturePayload(model, contextWithToolResult(model, { content: [{ type: "text", text: "\r\n" }] }));

			const sent =
				api === "openai-completions"
					? payload.messages.find((m: any) => m.role === "tool").content
					: payload.input.find((m: any) => m.type === "function_call_output").output;
			assert.equal(sent, "(no tool output)");
		});

		it(`${api} does not claim an image is attached when there is none`, async () => {
			const model = openAIModel(api);
			const payload = await capturePayload(model, contextWithToolResult(model, { content: [] }));

			const sent =
				api === "openai-completions"
					? payload.messages.find((m: any) => m.role === "tool").content
					: payload.input.find((m: any) => m.type === "function_call_output").output;
			assert.equal(sent, "(no tool output)");
		});

		it(`${api} still sends an attached image when the text is empty`, async () => {
			const model = openAIModel(api);
			const payload = await capturePayload(model, contextWithToolResult(model, { content: [image] }));

			if (api === "openai-completions") {
				assert.equal(payload.messages.find((m: any) => m.role === "tool").content, "(see attached image)");
				assert.ok(JSON.stringify(payload.messages).includes("data:image/png;base64,AAAA"));
			} else {
				const output = payload.input.find((m: any) => m.type === "function_call_output").output;
				assert.ok(output.some((part: any) => part.type === "input_image"));
			}
		});
	}

	it("google sends a placeholder instead of whitespace", () => {
		const model = getModel("google", "gemini-2.5-flash");
		const contents = convertMessages(model, contextWithToolResult(model, { content: [{ type: "text", text: "  \n" }] }));

		const response = contents.flatMap((c) => c.parts ?? []).find((p) => p.functionResponse)?.functionResponse?.response;
		assert.deepEqual(response, { output: "(no tool output)" });
	});
});
