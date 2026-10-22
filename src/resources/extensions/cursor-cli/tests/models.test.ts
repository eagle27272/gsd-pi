import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CURSOR_AGENT_MODELS,
	parseCursorAgentModelList,
	resolveCursorAgentModels,
} from "../models.ts";

const fixture = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "fixtures/cursor-list-models.txt"),
	"utf8",
);

test("parseCursorAgentModelList reads id - Name lines and skips headers (#1869)", () => {
	// Fixture is raw `cursor-agent --list-models` output: header, entries, and tip line.
	const models = parseCursorAgentModelList(fixture);
	assert.ok(models.length > 50);
	assert.ok(models.some((m) => m.id === "composer-2.5"));
	assert.ok(models.some((m) => m.id === "gpt-5.6-sol-high"));
	assert.ok(models.some((m) => m.id === "claude-sonnet-5-thinking-high"));
	assert.ok(models.some((m) => m.id === "gemini-3.7-flash-high"));
	assert.ok(models.some((m) => m.id === "grok-4.7-high"));
	assert.ok(models.some((m) => m.id === "gemini-3.8-flash-high"));
	assert.ok(models.some((m) => m.id === "claude-sonnet-5-5-high"));
	assert.ok(!models.some((m) => /^(Tip|Available)/.test(m.id)));
	assert.ok(!models.some((m) => m.id === "claude-sonnet-4-6"));
	assert.ok(!models.some((m) => m.id === "gpt-5.5"));
	assert.ok(!models.some((m) => m.id.includes("[")));
});

test("every hardcoded fallback ID appears in the --list-models fixture (#1869)", () => {
	const listed = new Set(parseCursorAgentModelList(fixture).map((m) => m.id));
	for (const model of CURSOR_AGENT_MODELS) {
		assert.ok(listed.has(model.id), `fallback id missing from CLI list: ${model.id}`);
	}
});

test("1M naming sets a 1M context window; thinking/effort IDs are reasoning (#1869)", () => {
	const [sol] = parseCursorAgentModelList("gpt-5.6-sol-high - GPT-5.6 Sol 1M High");
	assert.equal(sol?.contextWindow, 1_000_000);
	assert.equal(sol?.reasoning, true);
	const [flash] = parseCursorAgentModelList("gemini-3.7-flash-high - Gemini 3.7 Flash");
	assert.equal(flash?.contextWindow, 256_000);
	assert.equal(flash?.name, "Gemini 3.7 Flash (via Cursor)");
});

test("zero-width characters and repeated spaces never leak into display names", () => {
	const models = parseCursorAgentModelList(fixture);
	for (const m of models) {
		assert.ok(!/[\u200B-\u200D\u2060\uFEFF]/.test(m.name), `invisible char in name: ${m.id}`);
		assert.ok(!/\s{2,}/.test(m.name), `repeated whitespace in name: ${m.id}`);
	}
	const fast = models.find((m) => m.id === "grok-4.7-high-fast");
	assert.equal(fast?.name, "Grok 4.7 High Fast (via Cursor)");
});

test("-fast variants inherit the context window of their base model", () => {
	const models = parseCursorAgentModelList(fixture);
	const byId = new Map(models.map((m) => [m.id, m]));
	// Cursor labels the base "GPT-5.5 1M" but the fast variant just "GPT-5.5 Fast".
	assert.equal(byId.get("gpt-5.5-medium")?.contextWindow, 1_000_000);
	assert.equal(byId.get("gpt-5.5-medium-fast")?.contextWindow, 1_000_000);
	assert.equal(byId.get("gpt-5.4-high-fast")?.contextWindow, 1_000_000);
	// A fast variant with no base entry keeps its own heuristic.
	const [orphan] = parseCursorAgentModelList("foo-high-fast - Foo High Fast");
	assert.equal(orphan?.contextWindow, 256_000);
});

test("every claude-sonnet-5-5 variant has a 1M context window even though Cursor omits '1M' from the name", () => {
	const variants = parseCursorAgentModelList(fixture).filter((m) => m.id.startsWith("claude-sonnet-5-5-"));
	assert.ok(variants.length >= 5, "expected the low..max Sonnet 5.5 variants in the fixture");
	for (const m of variants) {
		assert.equal(m.contextWindow, 1_000_000, `${m.id} should be 1M`);
	}
	// The fallback entry goes through the same path.
	const fallback = CURSOR_AGENT_MODELS.find((m) => m.id === "claude-sonnet-5-5-high");
	assert.equal(fallback?.contextWindow, 1_000_000);
	// Other Sonnet generations are not swept in by the rule.
	const [sonnet4] = parseCursorAgentModelList("claude-sonnet-4-6 - Claude Sonnet 4.6");
	assert.equal(sonnet4?.contextWindow, 256_000);
});

test("-minimal effort tier is treated as reasoning", () => {
	const byId = new Map(parseCursorAgentModelList(fixture).map((m) => [m.id, m]));
	assert.equal(byId.get("muse-spark-1.3-minimal")?.reasoning, true);
	assert.equal(byId.get("gemini-3.6-flash-minimal")?.reasoning, true);
});

test("resolveCursorAgentModels falls back when CLI output is empty (#1869)", () => {
	assert.equal(resolveCursorAgentModels(null), CURSOR_AGENT_MODELS);
	assert.equal(resolveCursorAgentModels(""), CURSOR_AGENT_MODELS);
	assert.equal(resolveCursorAgentModels("Available models\n"), CURSOR_AGENT_MODELS);
	const discovered = resolveCursorAgentModels("kimi-k3 - Kimi K3");
	assert.equal(discovered.length, 1);
	assert.equal(discovered[0]?.id, "kimi-k3");
});
