/**
 * browser-tools — Node-side unit tests
 *
 * Uses jiti for TypeScript imports (the resolve-ts ESM hook breaks on core.js),
 * node:test for the runner, and node:assert/strict for assertions.
 *
 * Tests pure functions from utils.ts, state.ts accessors, evaluate-helpers.ts
 * syntax, and constrainScreenshot from capture.ts.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const jiti = require("jiti")(__filename, { interopDefault: true, debug: false });

// ---------------------------------------------------------------------------
// Module imports via jiti
// ---------------------------------------------------------------------------

const {
	parseRef,
	formatVersionedRef,
	staleRefGuidance,
	formatCompactStateSummary,
	verificationFromChecks,
	verificationLine,
	sanitizeArtifactName,
	isCriticalResourceType,
	getUrlHash,
	firstErrorLine,
	formatArtifactTimestamp,
	ensureSessionArtifactDir,
	getActiveFrameContext,
	getActiveSubFrame,
	validateRefForAction,
	clampElementLimit,
} = jiti("../utils.js");

const {
	getArtifactRoot,
	setArtifactRootForCwd,
	getBrowser,
	setBrowser,
	getContext,
	setContext,
	getActiveFrame,
	setActiveFrame,
	getSessionStartedAt,
	setSessionStartedAt,
	getSessionArtifactDir,
	setSessionArtifactDir,
	getCurrentRefMap,
	setCurrentRefMap,
	getRefVersion,
	setRefVersion,
	getRefMetadata,
	setRefMetadata,
	getRefSnapshotFrame,
	setRefSnapshotFrame,
	getLastActionBeforeState,
	setLastActionBeforeState,
	getLastActionAfterState,
	setLastActionAfterState,
	resetAllState,
} = jiti("../state.js");

const { evaluateAssertionChecks } = jiti("../core.js");

const { EVALUATE_HELPERS_SOURCE } = jiti("../evaluate-helpers.js");

const { constrainScreenshot } = jiti("../capture.js");

// ---------------------------------------------------------------------------
// utils.ts — parseRef
// ---------------------------------------------------------------------------

describe("parseRef", () => {
	it("parses a valid versioned ref", () => {
		const result = parseRef("@v3:e12");
		assert.deepStrictEqual(result, {
			key: "e12",
			version: 3,
			display: "@v3:e12",
		});
	});

	it("parses a ref without leading @", () => {
		const result = parseRef("v1:e5");
		assert.deepStrictEqual(result, {
			key: "e5",
			version: 1,
			display: "@v1:e5",
		});
	});

	it("handles legacy (unversioned) format", () => {
		const result = parseRef("@e7");
		assert.deepStrictEqual(result, {
			key: "e7",
			version: null,
			display: "@e7",
		});
	});

	it("trims whitespace", () => {
		const result = parseRef("  @v2:e1  ");
		assert.equal(result.key, "e1");
		assert.equal(result.version, 2);
	});

	it("is case-insensitive", () => {
		const result = parseRef("@V10:E3");
		assert.equal(result.key, "e3");
		assert.equal(result.version, 10);
	});
});

// ---------------------------------------------------------------------------
// utils.ts — formatVersionedRef
// ---------------------------------------------------------------------------

describe("formatVersionedRef", () => {
	it("formats a versioned ref string", () => {
		assert.equal(formatVersionedRef(5, "e3"), "@v5:e3");
	});

	it("formats version 0", () => {
		assert.equal(formatVersionedRef(0, "e1"), "@v0:e1");
	});
});

// ---------------------------------------------------------------------------
// utils.ts — staleRefGuidance
// ---------------------------------------------------------------------------

describe("staleRefGuidance", () => {
	it("includes the ref display and reason", () => {
		const result = staleRefGuidance("@v2:e5", "element removed");
		assert.ok(result.includes("@v2:e5"));
		assert.ok(result.includes("element removed"));
		assert.ok(result.includes("browser_snapshot_refs"));
	});
});

// ---------------------------------------------------------------------------
// utils.ts — formatCompactStateSummary
// ---------------------------------------------------------------------------

describe("formatCompactStateSummary", () => {
	it("formats a compact page state into a readable summary", () => {
		/** @type {import('../state.ts').CompactPageState} */
		const mockState = {
			url: "http://localhost:3000/dashboard",
			title: "Dashboard",
			focus: "input#search",
			headings: ["Welcome", "Recent Activity"],
			bodyText: "",
			counts: {
				landmarks: 3,
				buttons: 5,
				links: 12,
				inputs: 2,
			},
			dialog: { count: 0, title: "" },
			selectorStates: {},
		};

		const summary = formatCompactStateSummary(mockState);
		assert.ok(summary.includes("Title: Dashboard"));
		assert.ok(summary.includes("URL: http://localhost:3000/dashboard"));
		assert.ok(summary.includes("3 landmarks"));
		assert.ok(summary.includes("5 buttons"));
		assert.ok(summary.includes("12 links"));
		assert.ok(summary.includes("2 inputs"));
		assert.ok(summary.includes("Focused: input#search"));
		assert.ok(summary.includes('H1 "Welcome"'));
		assert.ok(summary.includes('H2 "Recent Activity"'));
	});

	it("omits focus line when empty", () => {
		const mockState = {
			url: "http://example.com",
			title: "Test",
			focus: "",
			headings: [],
			bodyText: "",
			counts: { landmarks: 0, buttons: 0, links: 0, inputs: 0 },
			dialog: { count: 0, title: "" },
			selectorStates: {},
		};
		const summary = formatCompactStateSummary(mockState);
		assert.ok(!summary.includes("Focused:"));
	});

	it("includes dialog title when present", () => {
		const mockState = {
			url: "http://example.com",
			title: "Test",
			focus: "",
			headings: [],
			bodyText: "",
			counts: { landmarks: 0, buttons: 0, links: 0, inputs: 0 },
			dialog: { count: 1, title: "Confirm Delete" },
			selectorStates: {},
		};
		const summary = formatCompactStateSummary(mockState);
		assert.ok(summary.includes('Active dialog: "Confirm Delete"'));
	});
});

// ---------------------------------------------------------------------------
// utils.ts — verificationFromChecks
// ---------------------------------------------------------------------------

describe("verificationFromChecks", () => {
	it("returns verified=true when at least one check passes", () => {
		const checks = [
			{ name: "url_changed", passed: true },
			{ name: "title_changed", passed: false },
		];
		const result = verificationFromChecks(checks);
		assert.equal(result.verified, true);
		assert.ok(result.verificationSummary.includes("PASS"));
		assert.ok(result.verificationSummary.includes("url_changed"));
		assert.equal(result.retryHint, undefined);
	});

	it("returns verified=false when no checks pass", () => {
		const checks = [
			{ name: "url_changed", passed: false },
			{ name: "title_changed", passed: false },
		];
		const result = verificationFromChecks(checks, "try clicking again");
		assert.equal(result.verified, false);
		assert.ok(result.verificationSummary.includes("SOFT-FAIL"));
		assert.equal(result.retryHint, "try clicking again");
	});

	it("lists multiple passing checks", () => {
		const checks = [
			{ name: "a", passed: true },
			{ name: "b", passed: true },
		];
		const result = verificationFromChecks(checks);
		assert.ok(result.verificationSummary.includes("a"));
		assert.ok(result.verificationSummary.includes("b"));
	});
});

// ---------------------------------------------------------------------------
// utils.ts — verificationLine
// ---------------------------------------------------------------------------

describe("verificationLine", () => {
	it("formats a verification result into a single line", () => {
		const result = {
			verified: true,
			checks: [],
			verificationSummary: "PASS (url_changed)",
		};
		const line = verificationLine(result);
		assert.equal(line, "Verification: PASS (url_changed)");
	});
});

// ---------------------------------------------------------------------------
// utils.ts — sanitizeArtifactName
// ---------------------------------------------------------------------------

describe("sanitizeArtifactName", () => {
	it("passes through valid names", () => {
		assert.equal(sanitizeArtifactName("my-trace", "default"), "my-trace");
	});

	it("replaces special characters with hyphens", () => {
		assert.equal(sanitizeArtifactName("hello world!@#", "default"), "hello-world");
	});

	it("strips leading/trailing hyphens", () => {
		assert.equal(sanitizeArtifactName("  --foo--  ", "default"), "foo");
	});

	it("returns fallback for empty string", () => {
		assert.equal(sanitizeArtifactName("", "fallback"), "fallback");
	});

	it("returns fallback for whitespace-only string", () => {
		assert.equal(sanitizeArtifactName("   ", "fallback"), "fallback");
	});

	it("returns fallback for all-special-chars string", () => {
		assert.equal(sanitizeArtifactName("@#$%", "default"), "default");
	});

	it("preserves dots and underscores", () => {
		assert.equal(sanitizeArtifactName("file_name.ext", "default"), "file_name.ext");
	});
});

// ---------------------------------------------------------------------------
// utils.ts — isCriticalResourceType
// ---------------------------------------------------------------------------

describe("isCriticalResourceType", () => {
	it("returns true for document", () => {
		assert.equal(isCriticalResourceType("document"), true);
	});

	it("returns true for fetch", () => {
		assert.equal(isCriticalResourceType("fetch"), true);
	});

	it("returns true for xhr", () => {
		assert.equal(isCriticalResourceType("xhr"), true);
	});

	it("returns false for image", () => {
		assert.equal(isCriticalResourceType("image"), false);
	});

	it("returns false for font", () => {
		assert.equal(isCriticalResourceType("font"), false);
	});

	it("returns false for stylesheet", () => {
		assert.equal(isCriticalResourceType("stylesheet"), false);
	});

	it("returns false for script", () => {
		assert.equal(isCriticalResourceType("script"), false);
	});
});

// ---------------------------------------------------------------------------
// utils.ts — getUrlHash
// ---------------------------------------------------------------------------

describe("getUrlHash", () => {
	it("returns the hash from a URL", () => {
		assert.equal(getUrlHash("http://example.com/page#section"), "#section");
	});

	it("returns empty string when no hash", () => {
		assert.equal(getUrlHash("http://example.com/page"), "");
	});

	it("returns empty string for invalid URL", () => {
		assert.equal(getUrlHash("not-a-url"), "");
	});
});

// ---------------------------------------------------------------------------
// utils.ts — firstErrorLine
// ---------------------------------------------------------------------------

describe("firstErrorLine", () => {
	it("extracts first line from an Error", () => {
		const err = new Error("line1\nline2\nline3");
		assert.equal(firstErrorLine(err), "line1");
	});

	it("handles string errors", () => {
		assert.equal(firstErrorLine("something broke"), "something broke");
	});

	it("handles null/undefined", () => {
		assert.equal(firstErrorLine(null), "unknown error");
		assert.equal(firstErrorLine(undefined), "unknown error");
	});

	it("handles objects without message property", () => {
		// {} has no .message, so falls to String({}) = "[object Object]"
		assert.equal(firstErrorLine({}), "[object Object]");
	});

	it("handles objects with empty message", () => {
		assert.equal(firstErrorLine({ message: "" }), "unknown error");
	});
});

// ---------------------------------------------------------------------------
// utils.ts — formatArtifactTimestamp
// ---------------------------------------------------------------------------

describe("formatArtifactTimestamp", () => {
	it("formats a timestamp into an ISO-like string with dashes", () => {
		// 2024-01-15T10:30:45.123Z
		const ts = new Date("2024-01-15T10:30:45.123Z").getTime();
		const result = formatArtifactTimestamp(ts);
		// Should replace colons and dots with dashes
		assert.ok(!result.includes(":"));
		assert.ok(!result.includes("."));
		assert.ok(result.includes("2024-01-15"));
	});
});

// ---------------------------------------------------------------------------
// evaluate-helpers.ts — EVALUATE_HELPERS_SOURCE
// ---------------------------------------------------------------------------

describe("EVALUATE_HELPERS_SOURCE", () => {
	// Behaviour test: executing the source in a Node vm sandbox must
	// populate a `window.__pi` namespace with every expected helper.
	// No source grep — we actually run the code and verify the resulting
	// object shape.
	it("executing the source assigns all expected helpers to window.__pi", () => {
		const vm = require("node:vm");
		const expectedFunctions = [
			"cssPath",
			"simpleHash",
			"isVisible",
			"isEnabled",
			"inferRole",
			"accessibleName",
			"isInteractiveEl",
			"domPath",
			"selectorHints",
		];

		// Playwright evaluates the source in a page context where `window`
		// exists, so the helpers attach to `window.__pi`. Provide a minimal
		// window stub in a vm context so we avoid polluting the test globals.
		const sandbox = { window: {} };
		const script = new vm.Script(EVALUATE_HELPERS_SOURCE);
		script.runInNewContext(sandbox, { timeout: 1000 });

		assert.ok(
			sandbox.window.__pi && typeof sandbox.window.__pi === "object",
			"executing EVALUATE_HELPERS_SOURCE must assign window.__pi",
		);

		for (const fnName of expectedFunctions) {
			assert.equal(
				typeof sandbox.window.__pi[fnName],
				"function",
				`window.__pi.${fnName} must be a function after executing the source`,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// state.ts — accessor round-trips
// ---------------------------------------------------------------------------

describe("state accessors", () => {
	beforeEach(() => {
		resetAllState();
	});

	it("setBrowser/getBrowser round-trip", () => {
		assert.equal(getBrowser(), null);
		const fakeBrowser = { close: () => {} };
		setBrowser(fakeBrowser);
		assert.equal(getBrowser(), fakeBrowser);
	});

	it("setContext/getContext round-trip", () => {
		assert.equal(getContext(), null);
		const fakeContext = { newPage: () => {} };
		setContext(fakeContext);
		assert.equal(getContext(), fakeContext);
	});

	it("setActiveFrame/getActiveFrame round-trip", () => {
		assert.equal(getActiveFrame(), null);
		const fakeFrame = { name: () => "test" };
		setActiveFrame(fakeFrame);
		assert.equal(getActiveFrame(), fakeFrame);
	});

	it("setSessionStartedAt/getSessionStartedAt round-trip", () => {
		assert.equal(getSessionStartedAt(), null);
		setSessionStartedAt(1234567890);
		assert.equal(getSessionStartedAt(), 1234567890);
	});

	it("setSessionArtifactDir/getSessionArtifactDir round-trip", () => {
		assert.equal(getSessionArtifactDir(), null);
		setSessionArtifactDir("/tmp/artifacts");
		assert.equal(getSessionArtifactDir(), "/tmp/artifacts");
	});

	it("uses the active tool context cwd for session artifact paths", async (t) => {
		const processRoot = mkdtempSync(join(tmpdir(), "browser-tools-process-"));
		const contextRoot = mkdtempSync(join(tmpdir(), "browser-tools-context-"));
		const previousCwd = process.cwd();
		t.after(() => {
			process.chdir(previousCwd);
			rmSync(processRoot, { recursive: true, force: true });
			rmSync(contextRoot, { recursive: true, force: true });
		});

		process.chdir(processRoot);
		resetAllState();
		const expectedRoot = join(contextRoot, ".artifacts", "browser");
		setArtifactRootForCwd(contextRoot);

		const sessionDir = await ensureSessionArtifactDir();

		assert.equal(getArtifactRoot(), expectedRoot);
		assert.ok(
			sessionDir.startsWith(`${expectedRoot}/`),
			`session artifact dir should stay under context cwd: ${sessionDir}`,
		);
		assert.ok(
			!sessionDir.startsWith(join(processRoot, ".artifacts", "browser")),
			`session artifact dir must not use process cwd: ${sessionDir}`,
		);
	});

	it("session artifact dir is recomputed when artifact root changes", async (t) => {
		const root1 = mkdtempSync(join(tmpdir(), "browser-tools-root1-"));
		const root2 = mkdtempSync(join(tmpdir(), "browser-tools-root2-"));
		t.after(() => {
			rmSync(root1, { recursive: true, force: true });
			rmSync(root2, { recursive: true, force: true });
		});

		resetAllState();
		setArtifactRootForCwd(root1);
		const sessionDir1 = await ensureSessionArtifactDir();
		assert.ok(sessionDir1.startsWith(join(root1, ".artifacts", "browser")));

		// Change the root — cached session dir must be invalidated
		setArtifactRootForCwd(root2);
		const sessionDir2 = await ensureSessionArtifactDir();
		assert.ok(
			sessionDir2.startsWith(join(root2, ".artifacts", "browser")),
			`session dir should be under new root after root change: ${sessionDir2}`,
		);
		assert.notEqual(sessionDir1, sessionDir2, "session dir must differ after root change");
	});

	it("setCurrentRefMap/getCurrentRefMap round-trip", () => {
		assert.deepStrictEqual(getCurrentRefMap(), {});
		const refMap = { e1: { ref: "e1", tag: "button" } };
		setCurrentRefMap(refMap);
		assert.deepStrictEqual(getCurrentRefMap(), refMap);
	});

	it("setRefVersion/getRefVersion round-trip", () => {
		assert.equal(getRefVersion(), 0);
		setRefVersion(5);
		assert.equal(getRefVersion(), 5);
	});

	it("setRefMetadata/getRefMetadata round-trip", () => {
		assert.equal(getRefMetadata(), null);
		const metadata = { url: "http://test.com", timestamp: 123, interactiveOnly: true, limit: 40, version: 1 };
		setRefMetadata(metadata);
		assert.deepStrictEqual(getRefMetadata(), metadata);
	});

	it("setLastActionBeforeState/getLastActionBeforeState round-trip", () => {
		assert.equal(getLastActionBeforeState(), null);
		const state = { url: "http://test.com", title: "Test", focus: "", headings: [], bodyText: "", counts: { landmarks: 0, buttons: 0, links: 0, inputs: 0 }, dialog: { count: 0, title: "" }, selectorStates: {} };
		setLastActionBeforeState(state);
		assert.deepStrictEqual(getLastActionBeforeState(), state);
	});

	it("setLastActionAfterState/getLastActionAfterState round-trip", () => {
		assert.equal(getLastActionAfterState(), null);
		const state = { url: "http://test.com/after", title: "After", focus: "", headings: [], bodyText: "", counts: { landmarks: 0, buttons: 0, links: 0, inputs: 0 }, dialog: { count: 0, title: "" }, selectorStates: {} };
		setLastActionAfterState(state);
		assert.deepStrictEqual(getLastActionAfterState(), state);
	});
});

// ---------------------------------------------------------------------------
// state.ts — resetAllState
// ---------------------------------------------------------------------------

describe("resetAllState", () => {
	it("clears all state back to defaults", () => {
		// Set various state values
		setBrowser({ close: () => {} });
		setContext({ newPage: () => {} });
		setActiveFrame({ name: () => "frame" });
		setSessionStartedAt(9999);
		setSessionArtifactDir("/tmp/test");
		setCurrentRefMap({ e1: {} });
		setRefVersion(10);
		setRefMetadata({ url: "http://x", timestamp: 1, interactiveOnly: true, limit: 40, version: 1 });
		setLastActionBeforeState({ url: "before" });
		setLastActionAfterState({ url: "after" });

		// Reset
		resetAllState();

		// Verify all cleared
		assert.equal(getBrowser(), null);
		assert.equal(getContext(), null);
		assert.equal(getActiveFrame(), null);
		assert.equal(getSessionStartedAt(), null);
		assert.equal(getSessionArtifactDir(), null);
		assert.deepStrictEqual(getCurrentRefMap(), {});
		assert.equal(getRefVersion(), 0);
		assert.equal(getRefMetadata(), null);
		assert.equal(getLastActionBeforeState(), null);
		assert.equal(getLastActionAfterState(), null);
	});
});

// ---------------------------------------------------------------------------
// capture.ts — constrainScreenshot
// ---------------------------------------------------------------------------

describe("constrainScreenshot", () => {
	// Helper: create a synthetic JPEG buffer via sharp
	async function createTestJpeg(width, height) {
		const sharp = require("sharp");
		return sharp({
			create: {
				width,
				height,
				channels: 3,
				background: { r: 128, g: 128, b: 128 },
			},
		})
			.jpeg({ quality: 80 })
			.toBuffer();
	}

	// Helper: create a synthetic PNG buffer via sharp
	async function createTestPng(width, height) {
		const sharp = require("sharp");
		return sharp({
			create: {
				width,
				height,
				channels: 4,
				background: { r: 128, g: 128, b: 128, alpha: 1 },
			},
		})
			.png()
			.toBuffer();
	}

	it("passes through a small JPEG unchanged", async () => {
		const buf = await createTestJpeg(800, 600);
		const result = await constrainScreenshot(null, buf, "image/jpeg", 80);
		// Should return the same buffer (no resize needed)
		assert.equal(Buffer.isBuffer(result), true);
		const sharp = require("sharp");
		const meta = await sharp(result).metadata();
		assert.equal(meta.width, 800);
		assert.equal(meta.height, 600);
	});

	it("resizes an oversized JPEG within 1568px", async () => {
		const buf = await createTestJpeg(3000, 2000);
		const result = await constrainScreenshot(null, buf, "image/jpeg", 80);
		assert.equal(Buffer.isBuffer(result), true);

		const sharp = require("sharp");
		const meta = await sharp(result).metadata();
		// Both dimensions should be <= 1568
		assert.ok(meta.width <= 1568, `width ${meta.width} should be <= 1568`);
		assert.ok(meta.height <= 1568, `height ${meta.height} should be <= 1568`);
		// Aspect ratio preserved: 3000/2000 = 1.5, so width = 1568, height ~= 1045
		assert.equal(meta.width, 1568);
		assert.ok(meta.height > 1000 && meta.height < 1100);
		assert.equal(meta.format, "jpeg");
	});

	it("resizes an oversized PNG and returns PNG", async () => {
		const buf = await createTestPng(2500, 1800);
		const result = await constrainScreenshot(null, buf, "image/png", 80);
		assert.equal(Buffer.isBuffer(result), true);

		const sharp = require("sharp");
		const meta = await sharp(result).metadata();
		assert.ok(meta.width <= 1568, `width ${meta.width} should be <= 1568`);
		assert.ok(meta.height <= 1568, `height ${meta.height} should be <= 1568`);
		assert.equal(meta.format, "png");
	});

	it("handles an image where only height exceeds the limit", async () => {
		const buf = await createTestJpeg(1000, 9000);
		const result = await constrainScreenshot(null, buf, "image/jpeg", 80);
		const sharp = require("sharp");
		const meta = await sharp(result).metadata();
		assert.ok(meta.width <= 1568);
		assert.ok(meta.height <= 8000);
		// Height was the constraining dimension
		assert.equal(meta.height, 8000);
	});
});

// ---------------------------------------------------------------------------
// browser_save_pdf — tool registration
// ---------------------------------------------------------------------------

describe("browser_save_pdf tool registration", () => {
	it("registerPdfTools exports a function", () => {
		const { registerPdfTools } = jiti("../tools/pdf.js");
		assert.equal(typeof registerPdfTools, "function", "registerPdfTools should be a function");
	});

	it("tool can be registered with a mock pi", () => {
		const { registerPdfTools } = jiti("../tools/pdf.js");
		const registeredTools = [];
		const mockPi = {
			registerTool: (tool) => registeredTools.push(tool),
		};
		const mockDeps = {};
		registerPdfTools(mockPi, mockDeps);
		assert.equal(registeredTools.length, 1, "should register exactly 1 tool");
		assert.equal(registeredTools[0].name, "browser_save_pdf", "tool name should be browser_save_pdf");
		assert.ok(registeredTools[0].parameters, "tool should have parameters schema");
		assert.equal(typeof registeredTools[0].execute, "function", "tool should have execute function");
	});
});

// ---------------------------------------------------------------------------
// utils.ts — getRefFrameContext
// ---------------------------------------------------------------------------

const fakeMainFrame = (url = PAGE_URL) => ({ name: () => "", url: () => url, parentFrame: () => null });
const fakeFrame = (name, url) => ({ name: () => name, url: () => url, parentFrame: () => fakeMainFrame() });

describe("getActiveFrameContext", () => {
	beforeEach(() => resetAllState());

	it("returns undefined when no frame is selected", () => {
		assert.equal(getActiveFrameContext(), undefined);
	});

	it("treats an explicitly selected main frame as no frame selection", () => {
		setActiveFrame(fakeMainFrame());
		assert.equal(getActiveFrameContext(), undefined);
		assert.equal(getActiveSubFrame(), null);
	});

	it("combines name and url so an in-frame navigation is visible", () => {
		setActiveFrame(fakeFrame("checkout", "https://pay.test/step1"));
		const before = getActiveFrameContext();
		setActiveFrame(fakeFrame("checkout", "https://pay.test/step2"));
		assert.notEqual(getActiveFrameContext(), before);
	});

	it("identifies an unnamed frame by its url", () => {
		setActiveFrame(fakeFrame("", "https://pay.test/widget"));
		assert.equal(getActiveFrameContext(), "|https://pay.test/widget");
	});
});

// ---------------------------------------------------------------------------
// utils.ts — validateRefForAction (shared ref staleness guard)
// ---------------------------------------------------------------------------

const PAGE_URL = "https://example.test/app";

function seedSnapshot({ version = 1, url = PAGE_URL, frame = null } = {}) {
	setRefVersion(version);
	setActiveFrame(frame);
	setRefSnapshotFrame(getActiveSubFrame());
	const frameContext = getActiveFrameContext();
	setCurrentRefMap({
		e1: {
			ref: "e1",
			tag: "button",
			role: "button",
			name: "Save",
			selectorHints: [],
			isVisible: true,
			isEnabled: true,
			xpathOrPath: "body > button",
			path: [1, 0],
		},
	});
	setRefMetadata({
		url,
		timestamp: Date.now(),
		interactiveOnly: true,
		limit: 40,
		version,
		frameContext,
	});
}

describe("validateRefForAction", () => {
	beforeEach(() => resetAllState());

	it("accepts a ref when version, url and frame all match", () => {
		seedSnapshot();
		const result = validateRefForAction(parseRef("@v1:e1"), PAGE_URL);
		assert.equal(result.ok, true);
		assert.equal(result.node.ref, "e1");
		assert.equal(result.versionedRef, "@v1:e1");
	});

	it("rejects an unversioned ref as ambiguous", () => {
		seedSnapshot();
		const result = validateRefForAction(parseRef("e1"), PAGE_URL);
		assert.equal(result.ok, false);
		assert.equal(result.details.error, "ref_unversioned");
	});

	it("rejects a ref from an older snapshot version", () => {
		seedSnapshot({ version: 7 });
		const result = validateRefForAction(parseRef("@v1:e1"), PAGE_URL);
		assert.equal(result.ok, false);
		assert.equal(result.details.error, "ref_stale");
		assert.equal(result.details.expectedVersion, 7);
	});

	it("rejects a ref that is not in the current map", () => {
		seedSnapshot();
		const result = validateRefForAction(parseRef("@v1:e9"), PAGE_URL);
		assert.equal(result.ok, false);
		assert.equal(result.details.error, "ref_not_found");
	});

	it("rejects a ref when the page url changed since the snapshot", () => {
		seedSnapshot();
		const result = validateRefForAction(parseRef("@v1:e1"), "https://example.test/other");
		assert.equal(result.ok, false);
		assert.equal(result.details.error, "ref_stale");
		assert.equal(result.details.currentUrl, "https://example.test/other");
	});

	it("rejects a frame-scoped ref once the main frame is active again", () => {
		seedSnapshot({ frame: fakeFrame("checkout", "https://pay.test/widget") });
		setActiveFrame(null);
		const result = validateRefForAction(parseRef("@v1:e1"), PAGE_URL);
		assert.equal(result.ok, false);
		assert.equal(result.details.error, "ref_stale");
		assert.equal(result.details.snapshotFrame, "checkout|https://pay.test/widget");
		assert.equal(result.details.currentFrame, null);
	});

	it("rejects a main-page ref while a frame is selected", () => {
		seedSnapshot();
		setActiveFrame(fakeFrame("checkout", "https://pay.test/widget"));
		const result = validateRefForAction(parseRef("@v1:e1"), PAGE_URL);
		assert.equal(result.ok, false);
		assert.equal(result.details.error, "ref_stale");
		assert.equal(result.details.currentFrame, "checkout|https://pay.test/widget");
	});

	it("rejects a ref snapshotted in a different frame", () => {
		seedSnapshot({ frame: fakeFrame("checkout", "https://pay.test/widget") });
		setActiveFrame(fakeFrame("ads", "https://ads.test/banner"));
		const result = validateRefForAction(parseRef("@v1:e1"), PAGE_URL);
		assert.equal(result.ok, false);
		assert.equal(result.details.error, "ref_stale");
	});

	it("accepts a ref after the main frame is selected explicitly", () => {
		seedSnapshot();
		setActiveFrame(fakeMainFrame());
		const result = validateRefForAction(parseRef("@v1:e1"), PAGE_URL);
		assert.equal(result.ok, true);
	});

	it("rejects a ref after its named frame navigated in place", () => {
		// Playwright keeps the same Frame handle across an in-frame navigation, so the
		// handle check cannot see this — only the url half of frameContext can.
		let frameUrl = "https://pay.test/step1";
		const checkout = { name: () => "checkout", url: () => frameUrl, parentFrame: () => fakeMainFrame() };
		seedSnapshot({ frame: checkout });
		frameUrl = "https://pay.test/step2";
		const result = validateRefForAction(parseRef("@v1:e1"), PAGE_URL);
		assert.equal(result.ok, false);
		assert.equal(result.details.error, "ref_stale");
	});

	it("rejects a ref from a different frame that shares its display identity", () => {
		const widget = fakeFrame("", "https://ads.test/slot");
		const twin = fakeFrame("", "https://ads.test/slot");
		seedSnapshot({ frame: widget });
		setActiveFrame(twin);
		const result = validateRefForAction(parseRef("@v1:e1"), PAGE_URL);
		assert.equal(result.ok, false);
		assert.equal(result.details.error, "ref_stale");
	});

	it("accepts a frame-scoped ref when the same frame is still active", () => {
		const checkout = fakeFrame("checkout", "https://pay.test/widget");
		seedSnapshot({ frame: checkout });
		setActiveFrame(checkout);
		const result = validateRefForAction(parseRef("@v1:e1"), PAGE_URL);
		assert.equal(result.ok, true);
	});
});

// ---------------------------------------------------------------------------
// utils.ts — clampElementLimit
// ---------------------------------------------------------------------------

describe("clampElementLimit", () => {
	it("uses the fallback when the limit is undefined", () => {
		assert.equal(clampElementLimit(undefined, 20), 20);
	});

	it("clamps zero up to 1", () => {
		assert.equal(clampElementLimit(0, 20), 1);
	});

	it("clamps a negative limit up to 1", () => {
		assert.equal(clampElementLimit(-1, 20), 1);
	});

	it("floors a fractional limit", () => {
		assert.equal(clampElementLimit(1.9, 20), 1);
	});

	it("caps an oversized limit at 200", () => {
		assert.equal(clampElementLimit(5000, 20), 200);
	});
});

// ---------------------------------------------------------------------------
// utils.ts — verificationFromChecks critical checks
// ---------------------------------------------------------------------------

describe("verificationFromChecks with critical checks", () => {
	it("does not verify when a critical check fails, even if another passes", () => {
		const result = verificationFromChecks([
			{ name: "value_equals_expected", passed: false, critical: true },
			{ name: "value_contains_expected", passed: true },
		], "retry");
		assert.equal(result.verified, false);
		assert.ok(result.verificationSummary.includes("value_equals_expected"));
		assert.equal(result.retryHint, "retry");
	});

	it("verifies when the critical check passes", () => {
		const result = verificationFromChecks([
			{ name: "value_equals_expected", passed: true, critical: true },
			{ name: "url_changed_after_submit", passed: false },
		]);
		assert.equal(result.verified, true);
	});
});

// ---------------------------------------------------------------------------
// core.ts — evaluateAssertionChecks with no checks
// ---------------------------------------------------------------------------

describe("evaluateAssertionChecks", () => {
	it("does not report verified when given zero checks", () => {
		const result = evaluateAssertionChecks({ checks: [], state: { url: PAGE_URL, title: "t" } });
		assert.equal(result.verified, false);
		assert.equal(result.checks.length, 0);
		assert.ok(!result.summary.includes("PASS"), `summary should not claim PASS: ${result.summary}`);
	});

	it("reports PASS when every provided check passes", () => {
		const result = evaluateAssertionChecks({
			checks: [{ kind: "url_contains", text: "example" }],
			state: { url: PAGE_URL, title: "t" },
		});
		assert.equal(result.verified, true);
		assert.ok(result.summary.includes("PASS"));
	});
});

// ---------------------------------------------------------------------------
// tools/action-cache.ts — buildCacheKey
// ---------------------------------------------------------------------------

describe("buildCacheKey", () => {
	const { buildCacheKey } = jiti("../tools/action-cache.js");

	it("distinguishes urls that differ only by query string", () => {
		const a = buildCacheKey({ url: "https://shop.test/orders?id=1", domHash: "h", intent: "open", pageId: 1, frameContext: undefined });
		const b = buildCacheKey({ url: "https://shop.test/orders?id=2", domHash: "h", intent: "open", pageId: 1, frameContext: undefined });
		assert.notEqual(a, b);
	});

	it("distinguishes the same url on different pages", () => {
		const a = buildCacheKey({ url: PAGE_URL, domHash: "h", intent: "open", pageId: 1, frameContext: undefined });
		const b = buildCacheKey({ url: PAGE_URL, domHash: "h", intent: "open", pageId: 2, frameContext: undefined });
		assert.notEqual(a, b);
	});

	it("distinguishes the same url in different frames", () => {
		const a = buildCacheKey({ url: PAGE_URL, domHash: "h", intent: "open", pageId: 1, frameContext: undefined });
		const b = buildCacheKey({ url: PAGE_URL, domHash: "h", intent: "open", pageId: 1, frameContext: "checkout" });
		assert.notEqual(a, b);
	});

	it("is stable for identical inputs", () => {
		const args = { url: PAGE_URL, domHash: "h", intent: "open", pageId: 1, frameContext: "checkout" };
		assert.equal(buildCacheKey(args), buildCacheKey({ ...args }));
	});
});

// ---------------------------------------------------------------------------
// Tool-level guards — registered with a mock pi/deps, no live browser
// ---------------------------------------------------------------------------

const utils = jiti("../utils.js");

function registerOne(registerFn, deps, toolName) {
	const tools = [];
	registerFn({ registerTool: (tool) => tools.push(tool) }, deps);
	const tool = tools.find((t) => t.name === toolName);
	assert.ok(tool, `${toolName} should be registered`);
	return tool;
}

const fakePage = (url = PAGE_URL) => ({ url: () => url });

const refDeps = (overrides = {}) => ({
	ensureBrowser: async () => ({ page: fakePage() }),
	getActiveTarget: () => ({}),
	getActivePageOrNull: () => fakePage(),
	parseRef: utils.parseRef,
	formatVersionedRef: utils.formatVersionedRef,
	staleRefGuidance: utils.staleRefGuidance,
	captureErrorScreenshot: async () => null,
	firstErrorLine: utils.firstErrorLine,
	resolveRefTarget: async () => {
		throw new Error("resolveRefTarget should not run once a guard rejects the ref");
	},
	...overrides,
});

describe("browser_click_ref frame guard", () => {
	const { registerRefTools } = jiti("../tools/refs.js");
	beforeEach(() => resetAllState());

	it("rejects a ref snapshotted in a frame that is no longer active", async () => {
		seedSnapshot({ frame: fakeFrame("checkout", "https://pay.test/widget") });
		setActiveFrame(null);
		const tool = registerOne(registerRefTools, refDeps(), "browser_click_ref");
		const result = await tool.execute("c1", { ref: "@v1:e1" });
		assert.equal(result.isError, true);
		assert.equal(result.details.error, "ref_stale");
	});
});

describe("browser_fill_ref frame guard", () => {
	const { registerRefTools } = jiti("../tools/refs.js");
	beforeEach(() => resetAllState());

	it("rejects a ref snapshotted before a frame was selected", async () => {
		seedSnapshot();
		setActiveFrame(fakeFrame("checkout", "https://pay.test/widget"));
		const tool = registerOne(registerRefTools, refDeps(), "browser_fill_ref");
		const result = await tool.execute("c1", { ref: "@v1:e1", text: "hi" });
		assert.equal(result.isError, true);
		assert.equal(result.details.error, "ref_stale");
	});
});

describe("browser_hover_ref frame guard", () => {
	const { registerRefTools } = jiti("../tools/refs.js");
	beforeEach(() => resetAllState());

	it("rejects a ref snapshotted in a different frame", async () => {
		seedSnapshot({ frame: fakeFrame("checkout", "https://pay.test/widget") });
		setActiveFrame(fakeFrame("ads", "https://ads.test/banner"));
		const tool = registerOne(registerRefTools, refDeps(), "browser_hover_ref");
		const result = await tool.execute("c1", { ref: "@v1:e1" });
		assert.equal(result.isError, true);
		assert.equal(result.details.error, "ref_stale");
	});
});

describe("browser_batch ref steps apply the staleness guards", () => {
	const { registerAssertionTools } = jiti("../tools/assertions.js");

	const batchDeps = (overrides = {}) => ({
		ensureBrowser: async () => ({ page: fakePage() }),
		getActiveTarget: () => ({}),
		getActivePageOrNull: () => fakePage(),
		captureCompactPageState: async () => ({ url: PAGE_URL, title: "t", counts: {}, dialog: { count: 0 } }),
		beginTrackedAction: () => ({ id: 1 }),
		finishTrackedAction: () => {},
		formatDiffText: () => "",
		settleAfterActionAdaptive: async () => ({}),
		parseRef: utils.parseRef,
		resolveRefTarget: async () => {
			throw new Error("resolveRefTarget should not run once a guard rejects the ref");
		},
		...overrides,
	});

	beforeEach(() => resetAllState());

	it("fails a click_ref step whose snapshot version is stale", async () => {
		seedSnapshot({ version: 7 });
		const tool = registerOne(registerAssertionTools, batchDeps(), "browser_batch");
		const result = await tool.execute("c1", { steps: [{ action: "click_ref", ref: "@v1:e1" }] });
		assert.equal(result.isError, true);
		assert.match(result.details.stepResults[0].message, /version mismatch/i);
	});

	it("fails a fill_ref step whose ref came from another frame", async () => {
		seedSnapshot({ frame: fakeFrame("checkout", "https://pay.test/widget") });
		setActiveFrame(null);
		const tool = registerOne(registerAssertionTools, batchDeps(), "browser_batch");
		const result = await tool.execute("c1", { steps: [{ action: "fill_ref", ref: "@v1:e1", text: "x" }] });
		assert.equal(result.isError, true);
		assert.match(result.details.stepResults[0].message, /frame/i);
	});

	it("fails a click_ref step that uses an unversioned ref", async () => {
		seedSnapshot();
		const tool = registerOne(registerAssertionTools, batchDeps(), "browser_batch");
		const result = await tool.execute("c1", { steps: [{ action: "click_ref", ref: "e1" }] });
		assert.equal(result.isError, true);
		assert.match(result.details.stepResults[0].message, /ambiguous/i);
	});
});

describe("browser_assert with no checks", () => {
	const { registerAssertionTools } = jiti("../tools/assertions.js");

	const assertDeps = {
		ensureBrowser: async () => ({ page: fakePage() }),
		getActiveTarget: () => ({}),
		collectAssertionState: async () => ({ url: PAGE_URL, title: "t" }),
		formatAssertionText: utils.formatAssertionText,
	};

	it("requires at least one check in its parameter schema", () => {
		const tool = registerOne(registerAssertionTools, assertDeps, "browser_assert");
		assert.equal(tool.parameters.properties.checks.minItems, 1);
	});

	it("reports an error rather than PASS for an empty checks array", async () => {
		const tool = registerOne(registerAssertionTools, assertDeps, "browser_assert");
		const result = await tool.execute("c1", { checks: [] });
		assert.equal(result.isError, true);
	});

	it("fails a batch assert step that carries no checks", async () => {
		const batchTool = registerOne(registerAssertionTools, {
			...assertDeps,
			getActivePageOrNull: () => fakePage(),
			captureCompactPageState: async () => ({ url: PAGE_URL, title: "t", counts: {}, dialog: { count: 0 } }),
			beginTrackedAction: () => ({ id: 1 }),
			finishTrackedAction: () => {},
			formatDiffText: () => "",
		}, "browser_batch");
		const result = await batchTool.execute("c1", { steps: [{ action: "assert" }] });
		assert.equal(result.isError, true);
	});
});

describe("browser_select_frame index validation", () => {
	const { registerPageTools } = jiti("../tools/pages.js");

	const pageDeps = {
		ensureBrowser: async () => ({ page: fakePage() }),
		getActivePage: () => ({
			frames: () => [fakeFrame("main", PAGE_URL), fakeFrame("checkout", "https://pay.test/widget")],
		}),
	};

	it("rejects a fractional index with an explanatory message", async () => {
		const tool = registerOne(registerPageTools, pageDeps, "browser_select_frame");
		const result = await tool.execute("c1", { index: 1.5 });
		assert.equal(result.isError, true);
		assert.equal(result.details.error, "index_not_integer");
	});

	it("rejects an out-of-range index", async () => {
		const tool = registerOne(registerPageTools, pageDeps, "browser_select_frame");
		const result = await tool.execute("c1", { index: 5 });
		assert.equal(result.isError, true);
		assert.equal(result.details.error, "index_out_of_range");
	});

	it("selects a valid index", async () => {
		const tool = registerOne(registerPageTools, pageDeps, "browser_select_frame");
		const result = await tool.execute("c1", { index: 1 });
		assert.notEqual(result.isError, true);
		assert.equal(result.details.name, "checkout");
	});
});

describe("browser_find limit clamping", () => {
	const { registerInspectionTools } = jiti("../tools/inspection.js");

	function toolWithCapture() {
		const captured = {};
		const deps = {
			ensureBrowser: async () => ({ page: fakePage() }),
			getActiveTarget: () => ({
				evaluate: async (_fn, args) => {
					Object.assign(captured, args);
					return [];
				},
			}),
			truncateText: (t) => t,
		};
		return { tool: registerOne(registerInspectionTools, deps, "browser_find"), captured };
	}

	it("clamps a zero limit up to 1", async () => {
		const { tool, captured } = toolWithCapture();
		await tool.execute("c1", { limit: 0 });
		assert.equal(captured.limit, 1);
	});

	it("clamps a negative limit up to 1", async () => {
		const { tool, captured } = toolWithCapture();
		await tool.execute("c1", { limit: -1 });
		assert.equal(captured.limit, 1);
	});

	it("floors a fractional limit", async () => {
		const { tool, captured } = toolWithCapture();
		await tool.execute("c1", { limit: 3.7 });
		assert.equal(captured.limit, 3);
	});
});

describe("browser_fill_ref value verification", () => {
	const { registerRefTools } = jiti("../tools/refs.js");
	beforeEach(() => resetAllState());

	function fillDeps(filledValue, pressed = []) {
		const locator = {
			first: () => ({ click: async () => {}, fill: async () => {} }),
		};
		return refDeps({
			getActiveTarget: () => ({ locator: () => locator }),
			ensureBrowser: async () => ({
				page: {
					url: () => PAGE_URL,
					keyboard: { press: async (key) => { pressed.push(key); }, type: async () => {} },
				},
			}),
			resolveRefTarget: async () => ({ ok: true, selector: "input#q" }),
			settleAfterActionAdaptive: async () => ({}),
			readInputLikeValue: async () => filledValue,
			verificationFromChecks: utils.verificationFromChecks,
			verificationLine: utils.verificationLine,
			captureCompactPageState: async () => ({ url: PAGE_URL, title: "t", counts: {}, dialog: { count: 0 } }),
			formatCompactStateSummary: () => "",
			getRecentErrors: () => "",
		});
	}

	it("does not verify a clearFirst fill that left the old value in place", async () => {
		seedSnapshot();
		const tool = registerOne(registerRefTools, fillDeps("oldnew"), "browser_fill_ref");
		const result = await tool.execute("c1", { ref: "@v1:e1", text: "new", clearFirst: true, slowly: true });
		assert.equal(result.details.verified, false);
	});

	it("verifies a clearFirst fill that replaced the value exactly", async () => {
		seedSnapshot();
		const tool = registerOne(registerRefTools, fillDeps("new"), "browser_fill_ref");
		const result = await tool.execute("c1", { ref: "@v1:e1", text: "new", clearFirst: true, slowly: true });
		assert.equal(result.details.verified, true);
	});

	it("clears with the platform select-all rather than Control+A", async () => {
		seedSnapshot();
		const pressed = [];
		const tool = registerOne(registerRefTools, fillDeps("new", pressed), "browser_fill_ref");
		await tool.execute("c1", { ref: "@v1:e1", text: "new", clearFirst: true, slowly: true });
		assert.ok(pressed.includes("ControlOrMeta+A"), `expected ControlOrMeta+A, got ${JSON.stringify(pressed)}`);
		assert.ok(!pressed.includes("Control+A"), "Control+A moves the caret on macOS instead of selecting all");
	});

	it("verifies an appending slow fill that only contains the typed text", async () => {
		seedSnapshot();
		const tool = registerOne(registerRefTools, fillDeps("oldnew"), "browser_fill_ref");
		const result = await tool.execute("c1", { ref: "@v1:e1", text: "new", slowly: true });
		assert.equal(result.details.verified, true);
	});
});
