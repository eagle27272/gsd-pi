import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApiProvider } from "../src/api-registry.ts";
import { getModel } from "../src/models.ts";
import { resetApiProviders } from "../src/providers/register-builtins.ts";
import { streamSimple } from "../src/stream.ts";
import type { Model, SimpleStreamOptions } from "../src/types.ts";

// The real client resolves Google credentials on construction; the payload is
// captured before any request is sent, so a bare stand-in is enough.
vi.mock("@anthropic-ai/vertex-sdk", () => ({
	AnthropicVertex: class {},
}));

interface AnthropicThinkingPayload {
	thinking?: { type: string; display?: string };
	output_config?: { effort?: string };
}

class PayloadCaptured extends Error {}

async function captureVertexPayload(
	model: Model<"anthropic-vertex">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let captured: AnthropicThinkingPayload | undefined;
	const s = streamSimple(
		model,
		{ messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
		{
			...options,
			apiKey: "fake-key",
			onPayload: (payload) => {
				captured = payload as AnthropicThinkingPayload;
				throw new PayloadCaptured();
			},
		},
	);
	await s.result();
	if (!captured) throw new Error("Expected payload to be captured before request failure");
	return captured;
}

describe("anthropic-vertex provider", () => {
	it("registers anthropic-vertex as a built-in API provider", () => {
		resetApiProviders();

		const provider = getApiProvider("anthropic-vertex");

		expect(provider).toBeDefined();
		expect(provider?.api).toBe("anthropic-vertex");
	});
});

describe("anthropic-vertex thinking payload", () => {
	beforeEach(() => {
		vi.stubEnv("ANTHROPIC_VERTEX_PROJECT_ID", "test-project");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("omits thinking for Fable 5 when no reasoning level is requested", async () => {
		const payload = await captureVertexPayload(getModel("anthropic-vertex", "claude-fable-5"));

		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toBeUndefined();
	});

	it("sends adaptive thinking at low effort for Fable 5 at minimal reasoning", async () => {
		const payload = await captureVertexPayload(getModel("anthropic-vertex", "claude-fable-5"), {
			reasoning: "minimal",
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "low" });
	});

	it("omits thinking for Opus 5.5 when no reasoning level is requested", async () => {
		const payload = await captureVertexPayload(getModel("anthropic-vertex", "claude-opus-5-5"));

		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toBeUndefined();
	});

	it("sends adaptive thinking at low effort for Opus 5.5 at minimal reasoning", async () => {
		const payload = await captureVertexPayload(getModel("anthropic-vertex", "claude-opus-5-5"), {
			reasoning: "minimal",
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "low" });
	});

	it("still sends thinking.type=disabled for Opus 5 when no reasoning level is requested", async () => {
		const payload = await captureVertexPayload(getModel("anthropic-vertex", "claude-opus-5"));

		expect(payload.thinking).toEqual({ type: "disabled" });
	});
});
