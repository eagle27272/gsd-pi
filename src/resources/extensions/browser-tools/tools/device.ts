import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ToolDeps } from "../state.js";

/**
 * Device emulation tool — full device simulation using Playwright's built-in device descriptors.
 */

export type DeviceMatch =
	| { kind: "match"; name: string; alternatives: string[] }
	| { kind: "no_match"; suggestions: string[] };

/**
 * Resolve a user-supplied device name against Playwright's descriptor names.
 *
 * Exact (case-insensitive) wins; otherwise a substring search picks the
 * shortest hit as the most specific one and reports what else it could have
 * meant, so "pixel" does not silently resolve to one of a dozen variants.
 */
export function resolveDeviceMatch(device: string, allDeviceNames: string[]): DeviceMatch {
	const needle = device.toLowerCase();

	const exact = allDeviceNames.find((n) => n.toLowerCase() === needle);
	if (exact) return { kind: "match", name: exact, alternatives: [] };

	const containsMatches = allDeviceNames
		.filter((n) => n.toLowerCase().includes(needle))
		.sort((a, b) => a.length - b.length || a.localeCompare(b));
	if (containsMatches.length > 0) {
		return {
			kind: "match",
			name: containsMatches[0],
			alternatives: containsMatches.slice(1, 6),
		};
	}

	const suggestions = allDeviceNames
		.map((n) => ({ name: n, score: fuzzyScore(needle, n.toLowerCase()) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, 5)
		.map((s) => s.name);
	return { kind: "no_match", suggestions };
}

export function registerDeviceTools(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerTool({
		name: "browser_emulate_device",
		label: "Browser Emulate Device",
		description:
			"Simulate a specific device by setting viewport, user agent, device scale factor, touch, and mobile flag. " +
			"Uses Playwright's built-in device descriptors (~143 devices). Accepts fuzzy matching on device name. " +
			"Note: Full emulation (user agent, isMobile) requires a context restart — the current page state will be lost. " +
			"The tool recreates the context with the device profile applied.",
		parameters: Type.Object({
			device: Type.String({
				description:
					"Device name (e.g., 'iPhone 15', 'Pixel 7', 'iPad Pro 11'). " +
					"Case-insensitive fuzzy matching. Use 'list' to see all available devices.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const { devices } = await import("playwright");
				const allDeviceNames = Object.keys(devices);

				// Handle 'list' request
				if (params.device.toLowerCase() === "list") {
					// Group by base device name (remove landscape variants for cleaner display)
					const baseNames = allDeviceNames.filter((n) => !n.endsWith(" landscape"));
					return {
						content: [{
							type: "text",
							text: `Available devices (${allDeviceNames.length} total, ${baseNames.length} base):\n${baseNames.join("\n")}`,
						}],
						details: { devices: baseNames, total: allDeviceNames.length },
					};
				}

				const match = resolveDeviceMatch(params.device, allDeviceNames);
				if (match.kind === "no_match") {
					return {
						content: [{
							type: "text",
							text: `No device matching "${params.device}". Did you mean:\n${match.suggestions.map((s) => `  - ${s}`).join("\n")}`,
						}],
						details: { error: "no_match", suggestions: match.suggestions },
						isError: true,
					};
				}

				const deviceDescriptor = devices[match.name];
				if (!deviceDescriptor) {
					return {
						content: [{ type: "text", text: `Device descriptor not found for "${match.name}"` }],
						details: { error: "descriptor_not_found" },
						isError: true,
					};
				}

				// Context restart required for full emulation.
				// Save current URL to navigate back after restart.
				const { page: currentPage } = await deps.ensureBrowser();
				const currentUrl = currentPage.url();

				// Close existing browser and relaunch with the device profile layered
				// over the standard session setup (HAR recording, artifact dir, init
				// script, popup registration) rather than a hand-rolled copy of it.
				await deps.closeBrowser();
				const { page } = await deps.createBrowserSession({ ...deviceDescriptor });

				// Navigate back to previous URL if it wasn't about:blank
				if (currentUrl && currentUrl !== "about:blank") {
					await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch((e) => { if (process.env.GSD_DEBUG) console.error("[browser-tools] device goto restore failed:", e.message); });
				}

				const viewport = deviceDescriptor.viewport;
				const vpText = viewport ? `${viewport.width}x${viewport.height}` : "unknown";
				const alternativesText = match.alternatives.length > 0
					? `\nAlso matched "${params.device}": ${match.alternatives.join(", ")}`
					: "";

				return {
					content: [{
						type: "text",
						text: `Device emulation active: ${match.name}${alternativesText}\nViewport: ${vpText}\nUser Agent: ${deviceDescriptor.userAgent?.slice(0, 80) ?? "default"}...\nMobile: ${deviceDescriptor.isMobile ?? false}\nTouch: ${deviceDescriptor.hasTouch ?? false}\nScale Factor: ${deviceDescriptor.deviceScaleFactor ?? 1}\n\nContext was restarted for full emulation. Page state was reset.`,
					}],
					details: {
						device: match.name,
						alternatives: match.alternatives,
						viewport: vpText,
						isMobile: deviceDescriptor.isMobile ?? false,
						hasTouch: deviceDescriptor.hasTouch ?? false,
						deviceScaleFactor: deviceDescriptor.deviceScaleFactor ?? 1,
						userAgent: deviceDescriptor.userAgent,
						restoredUrl: currentUrl,
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Device emulation failed: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}
		},
	});
}

/**
 * Simple fuzzy scoring — counts matching characters in order.
 */
function fuzzyScore(needle: string, haystack: string): number {
	let score = 0;
	let hi = 0;
	for (let ni = 0; ni < needle.length && hi < haystack.length; ni++) {
		const idx = haystack.indexOf(needle[ni], hi);
		if (idx >= 0) {
			score++;
			hi = idx + 1;
		}
	}
	return score / Math.max(needle.length, 1);
}
