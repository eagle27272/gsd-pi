/**
 * browser-tools — session HAR recording
 *
 * Playwright writes a HAR only when its recorder stops, so the `recordHar`
 * context option can never be read during a live session. We drive the
 * recorder explicitly through `context.tracing.startHar()/stopHar()` instead:
 * each stop writes a segment covering the traffic since the last start, and we
 * merge those segments into one cumulative `session.har`. That keeps
 * `browser_export_har` callable at any point in the session while still
 * exporting the whole session rather than the slice since the last export.
 */

import type { BrowserContext } from "playwright";
import { readFile, writeFile, rm } from "node:fs/promises";
import { getContext, getHarState, setHarState } from "./state.js";

export interface HarDocument {
	log: {
		version?: string;
		creator?: unknown;
		browser?: unknown;
		pages?: unknown[];
		entries?: unknown[];
	};
}

export interface HarFlushResult {
	path: string;
	entries: number;
}

const HAR_RECORDER_OPTIONS = { mode: "minimal", content: "omit" } as const;

/** Scratch file the live recorder writes into before it is merged into the session HAR. */
export function harSegmentPath(sessionHarPath: string): string {
	return `${sessionHarPath}.part`;
}

/** Concatenate `incoming`'s entries (and pages) onto `base`, keeping `base`'s metadata. */
export function mergeHarDocuments(base: HarDocument, incoming: HarDocument): HarDocument {
	const basePages = base.log?.pages;
	const incomingPages = incoming.log?.pages;
	const pages = basePages || incomingPages
		? [...(basePages ?? []), ...(incomingPages ?? [])]
		: undefined;
	return {
		...base,
		log: {
			...base.log,
			...(pages ? { pages } : {}),
			entries: [...(base.log?.entries ?? []), ...(incoming.log?.entries ?? [])],
		},
	};
}

async function readHarDocument(filePath: string): Promise<HarDocument | null> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (err: any) {
		if (err?.code === "ENOENT") return null;
		throw err;
	}
	const parsed = JSON.parse(raw) as HarDocument;
	if (!parsed?.log) throw new Error(`Malformed HAR document at ${filePath}`);
	return parsed;
}

/** Start recording into the segment file for the given session HAR path. */
export async function startSessionHarRecording(context: BrowserContext, sessionHarPath: string): Promise<void> {
	await context.tracing.startHar(harSegmentPath(sessionHarPath), HAR_RECORDER_OPTIONS);
}

/**
 * Stop the live HAR recorder, fold the segment it wrote into the cumulative
 * session HAR, and (unless `resume` is false) start a fresh segment.
 *
 * Returns null when there is nothing to flush — no context, HAR disabled, or
 * no recorder running.
 */
export async function flushSessionHar(options: { resume?: boolean } = {}): Promise<HarFlushResult | null> {
	const context = getContext();
	const harState = getHarState();
	if (!context || !harState.enabled || !harState.recordingActive || !harState.path) return null;

	const sessionHarPath = harState.path;
	const segmentPath = harSegmentPath(sessionHarPath);
	const resume = options.resume !== false;

	await context.tracing.stopHar();
	setHarState({ ...getHarState(), recordingActive: false });

	const segment = await readHarDocument(segmentPath);
	const existing = await readHarDocument(sessionHarPath);
	const merged = segment
		? (existing ? mergeHarDocuments(existing, segment) : segment)
		: existing;
	if (merged) {
		await writeFile(sessionHarPath, JSON.stringify(merged));
		await rm(segmentPath, { force: true });
	}

	if (resume) {
		await startSessionHarRecording(context, sessionHarPath);
		setHarState({ ...getHarState(), recordingActive: true });
	}

	return { path: sessionHarPath, entries: merged?.log?.entries?.length ?? 0 };
}
