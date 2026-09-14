/**
 * browser-tools — session HAR flush regression tests
 *
 * Playwright only writes a HAR to disk when its recorder stops. The original
 * implementation configured `recordHar` at context creation and then tore the
 * session down with `browser.close()` alone, which never closes the context —
 * so the HAR file was never created and `browser_export_har` could only ever
 * fail with ENOENT.
 *
 * These tests pin the contract that replaced it:
 *   - recording runs through `context.tracing.startHar()/stopHar()`, which can
 *     be flushed mid-session;
 *   - each flush merges into one cumulative session HAR, so an export is the
 *     whole session so far rather than the slice since the last export;
 *   - `closeBrowser()` flushes and closes the context before the browser.
 *
 * Uses jiti (matching browser-tools-unit.test.cjs) so the test and the modules
 * under test share one module registry, and therefore one copy of state.ts.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const jiti = require("jiti")(__filename, { interopDefault: true, debug: false });

// Resolve with the same ".js" specifiers the modules use internally. jiti keys
// its cache on the specifier, so importing "../state.ts" here would hand the
// test a second copy of state.ts that closeBrowser() never sees — and in
// dist-test the compiled .js sits next to the .ts, making the split permanent.
const { mergeHarDocuments, harSegmentPath, flushSessionHar } = jiti("../har.js");
const { closeBrowser } = jiti("../lifecycle.js");
const {
	getBrowser,
	setBrowser,
	getContext,
	setContext,
	getHarState,
	setHarState,
	resetAllState,
} = jiti("../state.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal Playwright HAR document with one entry per url. */
function harDoc(urls) {
	return {
		log: {
			version: "1.2",
			creator: { name: "Playwright", version: "1.60.0" },
			browser: { name: "chromium", version: "test" },
			entries: urls.map((url) => ({ request: { url }, response: { status: 200 } })),
		},
	};
}

function harUrls(filePath) {
	return JSON.parse(readFileSync(filePath, "utf8")).log.entries.map((e) => e.request.url);
}

/**
 * Stand-in for a Playwright BrowserContext that records the teardown call
 * order and, like the real recorder, only writes the HAR when stopHar() runs.
 */
function makeFakeContext(calls) {
	let segmentTarget = null;
	let flushCount = 0;
	return {
		tracing: {
			async startHar(path) {
				calls.push("startHar");
				segmentTarget = path;
			},
			async stopHar() {
				calls.push("stopHar");
				if (!segmentTarget) throw new Error("HAR recording has not been started");
				flushCount += 1;
				writeFileSync(segmentTarget, JSON.stringify(harDoc([`https://example.test/${flushCount}`])));
				segmentTarget = null;
			},
		},
		async close() {
			calls.push("context.close");
		},
	};
}

let workDir;
let sessionHarPath;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "har-flush-"));
	sessionHarPath = join(workDir, "session.har");
	resetAllState();
});

afterEach(() => {
	resetAllState();
	rmSync(workDir, { recursive: true, force: true });
});

/** Put state into the shape ensureBrowser() leaves behind with HAR recording live. */
function primeRecordingSession(calls) {
	const context = makeFakeContext(calls);
	setBrowser({
		async close() {
			calls.push("browser.close");
		},
	});
	setContext(context);
	setHarState({
		enabled: true,
		configuredAtContextCreation: true,
		recordingActive: true,
		path: sessionHarPath,
		exportCount: 0,
		lastExportedPath: null,
		lastExportedAt: null,
	});
	// Mirror ensureBrowser(): the live recorder targets the segment file.
	context.tracing.startHar(harSegmentPath(sessionHarPath));
	calls.length = 0;
	return context;
}

// ---------------------------------------------------------------------------
// mergeHarDocuments
// ---------------------------------------------------------------------------

describe("mergeHarDocuments", () => {
	it("concatenates entries and keeps the base document's metadata", () => {
		const merged = mergeHarDocuments(harDoc(["a"]), harDoc(["b", "c"]));
		assert.deepEqual(merged.log.entries.map((e) => e.request.url), ["a", "b", "c"]);
		assert.equal(merged.log.version, "1.2");
		assert.equal(merged.log.creator.name, "Playwright");
	});

	it("tolerates a document with no entries array", () => {
		const merged = mergeHarDocuments({ log: { version: "1.2" } }, harDoc(["a"]));
		assert.deepEqual(merged.log.entries.map((e) => e.request.url), ["a"]);
	});

	it("concatenates pages when the recorder emits them", () => {
		const base = harDoc(["a"]);
		base.log.pages = [{ id: "page_1" }];
		const incoming = harDoc(["b"]);
		incoming.log.pages = [{ id: "page_2" }];
		assert.deepEqual(mergeHarDocuments(base, incoming).log.pages, [{ id: "page_1" }, { id: "page_2" }]);
	});
});

// ---------------------------------------------------------------------------
// flushSessionHar
// ---------------------------------------------------------------------------

describe("flushSessionHar", () => {
	it("writes the session HAR to disk mid-session and resumes recording", async () => {
		const calls = [];
		primeRecordingSession(calls);

		const result = await flushSessionHar();

		assert.ok(existsSync(sessionHarPath), "flush must materialize the session HAR on disk");
		assert.deepEqual(result, { path: sessionHarPath, entries: 1 });
		assert.deepEqual(calls, ["stopHar", "startHar"], "recording must resume after a mid-session flush");
		assert.equal(getHarState().recordingActive, true);
		assert.ok(!existsSync(harSegmentPath(sessionHarPath)), "the segment scratch file must be consumed");
	});

	it("accumulates across flushes so every export is the whole session", async () => {
		primeRecordingSession([]);

		await flushSessionHar();
		const second = await flushSessionHar();

		assert.deepEqual(harUrls(sessionHarPath), ["https://example.test/1", "https://example.test/2"]);
		assert.equal(second.entries, 2);
	});

	it("stops recording without resuming when resume is false", async () => {
		const calls = [];
		primeRecordingSession(calls);

		await flushSessionHar({ resume: false });

		assert.deepEqual(calls, ["stopHar"]);
		assert.equal(getHarState().recordingActive, false);
	});

	it("returns null when no HAR recorder is running", async () => {
		const calls = [];
		primeRecordingSession(calls);
		setHarState({ ...getHarState(), recordingActive: false });

		assert.equal(await flushSessionHar(), null);
		assert.deepEqual(calls, [], "must not call stopHar when no recorder is active");
	});

	it("returns null when there is no browser context", async () => {
		setHarState({
			enabled: true,
			configuredAtContextCreation: true,
			recordingActive: true,
			path: sessionHarPath,
			exportCount: 0,
			lastExportedPath: null,
			lastExportedAt: null,
		});
		assert.equal(await flushSessionHar(), null);
	});

	it("preserves an existing session HAR when the segment file is missing", async () => {
		const calls = [];
		const context = primeRecordingSession(calls);
		writeFileSync(sessionHarPath, JSON.stringify(harDoc(["https://example.test/earlier"])));
		// A recorder that stops without producing a segment (nothing to add).
		context.tracing.stopHar = async () => { calls.push("stopHar"); };

		const result = await flushSessionHar();

		assert.deepEqual(harUrls(sessionHarPath), ["https://example.test/earlier"]);
		assert.equal(result.entries, 1);
	});
});

// ---------------------------------------------------------------------------
// closeBrowser — the original defect
// ---------------------------------------------------------------------------

describe("closeBrowser", () => {
	it("flushes the HAR and closes the context before the browser", async () => {
		const calls = [];
		primeRecordingSession(calls);

		await closeBrowser();

		assert.deepEqual(
			calls,
			["stopHar", "context.close", "browser.close"],
			"the context must be flushed and closed before the browser, or the HAR is lost",
		);
		assert.ok(existsSync(sessionHarPath), "the session HAR must survive teardown on disk");
		assert.deepEqual(harUrls(sessionHarPath), ["https://example.test/1"]);
	});

	it("resets state after teardown", async () => {
		primeRecordingSession([]);
		await closeBrowser();
		assert.equal(getBrowser(), null);
		assert.equal(getContext(), null);
		assert.equal(getHarState().enabled, false);
	});

	it("still closes the context when the HAR flush throws", async () => {
		const calls = [];
		const context = primeRecordingSession(calls);
		context.tracing.stopHar = async () => {
			calls.push("stopHar");
			throw new Error("recorder exploded");
		};

		await closeBrowser();

		assert.deepEqual(calls, ["stopHar", "context.close", "browser.close"]);
	});

	it("closes the context even when HAR recording was never started", async () => {
		const calls = [];
		setContext(makeFakeContext(calls));
		setBrowser({
			async close() {
				calls.push("browser.close");
			},
		});

		await closeBrowser();

		assert.deepEqual(calls, ["context.close", "browser.close"]);
	});
});

// ---------------------------------------------------------------------------
// browser_export_har — the tool that could never succeed
// ---------------------------------------------------------------------------

const { registerSessionTools } = jiti("../tools/session.js");

/** Register the session tools against a stub pi and return them by name. */
function registerTools(deps) {
	const tools = new Map();
	registerSessionTools({ registerTool: (tool) => tools.set(tool.name, tool) }, deps);
	return tools;
}

function exportHarDeps(overrides = {}) {
	return {
		ensureBrowser: async () => ({}),
		flushSessionHar,
		buildSessionArtifactPath: (filename) => join(workDir, filename),
		copyArtifactFile: async (source, destination) => {
			const bytes = readFileSync(source);
			writeFileSync(destination, bytes);
			return { path: destination, bytes: bytes.length };
		},
		getSessionArtifactMetadata: () => ({ sessionArtifactDir: workDir }),
		...overrides,
	};
}

describe("browser_export_har", () => {
	it("exports a HAR mid-session without ending the session", async () => {
		const calls = [];
		primeRecordingSession(calls);
		const tool = registerTools(exportHarDeps()).get("browser_export_har");

		const result = await tool.execute("call-1", {}, undefined, undefined, undefined);

		assert.ok(!result.isError, `export must succeed mid-session: ${result.content[0].text}`);
		assert.equal(result.details.entries, 1);
		assert.ok(existsSync(result.details.path), "the exported artifact must exist on disk");
		assert.deepEqual(harUrls(result.details.path), ["https://example.test/1"]);
		assert.deepEqual(calls, ["stopHar", "startHar"], "the session must keep recording after an export");

		const harState = getHarState();
		assert.equal(harState.exportCount, 1);
		assert.equal(harState.lastExportedPath, result.details.path);
		assert.equal(harState.recordingActive, true, "the export must not clear the live recorder flag");
	});

	it("exports the whole session on a second call, not just the new traffic", async () => {
		primeRecordingSession([]);
		const tool = registerTools(exportHarDeps()).get("browser_export_har");

		await tool.execute("call-1", {}, undefined, undefined, undefined);
		const second = await tool.execute("call-2", { filename: "later.har" }, undefined, undefined, undefined);

		assert.deepEqual(harUrls(second.details.path), ["https://example.test/1", "https://example.test/2"]);
		assert.equal(getHarState().exportCount, 2);
	});

	it("reports a clear error when no recorder is running", async () => {
		primeRecordingSession([]);
		setHarState({ ...getHarState(), recordingActive: false });
		const tool = registerTools(exportHarDeps()).get("browser_export_har");

		const result = await tool.execute("call-1", {}, undefined, undefined, undefined);

		assert.equal(result.isError, true);
		assert.equal(result.details.error, "har_not_recording");
	});

	it("reports har_not_enabled when the context was built without HAR", async () => {
		primeRecordingSession([]);
		resetAllState();
		const tool = registerTools(exportHarDeps()).get("browser_export_har");

		const result = await tool.execute("call-1", {}, undefined, undefined, undefined);

		assert.equal(result.isError, true);
		assert.equal(result.details.error, "har_not_enabled");
	});
});
