/**
 * browser-tools — browser lifecycle management
 *
 * Manages the shared Browser + BrowserContext + Page singleton.
 * Injects EVALUATE_HELPERS_SOURCE via context.addInitScript() so that
 * page.evaluate() callbacks can reference window.__pi.* utilities.
 */

import type {
	Browser,
	BrowserContext,
	BrowserContextOptions,
	BrowserType,
	Frame,
	LaunchOptions,
	Page,
} from "playwright";
import path from "node:path";
import {
	registryAddPage,
	registryGetActive,
	registryRemovePage,
	registrySetActive,
} from "./core.js";
import {
	getBrowser,
	setBrowser,
	getContext,
	setContext,
	pageRegistry,
	getActiveFrame,
	setActiveFrame,
	logPusher,
	getConsoleLogs,
	getNetworkLogs,
	getDialogLogs,
	getPendingCriticalRequestsByPage,
	setHarState,
	resetAllState,
	HAR_FILENAME,
	type NetworkEntry,
} from "./state.js";
import {
	isCriticalResourceType,
	updatePendingCriticalRequests,
	ensureSessionStartedAt,
	ensureSessionArtifactDir,
	firstErrorLine,
} from "./utils.js";
import { EVALUATE_HELPERS_SOURCE } from "./evaluate-helpers.js";
import { flushSessionHar, startSessionHarRecording } from "./har.js";

export { flushSessionHar } from "./har.js";

// ---------------------------------------------------------------------------
// Page event wiring
// ---------------------------------------------------------------------------

/** Attach all event listeners to a page. Called on initial page and new tabs. */
export function attachPageListeners(p: Page, pageId: number): void {
	const pendingMap = getPendingCriticalRequestsByPage();
	pendingMap.set(p, 0);

	const consoleLogs = getConsoleLogs();
	const networkLogs = getNetworkLogs();
	const dialogLogs = getDialogLogs();

	// Console messages
	p.on("console", (msg) => {
		logPusher(consoleLogs, {
			type: msg.type(),
			text: msg.text(),
			timestamp: Date.now(),
			url: p.url(),
			pageId,
		});
	});

	// Uncaught JS errors
	p.on("pageerror", (err) => {
		logPusher(consoleLogs, {
			type: "pageerror",
			text: err.message,
			timestamp: Date.now(),
			url: p.url(),
			pageId,
		});
	});

	// Network requests — start/completed/failed
	p.on("request", (request) => {
		if (isCriticalResourceType(request.resourceType())) {
			updatePendingCriticalRequests(p, 1);
		}
	});

	p.on("requestfinished", async (request) => {
		if (isCriticalResourceType(request.resourceType())) {
			updatePendingCriticalRequests(p, -1);
		}
		try {
			const response = await request.response();
			const status = response?.status() ?? null;
			const entry: NetworkEntry = {
				method: request.method(),
				url: request.url(),
				status,
				resourceType: request.resourceType(),
				timestamp: Date.now(),
				failed: false,
				pageId,
			};
			if (response && status !== null && status >= 400) {
				try {
					const body = await response.text();
					entry.responseBody = body.slice(0, 2000);
				} catch { /* non-fatal — response body may be unavailable or already consumed */ }
			}
			logPusher(networkLogs, entry);
		} catch { /* non-fatal — request may have been aborted or page closed */ }
	});

	p.on("requestfailed", (request) => {
		if (isCriticalResourceType(request.resourceType())) {
			updatePendingCriticalRequests(p, -1);
		}
		logPusher(networkLogs, {
			method: request.method(),
			url: request.url(),
			status: null,
			resourceType: request.resourceType(),
			timestamp: Date.now(),
			failed: true,
			failureText: request.failure()?.errorText ?? "Unknown failure",
			pageId,
		});
	});

	// Auto-handle JS dialogs (alert, confirm, prompt, beforeunload)
	p.on("dialog", async (dialog) => {
		logPusher(dialogLogs, {
			type: dialog.type(),
			message: dialog.message(),
			timestamp: Date.now(),
			url: p.url(),
			defaultValue: dialog.defaultValue() || undefined,
			accepted: true,
			pageId,
		});
		// Auto-accept all dialogs to prevent page freezes
		await dialog.accept().catch(() => { /* cleanup — dialog may already be dismissed */ });
	});

	// Frame detach handler — clears activeFrame if the selected frame detaches
	p.on("framedetached", (frame) => {
		if (getActiveFrame() === frame) setActiveFrame(null);
	});

	// Page close handler — removes page from registry and handles active fallback
	p.on("close", () => {
		try {
			registryRemovePage(pageRegistry, pageId);
		} catch {
			// Page already removed (e.g. during closeBrowser)
		}
	});
}

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

export interface BrowserSession {
	browser: Browser;
	context: BrowserContext;
	page: Page;
}

/** The slice of playwright's `chromium` that session construction needs. */
export type BrowserLauncher = Pick<BrowserType, "launch">;

function browserLaunchOptions(): LaunchOptions {
	// Auto-detect headless environments: Linux without $DISPLAY has no GUI.
	// All browser tool operations (navigation, screenshots, DOM) work in headless mode.
	const needsHeadless = process.platform === "linux" && !process.env.DISPLAY;
	const options: LaunchOptions = {
		headless: needsHeadless || process.env.FORCE_HEADLESS === "true",
	};
	const customPath = process.env.BROWSER_PATH;
	if (customPath) options.executablePath = customPath;
	return options;
}

/**
 * Build a browser, context and first page without touching shared state.
 *
 * Nothing here is published, so a caller that never reaches
 * `commitBrowserSession` leaves the session cleanly closed. Any step after
 * `launch` can fail, and the browser is closed on the way out — otherwise the
 * Chromium process outlives the call with no reference left to close it.
 */
export async function buildBrowserSession(
	launcher: BrowserLauncher,
	contextOptions: BrowserContextOptions,
	harPath: string,
): Promise<BrowserSession> {
	const browser = await launcher.launch(browserLaunchOptions());
	try {
		const context = await browser.newContext({
			deviceScaleFactor: 2,
			viewport: { width: 1280, height: 800 },
			...contextOptions,
		});

		// Inject shared browser-side utilities into every new page/frame
		await context.addInitScript(EVALUATE_HELPERS_SOURCE);

		// Deliberately not the `recordHar` context option: that only writes when
		// the context closes, so nothing could ever export a HAR mid-session.
		await startSessionHarRecording(context, harPath);

		const page = await context.newPage();
		return { browser, context, page };
	} catch (err) {
		await browser.close().catch(() => { /* cleanup — partially built session */ });
		throw err;
	}
}

/**
 * Publish a fully built session to shared state.
 *
 * Runs only once every fallible step of `buildBrowserSession` has succeeded:
 * `ensureBrowser`'s fast path treats a non-null browser + context as a usable
 * session, so committing before the first page exists would leave
 * `pageRegistry` empty and every later tool call throwing "no active page".
 */
export async function commitBrowserSession(session: BrowserSession, harPath: string): Promise<void> {
	const { browser, context, page } = session;
	const title = await page.title().catch(() => "");

	setBrowser(browser);
	setContext(context);
	setHarState({
		enabled: true,
		configuredAtContextCreation: true,
		// buildBrowserSession started the recorder on this context.
		recordingActive: true,
		path: harPath,
		exportCount: 0,
		lastExportedPath: null,
		lastExportedAt: null,
	});

	const pageEntry = registryAddPage(pageRegistry, {
		page,
		title,
		url: page.url(),
		opener: null,
	});
	registrySetActive(pageRegistry, pageEntry.id);
	attachPageListeners(page, pageEntry.id);

	// Register new pages (popups, target="_blank", window.open) but do NOT auto-switch
	context.on("page", (newPage) => {
		// Determine opener page ID — find which registry page opened this one
		const openerPage = newPage.opener();
		let openerId: number | null = null;
		if (openerPage) {
			const openerEntry = pageRegistry.pages.find((e: any) => e.page === openerPage);
			if (openerEntry) openerId = openerEntry.id;
		}
		const entry = registryAddPage(pageRegistry, {
			page: newPage,
			title: "",
			url: newPage.url(),
			opener: openerId,
		});
		attachPageListeners(newPage, entry.id);
		// Update title once loaded
		newPage.waitForLoadState("domcontentloaded", { timeout: 5000 })
			.then(() => newPage.title())
			.then((title) => { entry.title = title; })
			.catch(() => { /* best-effort title fetch — page may have closed or navigated away */ });
	});
}

/**
 * Start a fresh session and make it the active one.
 *
 * `contextOptions` overlays the desktop defaults (device emulation passes a
 * playwright device descriptor); HAR recording and the session artifact dir
 * are established here so every entry point gets them, not just `ensureBrowser`.
 */
export async function createBrowserSession(contextOptions: BrowserContextOptions = {}): Promise<BrowserSession> {
	ensureSessionStartedAt();
	const artifactDir = await ensureSessionArtifactDir();
	const sessionHarPath = path.join(artifactDir, HAR_FILENAME);

	// Lazy import so playwright is only loaded when actually needed
	const { chromium } = await import("playwright");

	const session = await buildBrowserSession(chromium, contextOptions, sessionHarPath);
	await commitBrowserSession(session, sessionHarPath);
	return session;
}

export async function ensureBrowser(): Promise<BrowserSession> {
	const existingBrowser = getBrowser();
	const existingContext = getContext();
	if (existingBrowser && existingContext) {
		return { browser: existingBrowser, context: existingContext, page: getActivePage() };
	}
	return createBrowserSession();
}

/** Get the currently active page from the registry. */
export function getActivePage(): Page {
	return registryGetActive(pageRegistry).page;
}

/** Get the active target — returns the selected frame if one is active, otherwise the active page. */
export function getActiveTarget(): Page | Frame {
	return getActiveFrame() ?? getActivePage();
}

/** Safe accessor for error handling — returns the active page or null if unavailable. */
export function getActivePageOrNull(): Page | null {
	try {
		return getActivePage();
	} catch {
		return null;
	}
}

export async function closeBrowser(): Promise<void> {
	const context = getContext();
	if (context) {
		// Flush before closing: once the context is gone the recorder is gone
		// with it, and the session HAR would never reach disk.
		await flushSessionHar({ resume: false }).catch((err) => {
			if (process.env.GSD_DEBUG) console.error("[browser-tools] session HAR flush failed:", firstErrorLine(err));
		});
		await context.close().catch(() => { /* cleanup — context may already be closed */ });
	}
	const browser = getBrowser();
	if (browser) {
		await browser.close().catch(() => { /* cleanup — browser may already be closed */ });
	}
	resetAllState();
}
