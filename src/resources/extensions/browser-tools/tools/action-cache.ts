import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import type { Frame, Page } from "playwright";
import { Type } from "@sinclair/typebox";
import type { ToolDeps } from "../state.js";
import { getPageRegistry } from "../state.js";
import { getActiveFrameContext } from "../utils.js";

/**
 * Action caching — cache semantic intent → selector mappings to skip LLM inference on repeat visits.
 *
 * Agent-driven only: the cache is populated and read via explicit browser_action_cache
 * put/get calls. No other tool writes to or reads from it.
 */

interface CacheEntry {
	selector: string;
	score: number;
	url: string;
	domHash: string;
	timestamp: number;
	hitCount: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 200;

export function registerActionCacheTools(pi: ExtensionAPI, deps: ToolDeps): void {
	// -------------------------------------------------------------------------
	// browser_action_cache
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_action_cache",
		label: "Browser Action Cache",
		description:
			"Manage the action cache that maps page structure + intent → resolved selectors. " +
			"Cache reduces token cost on repeat visits to same pages. " +
			"Actions: 'stats' (show cache metrics), 'get' (lookup cached selector), " +
			"'put' (store a selector mapping), 'clear' (flush cache).",
		parameters: Type.Object({
			action: Type.String({
				description: "Cache action: 'stats', 'get', 'put', or 'clear'.",
			}),
			intent: Type.Optional(
				Type.String({ description: "Semantic intent key (for get/put). E.g., 'submit_form', 'close_dialog'." }),
			),
			selector: Type.Optional(
				Type.String({ description: "CSS selector to cache (for put)." }),
			),
			score: Type.Optional(
				Type.Number({ description: "Confidence score 0–1 for the cached selector (for put)." }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { page: p } = await deps.ensureBrowser();
				const target = deps.getActiveTarget();
				const url = p.url();
				const pageId = getPageRegistry().activePageId;
				const frameContext = getActiveFrameContext();

				switch (params.action) {
					case "stats": {
						const entries = [...cache.values()];
						const totalHits = entries.reduce((sum, e) => sum + e.hitCount, 0);
						return {
							content: [{
								type: "text",
								text: `Action cache: ${cache.size} entries, ${totalHits} total hits\nMax size: ${MAX_CACHE_SIZE}`,
							}],
							details: {
								size: cache.size,
								maxSize: MAX_CACHE_SIZE,
								totalHits,
								entries: entries.map((e) => ({
									url: e.url,
									selector: e.selector,
									hitCount: e.hitCount,
									score: e.score,
								})),
							},
						};
					}

					case "get": {
						if (!params.intent) {
							return {
								content: [{ type: "text", text: "Intent parameter required for 'get' action." }],
								details: { error: "missing_intent" },
								isError: true,
							};
						}

						const domHash = await computeDomHash(target);
						const key = buildCacheKey({ url, domHash, intent: params.intent, pageId, frameContext });
						const entry = cache.get(key);

						if (!entry) {
							return {
								content: [{ type: "text", text: `Cache miss for intent "${params.intent}" on ${url}` }],
								details: { hit: false, intent: params.intent, url },
							};
						}

						// Validate the cached selector still exists
						const exists = await target.locator(entry.selector).first().isVisible().catch(() => false);
						if (!exists) {
							cache.delete(key);
							return {
								content: [{ type: "text", text: `Cache entry stale (selector no longer visible): ${entry.selector}` }],
								details: { hit: false, stale: true, selector: entry.selector },
							};
						}

						entry.hitCount++;
						return {
							content: [{
								type: "text",
								text: `Cache hit: "${params.intent}" → ${entry.selector} (score: ${entry.score}, hits: ${entry.hitCount})`,
							}],
							details: { hit: true, ...entry },
						};
					}

					case "put": {
						if (!params.intent || !params.selector) {
							return {
								content: [{ type: "text", text: "Intent and selector parameters required for 'put' action." }],
								details: { error: "missing_params" },
								isError: true,
							};
						}

						const domHash = await computeDomHash(target);
						const key = buildCacheKey({ url, domHash, intent: params.intent, pageId, frameContext });

						// Evict oldest entries if at capacity
						if (cache.size >= MAX_CACHE_SIZE && !cache.has(key)) {
							const oldestKey = [...cache.entries()]
								.sort(([, a], [, b]) => a.timestamp - b.timestamp)[0]?.[0];
							if (oldestKey) cache.delete(oldestKey);
						}

						const entry: CacheEntry = {
							selector: params.selector,
							score: params.score ?? 1.0,
							url,
							domHash,
							timestamp: Date.now(),
							hitCount: 0,
						};
						cache.set(key, entry);

						return {
							content: [{
								type: "text",
								text: `Cached: "${params.intent}" → ${params.selector} (cache size: ${cache.size})`,
							}],
							details: { stored: true, key, ...entry, cacheSize: cache.size },
						};
					}

					case "clear": {
						const size = cache.size;
						cache.clear();
						return {
							content: [{ type: "text", text: `Action cache cleared (${size} entries removed).` }],
							details: { cleared: size },
						};
					}

					default:
						return {
							content: [{ type: "text", text: `Unknown action: ${params.action}. Use 'stats', 'get', 'put', or 'clear'.` }],
							details: { error: "unknown_action" },
							isError: true,
						};
				}
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Action cache error: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});
}

export interface CacheKeyParts {
	url: string;
	domHash: string;
	intent: string;
	pageId: number | null;
	frameContext: string | undefined;
}

/**
 * A cached selector is only valid for the exact document it was resolved against,
 * so the key carries the tab, the frame and the whole URL. Dropping any of them
 * lets one page's selector be served for another's DOM.
 */
export function buildCacheKey({ url, domHash, intent, pageId, frameContext }: CacheKeyParts): string {
	// The fragment stays in the key: under a hash router #/orders/1 and #/orders/2
	// are different views, and a plain anchor only costs a miss.
	return `${pageId ?? "?"}|${frameContext ?? ""}|${url}|${domHash}|${intent}`;
}

/**
 * Order- and content-sensitive hash of the target's DOM. A tag histogram is not
 * enough: re-rendering [Delete, Save] where [Save, Delete] was leaves it identical
 * while every cached selector now points at the wrong control.
 */
export async function computeDomHash(target: Page | Frame): Promise<string> {
	try {
		return await target.evaluate(() => {
			const parts: string[] = [];
			for (const el of document.querySelectorAll("*")) {
				const directText = Array.from(el.childNodes)
					.filter((n) => n.nodeType === 3)
					.map((n) => n.textContent ?? "")
					.join("")
					.trim()
					.replace(/\s+/g, " ")
					.slice(0, 32);
				parts.push(`${el.tagName}${el.id ? `#${el.id}` : ""}:${directText}`);
			}
			const str = parts.join("|");
			let h = 5381;
			for (let i = 0; i < str.length; i++) {
				h = ((h << 5) - h + str.charCodeAt(i)) | 0;
			}
			return (h >>> 0).toString(16);
		});
	} catch {
		return "unknown";
	}
}
