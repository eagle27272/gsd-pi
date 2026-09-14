import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { initExtensions, resetExtensionUI, setExtensionWidget } from "./interactive-extension-widgets.js";

function createWidgetHost() {
	const renderCalls: Array<true | undefined> = [];
	return {
		host: {
			extensionWidgetsAbove: new Map(),
			extensionWidgetsBelow: new Map(),
			// Leave widget containers undefined so renderWidgets() returns early,
			// isolating only the gsd-outcome force-render path under test.
			widgetContainerAbove: undefined,
			widgetContainerBelow: undefined,
			pinnedMessageContainer: { children: [] },
			ui: {
				requestRender(force?: boolean) {
					if (force) renderCalls.push(true);
				},
			},
		} as any,
		renderCalls,
	};
}

test("setExtensionWidget: forces viewport realign when key is gsd-outcome", () => {
	initTheme("dark", false);
	const { host, renderCalls } = createWidgetHost();
	setExtensionWidget(host, "gsd-outcome", ["Step complete"]);
	assert.equal(renderCalls.length, 1, "requestRender(true) should be called once for gsd-outcome");
});

test("setExtensionWidget: does not force viewport realign for non-gsd-outcome keys", () => {
	initTheme("dark", false);
	const { host, renderCalls } = createWidgetHost();
	setExtensionWidget(host, "gsd-other", ["Working..."]);
	assert.equal(renderCalls.length, 0, "requestRender(true) should not be called for non-gsd-outcome keys");
});

test("setExtensionWidget: does not force viewport realign when removing a widget (content undefined)", () => {
	initTheme("dark", false);
	const { host, renderCalls } = createWidgetHost();
	setExtensionWidget(host, "gsd-outcome", undefined);
	assert.equal(renderCalls.length, 0, "requestRender(true) should not be called when content is undefined");
});

/** Host with an open extension selector, exercising the dialog-teardown branches of resetExtensionUI. */
function createResetHost() {
	const editor = { id: "editor" };
	const disposed: string[] = [];
	return {
		disposed,
		host: {
			extensionSelector: { dispose: () => disposed.push("selector") },
			extensionInput: { dispose: () => disposed.push("input") },
			extensionEditor: { dispose: () => disposed.push("editor") },
			extensionWidgetsAbove: new Map(),
			extensionWidgetsBelow: new Map(),
			widgetContainerAbove: undefined,
			widgetContainerBelow: undefined,
			pinnedMessageContainer: { children: [] },
			editor,
			defaultEditor: { onExtensionShortcut: () => {} },
			editorContainer: { clear() {}, addChild() {} },
			keybindings: { get: () => undefined },
			footer: { invalidate() {} },
			footerDataProvider: { clearExtensionStatuses() {} },
			gsdProgressDispose: undefined,
			gsdProgressState: undefined,
			loadingAnimation: undefined,
			defaultWorkingMessage: "Working...",
			ui: { hideOverlay() {}, setFocus() {}, requestRender() {} },
			clearExtensionTerminalInputListeners() {},
			setExtensionFooter() {},
			setExtensionHeader() {},
			setCustomEditorComponent() {},
			updateTerminalTitle() {},
		} as any,
	};
}

test("resetExtensionUI: tears down an open extension selector without throwing", () => {
	initTheme("dark", false);
	const { host, disposed } = createResetHost();
	resetExtensionUI(host);
	// hideExtensionEditor intentionally does not dispose; only the selector and input do.
	assert.deepEqual(disposed, ["selector", "input"]);
	assert.equal(host.extensionSelector, undefined, "selector should be cleared");
	assert.equal(host.extensionInput, undefined, "input should be cleared");
	assert.equal(host.extensionEditor, undefined, "editor should be cleared");
});

test("initExtensions: command context actions include getAllTools", async () => {
	initTheme("dark", false);
	const tools = [{ name: "read" }];
	let bound: any;
	const host = {
		options: {},
		createExtensionUIContext: () => ({}),
		setupAutocomplete() {},
		showLoadedResources() {},
		session: {
			agent: { waitForIdle: async () => {} },
			getAllTools: () => tools,
			resourceLoader: { getThemes: () => ({ themes: [] }) },
			extensionRunner: undefined,
			bindExtensions: async (args: any) => {
				bound = args;
			},
		},
	} as any;

	await initExtensions(host);

	assert.equal(
		typeof bound.commandContextActions.getAllTools,
		"function",
		"interactive mode must supply getAllTools like print and rpc modes do",
	);
	assert.deepEqual(bound.commandContextActions.getAllTools(), tools);
});
