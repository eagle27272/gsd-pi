import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic, streamSimpleAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 10, output_tokens: 0 } },
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			})}\n`,
		].join("\n");

		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	class FakeAnthropic {
		constructor(opts: Record<string, unknown>) {
			mockState.constructorOpts = opts;
		}
		messages = {
			create: () => ({ asResponse: async () => createSseResponse() }),
		};
	}

	return { default: FakeAnthropic };
});

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

async function drain(model: Model<"anthropic-messages">, apiKey: string): Promise<Record<string, unknown>> {
	const s = streamAnthropic(model, context, { apiKey });
	for await (const event of s) {
		if (event.type === "error") break;
	}
	return mockState.constructorOpts!;
}

describe("ai-gateway provider auth", () => {
	const gatewayModel: Model<"anthropic-messages"> = {
		...getModel("anthropic", "claude-sonnet-4-6"),
		provider: "ai-gateway",
		baseUrl: "https://gateway.example.com/anthropic",
		headers: { "X-JH-Client": "gsd-pi" },
	};

	it("sends the token as a bearer token with no x-api-key", async () => {
		const opts = await drain(gatewayModel, "okta-token");

		expect(opts.apiKey).toBeNull();
		expect(opts.authToken).toBe("okta-token");
		expect(opts.baseURL).toBe("https://gateway.example.com/anthropic");
	});

	it("keeps the X-JH-Client header on the request", async () => {
		const opts = await drain(gatewayModel, "okta-token");

		const headers = opts.defaultHeaders as Record<string, string>;
		expect(headers["X-JH-Client"]).toBe("gsd-pi");
	});

	it("sends X-JH-Client even when the model carries no headers", async () => {
		const { headers: _omitted, ...withoutHeaders } = gatewayModel;
		const opts = await drain(withoutHeaders as Model<"anthropic-messages">, "okta-token");

		const headers = opts.defaultHeaders as Record<string, string>;
		expect(headers["X-JH-Client"]).toBe("gsd-pi");
	});

	it("tells the user to run claude-ai-gw gw login when no token resolved", () => {
		let message = "";
		try {
			streamSimpleAnthropic(gatewayModel, context, {});
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toContain("claude-ai-gw gw login");
		expect(message).not.toMatch(/no api key/i);
	});

	it("leaves a plain anthropic model on x-api-key auth", async () => {
		const opts = await drain(getModel("anthropic", "claude-sonnet-4-6"), "sk-ant-api-key");

		expect(opts.apiKey).toBe("sk-ant-api-key");
		expect(opts.authToken).toBeNull();
	});
});
