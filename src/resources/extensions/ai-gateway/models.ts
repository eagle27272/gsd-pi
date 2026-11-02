import { getModels } from "@gsd/pi-ai";
import type { ProviderModelConfig } from "@gsd/pi-coding-agent";

const UNKNOWN_CONTEXT_WINDOW = 200_000;
const UNKNOWN_MAX_TOKENS = 64_000;

// Gemini models are listed by the gateway too, but gsd drives them through their own provider.
function isClaude(id: string): boolean {
	return id.startsWith("claude-");
}

export function buildGatewayModels(ids: string[]): ProviderModelConfig[] {
	const catalog = new Map(getModels("anthropic").map((model) => [model.id, model]));

	return ids.filter(isClaude).map((id) => {
		const known = catalog.get(id);
		if (!known) {
			return {
				id,
				name: id,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: UNKNOWN_CONTEXT_WINDOW,
				maxTokens: UNKNOWN_MAX_TOKENS,
			};
		}
		return {
			id,
			name: known.name,
			reasoning: known.reasoning,
			thinkingLevelMap: known.thinkingLevelMap,
			input: known.input.filter((kind): kind is "text" | "image" => kind === "text" || kind === "image"),
			cost: known.cost,
			contextWindow: known.contextWindow,
			maxTokens: known.maxTokens,
			compat: known.compat,
		};
	});
}
