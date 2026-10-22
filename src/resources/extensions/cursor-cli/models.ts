const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

const CURSOR_INPUT: ("text" | "image")[] = ["text"];

// cursor-agent emits U+200B after some names; String.prototype.trim() does not strip it.
const INVISIBLE_CHARS_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const MILLION_CONTEXT = 1_000_000;
const DEFAULT_CONTEXT = 256_000;
// Families that always have a 1M window but whose Cursor display names omit "1M".
const ALWAYS_MILLION_CONTEXT_ID_RE = /^claude-sonnet-5-5(?:-|$)/;

export type CursorAgentModel = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: typeof ZERO_COST;
	contextWindow: number;
	maxTokens: number;
};

/** Offline fallback when `cursor-agent --list-models` is unavailable (#1869). */
export const CURSOR_AGENT_MODELS: CursorAgentModel[] = [
	model("composer-2.5", "Composer 2.5"),
	model("claude-sonnet-5-thinking-high", "Claude Sonnet 5 1M Thinking"),
	model("claude-opus-5-5-medium", "Claude Opus 5.5 1M"),
	model("gpt-5.6-sol-high", "GPT-5.6 Sol 1M High"),
	model("gemini-3.7-flash-high", "Gemini 3.7 Flash"),
	model("cursor-grok-4.6-high", "Cursor Grok 4.6"),
	model("claude-sonnet-5-5-high", "Claude Sonnet 5.5 High"),
	model("gemini-3.8-flash-high", "Gemini 3.8 Flash High"),
	model("grok-4.7-high", "Grok 4.7 High"),
];

const LIST_LINE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*) - (.+)$/;

function cleanDisplayName(name: string): string {
	return name.replace(INVISIBLE_CHARS_RE, "").replace(/\s+/g, " ").trim();
}

function model(id: string, name: string): CursorAgentModel {
	return cursorAgentModelFromListEntry(id, name);
}

function cursorAgentModelFromListEntry(id: string, name: string): CursorAgentModel {
	const cleanName = cleanDisplayName(name);
	const blob = `${id} ${cleanName}`;
	const hasMillionContext =
		/\b1M\b/i.test(blob) || /1m/i.test(id) || ALWAYS_MILLION_CONTEXT_ID_RE.test(id);
	const contextWindow = hasMillionContext ? MILLION_CONTEXT : DEFAULT_CONTEXT;
	const reasoning =
		/thinking|composer/i.test(blob) ||
		/(?:^|-)(?:none|minimal|low|medium|high|xhigh|extra-high|max)(?:-|$)/i.test(id);
	const display = cleanName.replace(/\s+\(via Cursor\)$/i, "").trim();
	return {
		id,
		name: /via Cursor/i.test(cleanName) ? cleanName : `${display} (via Cursor)`,
		reasoning,
		input: CURSOR_INPUT,
		cost: ZERO_COST,
		contextWindow,
		maxTokens: /opus/i.test(id) ? 128_000 : 64_000,
	};
}

export function parseCursorAgentModelList(output: string): CursorAgentModel[] {
	const models: CursorAgentModel[] = [];
	const seen = new Set<string>();
	for (const raw of output.split(/\r?\n/)) {
		const match = LIST_LINE_RE.exec(raw.trim());
		if (!match) continue;
		const id = match[1]!;
		if (id.includes("[") || seen.has(id)) continue;
		seen.add(id);
		models.push(cursorAgentModelFromListEntry(id, match[2]!.trim()));
	}
	return inheritFastContextWindows(models);
}

/**
 * Cursor labels a base model "GPT-5.5 1M" but its fast tier just "GPT-5.5 Fast".
 * Fast is a speed tier of the same model, so it shares the base context window.
 */
function inheritFastContextWindows(models: CursorAgentModel[]): CursorAgentModel[] {
	const byId = new Map(models.map((m) => [m.id, m]));
	return models.map((m) => {
		if (!m.id.endsWith("-fast")) return m;
		const base = byId.get(m.id.slice(0, -"-fast".length));
		if (!base || base.contextWindow <= m.contextWindow) return m;
		return { ...m, contextWindow: base.contextWindow };
	});
}

export function resolveCursorAgentModels(listOutput: string | null | undefined): CursorAgentModel[] {
	if (!listOutput) return CURSOR_AGENT_MODELS;
	const parsed = parseCursorAgentModelList(listOutput);
	return parsed.length > 0 ? parsed : CURSOR_AGENT_MODELS;
}
