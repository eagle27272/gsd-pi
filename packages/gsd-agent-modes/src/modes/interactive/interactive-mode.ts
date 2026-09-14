// Project/App: gsd-pi
// File Purpose: Interactive TUI mode and session UI rendering.
// gsd-pi - Interactive TUI mode for coding-agent sessions.
/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import type { ImageContent } from "@gsd/pi-ai";
import type { EditorComponent, MarkdownTheme, Spacer, Text } from "@gsd/pi-tui";
import {
	CombinedAutocompleteProvider,
	Container,
	Loader,
	ProcessTerminal,
	type Terminal as TuiTerminal,
	TUI,
} from "@gsd/pi-tui";
import { VERSION } from "@gsd/pi-coding-agent/config.js";
import { type AgentSession, type AgentSessionEvent, createInitialTranscriptState, type TranscriptState } from "@gsd/agent-core";
import type { ExtensionRunner } from "@gsd/pi-coding-agent/core/extensions/index.js";
import { FooterDataProvider } from "@gsd/pi-coding-agent/core/footer-data-provider.js";
import { KeybindingsManager } from "@gsd/agent-core";
import { ensureTool } from "@gsd/pi-coding-agent/utils/tools-manager.js";
import { GsdStatusWidget } from "./components/gsd-status-widget.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { CustomEditor } from "./components/custom-editor.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { FooterComponent } from "./components/footer.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { setRailAnimationEnabled } from "./components/transcript-design.js";
import { ContextualTips } from "@gsd/agent-core";
import { handleAgentEvent } from "./controllers/chat-controller.js";
import { createInteractiveModeUiState } from "./interactive-mode-ui-state.js";
import { applyAgentEventToTranscript } from "./tui-transcript-tracker.js";
import { setupEditorSubmitHandler as setupEditorSubmitHandlerController } from "./controllers/input-controller.js";
import {
	getEditorTheme,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	stopThemeWatcher,
} from "@gsd/pi-coding-agent/theme/theme.js";
import * as chatRender from "./interactive-chat-render.js";
import * as commandHandlers from "./interactive-command-handlers.js";
import * as extensionSystem from "./interactive-extension-system.js";
import * as inputRouter from "./interactive-input-router.js";
import * as keyHandlers from "./interactive-key-handlers.js";
import * as modeInit from "./interactive-mode-init.js";
import type { CompactionQueuedMessage } from "./interactive-notify-render.js";
import * as resourceDisplay from "./interactive-resource-display.js";
import * as selectors from "./interactive-selectors.js";
import { clearMarkdownThemeCache, getMarkdownThemeWithSettings as getMarkdownThemeWithSettingsModule } from "./interactive-theme-cache.js";
import * as uiMessaging from "./interactive-ui-messaging.js";
import { DEFAULT_TOOL_OUTPUT_EXPANDED } from "./interactive-mode-class-constants.js";

export type {
	AssistantReplaySegment,
	ExtensionNotifyType,
	ExtensionNotifyRenderResult,
	CompactionQueuedMessage,
} from "./interactive-notify-render.js";
export {
	buildAssistantReplaySegments,
	getToolExpansionStartupHint,
	shouldRenderExtensionNotifyInChat,
	renderExtensionNotifyInChat,
	renderBlockingErrorBanner,
} from "./interactive-notify-render.js";

export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** Override the terminal implementation used by the TUI. */
	terminal?: TuiTerminal;
	/** When false, reuse the session's existing extension bindings instead of rebinding them for TUI mode. */
	bindExtensions?: boolean;
	/** Submit editor prompts directly to AgentSession instead of using the interactive prompt loop. */
	submitPromptsDirectly?: boolean;
	/** Control what happens when the user requests shutdown from the TUI. */
	shutdownBehavior?: "exit_process" | "stop_ui" | "ignore";
}

export class InteractiveMode {
	session: AgentSession;
	ui: TUI;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	gsdStatusWidget: GsdStatusWidget;
	gsdStatusExpanded: boolean | undefined = undefined;
	gsdProgressState: import("@gsd/pi-coding-agent/core/extensions/extension-upstream-types.js").GsdProgressState | undefined;
	gsdProgressDispose?: () => void;
	statusContainer: Container;
	pinnedMessageContainer: Container;
	blockingErrorContainer: Container;
	defaultEditor: CustomEditor;
	editor: EditorComponent;
	autocompleteProvider: CombinedAutocompleteProvider | undefined;
	editorContainer: Container;
	footer: FooterComponent;
	footerDataProvider: FooterDataProvider;
	keybindings: KeybindingsManager;
	version: string;
	isInitialized = false;
	onInputCallback?: (text: string) => void;
	loadingAnimation: Loader | undefined = undefined;
	activityLoader: Loader | undefined = undefined;
	pendingWorkingMessage: string | null | undefined = undefined;
	readonly defaultWorkingMessage = "Working...";
	lastBlockingError: string | undefined = undefined;

	lastSigintTime = 0;
	lastEscapeTime = 0;
	changelogMarkdown: string | undefined = undefined;
	startupHeaderDismissed = false;

	lastStatusSpacer: Spacer | undefined = undefined;
	lastStatusText: Text | undefined = undefined;

	streamingComponent: AssistantMessageComponent | undefined = undefined;
	streamingMessage: import("@gsd/pi-ai").AssistantMessage | undefined = undefined;

	pendingTools = new Map<string, ToolExecutionComponent>();
	toolOutputExpanded = DEFAULT_TOOL_OUTPUT_EXPANDED;
	pendingImages: ImageContent[] = [];
	hideThinkingBlock = false;
	skillCommands = new Map<string, string>();
	private unsubscribe?: () => void;
	private _branchChangeUnsub?: () => void;
	private _themeChangeUnsub?: () => void;
	markdownThemeCache?: MarkdownTheme;
	markdownThemeCacheIndent?: string;
	isBashMode = false;
	contextualTips = new ContextualTips();
	bashComponent: BashExecutionComponent | undefined = undefined;
	pendingBashComponents: BashExecutionComponent[] = [];
	autoCompactionLoader: Loader | undefined = undefined;
	autoCompactionEscapeHandler?: () => void;
	retryLoader: Loader | undefined = undefined;
	retryEscapeHandler?: () => void;
	compactionQueuedMessages: CompactionQueuedMessage[] = [];
	shutdownRequested = false;
	extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	extensionInput: ExtensionInputComponent | undefined = undefined;
	extensionEditor: ExtensionEditorComponent | undefined = undefined;
	extensionTerminalInputUnsubscribers = new Set<() => void>();
	stdinErrorHandler: ((err: Error) => void) | undefined = undefined;
	extensionWidgetsAbove = new Map<string, import("@gsd/pi-tui").Component & { dispose?(): void }>();
	extensionWidgetsBelow = new Map<string, import("@gsd/pi-tui").Component & { dispose?(): void }>();
	private readonly uiState = createInteractiveModeUiState();
	transcriptState: TranscriptState = createInitialTranscriptState();
	widgetContainerAbove!: Container;
	widgetContainerBelow!: Container;
	customFooter: (import("@gsd/pi-tui").Component & { dispose?(): void }) | undefined = undefined;
	headerContainer: Container;
	builtInHeader: import("@gsd/pi-tui").Component | undefined = undefined;
	customHeader: (import("@gsd/pi-tui").Component & { dispose?(): void }) | undefined = undefined;

	get agent() {
		return this.session.agent;
	}
	get sessionManager() {
		return this.session.sessionManager;
	}
	get settingsManager() {
		return this.session.settingsManager;
	}

	get streamingRenderState() {
		return this.uiState.streaming.streamingRenderState;
	}

	constructor(
		session: AgentSession,
		public options: InteractiveModeOptions = {},
	) {
		this.session = session;
		this.version = VERSION;
		this.ui = new TUI(options.terminal ?? new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		setRailAnimationEnabled(this.settingsManager.getToolRailAnimation());
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.gsdStatusWidget = new GsdStatusWidget(() => ({
			override: this.settingsManager.getAdaptiveMode(),
			activeToolCount: this.pendingTools.size,
			gsdPhase: this.gsdProgressState?.phase ?? this.pendingWorkingMessage ?? undefined,
			lastError: this.lastBlockingError,
			sessionName: this.sessionManager.getSessionName(),
			cwd: this.gsdProgressState?.path ?? process.cwd(),
			manuallyExpanded: this.gsdStatusExpanded,
			gsdProgress: this.gsdProgressState,
			isStreaming: this.session.isStreaming,
		}));
		this.statusContainer = new Container();
		this.pinnedMessageContainer = new Container();
		this.blockingErrorContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as import("@gsd/pi-tui").Component);
		this.footerDataProvider = new FooterDataProvider(process.cwd());
		this.footer = new FooterComponent(session, this.footerDataProvider, () => ({
			override: this.settingsManager.getAdaptiveMode(),
			activeToolCount: this.pendingTools.size,
			gsdPhase: this.gsdProgressState?.phase ?? this.pendingWorkingMessage ?? undefined,
			lastError: this.lastBlockingError,
			cwd: this.gsdProgressState?.path ?? process.cwd(),
			manuallyExpanded: this.gsdStatusExpanded,
			gsdProgress: this.gsdProgressState,
		}));
		this.footer.setAutoCompactEnabled(session.autoCompactionEnabled);
		this.toolOutputExpanded = this.settingsManager.getToolsExpanded();
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		initTheme(this.settingsManager.getTheme(), true);
	}

	setupAutocomplete(): void {
		inputRouter.setupAutocomplete(this);
	}

	private installStdinErrorRecovery(): void {
		modeInit.installStdinErrorRecovery(this);
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.changelogMarkdown = modeInit.getChangelogForDisplay(this);
		await ensureTool("rg");

		this.ui.addChild(this.headerContainer);
		modeInit.mountStartupHeader(this);

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.pinnedMessageContainer);
		this.ui.addChild(this.blockingErrorContainer);
		this.renderWidgets();
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();
		await this.initExtensions();
		this.renderInitialMessages();

		this.ui.start();
		this.ui.onOutputClosed = () => {
			if (this.isShuttingDown) return;
			void keyHandlers.shutdown(this);
		};
		this.installStdinErrorRecovery();
		this.isInitialized = true;

		modeInit.updateTerminalTitle(this);
		this.subscribeToAgent();

		this._themeChangeUnsub = onThemeChange(() => {
			this.clearMarkdownThemeCache();
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		this._branchChangeUnsub = this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		await this.updateAvailableProviderCount();
	}

	async run(): Promise<void> {
		await this.init();

		modeInit.checkForNewVersion(this).then((newVersion) => {
			if (newVersion) {
				modeInit.showNewVersionNotification(this, newVersion);
			}
		});

		modeInit.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		while (true) {
			const userInput = await this.getUserInput();
			const images = this.pendingImages.length > 0 ? [...this.pendingImages] : undefined;
			this.pendingImages.length = 0;
			try {
				await this.session.prompt(userInput, { images });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	getMarkdownThemeWithSettings(): MarkdownTheme {
		return getMarkdownThemeWithSettingsModule(this);
	}

	clearMarkdownThemeCache(): void {
		clearMarkdownThemeCache(this);
	}

	private setupEditorSubmitHandler(): void {
		setupEditorSubmitHandlerController(this);
	}

	private subscribeToAgent(): void {
		let eventQueue: Promise<void> = Promise.resolve();
		this.unsubscribe = this.session.subscribe((event) => {
			eventQueue = eventQueue.then(() => this.handleEvent(event)).catch(() => {});
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		this.transcriptState = applyAgentEventToTranscript(this.transcriptState, event);
		await handleAgentEvent(this, event);
	}

	clearEditor(): void {
		uiMessaging.clearEditor(this);
	}

	showError(errorMessage: string): void {
		uiMessaging.showError(this, errorMessage);
	}

	clearBlockingError(): void {
		uiMessaging.clearBlockingError(this);
	}

	showWarning(warningMessage: string): void {
		uiMessaging.showWarning(this, warningMessage);
	}

	showSuccess(successMessage: string): void {
		uiMessaging.showSuccess(this, successMessage);
	}

	showTip(message: string): void {
		uiMessaging.showTip(this, message);
	}

	getContextPercent(): number | undefined {
		return this.session.getContextUsage()?.percent ?? undefined;
	}

	renderInitialMessages(): void {
		chatRender.renderInitialMessages(this);
	}

	async getUserInput(): Promise<string> {
		return chatRender.getUserInput(this);
	}

	getExtensionUIContext() {
		return extensionSystem.createExtensionUIContext(this);
	}

	requestRender(force = false): void {
		if (!this.isInitialized) return;
		this.ui.requestRender(force);
	}

	stop(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.clearExtensionTerminalInputListeners();
		this._branchChangeUnsub?.();
		this._branchChangeUnsub = undefined;
		this._themeChangeUnsub?.();
		this._themeChangeUnsub = undefined;
		stopThemeWatcher();

		if (this.onInputCallback) {
			this.onInputCallback("");
			this.onInputCallback = undefined;
		}

		this.clearExtensionWidgets();
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}
		this.customFooter = undefined;
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}
		this.customHeader = undefined;
		this.autocompleteProvider = undefined;

		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.stdinErrorHandler) {
			process.stdin.removeListener("error", this.stdinErrorHandler);
			this.stdinErrorHandler = undefined;
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}

	// Delegates (Phase E2 extracted modules)
	showLoadedResources(options?: Parameters<typeof resourceDisplay.showLoadedResources>[1]): void { resourceDisplay.showLoadedResources(this, options); }

	private async initExtensions(): Promise<void> { return extensionSystem.initExtensions(this); }
	getRegisteredToolDefinition(toolName: string) { return extensionSystem.getRegisteredToolDefinition(this, toolName); }
	formatWebSearchResult(content: unknown): string { return extensionSystem.formatWebSearchResult(this, content); }
	setupExtensionShortcuts(extensionRunner: ExtensionRunner): void { extensionSystem.setupExtensionShortcuts(this, extensionRunner); }
	setExtensionStatus(key: string, text: string | undefined): void { extensionSystem.setExtensionStatus(this, key, text); }
	setGsdProgress(state: Parameters<typeof extensionSystem.setGsdProgress>[1], dispose?: () => void): void { extensionSystem.setGsdProgress(this, state, dispose); }
	setExtensionWidget(key: string, content: Parameters<typeof extensionSystem.setExtensionWidget>[2], options?: Parameters<typeof extensionSystem.setExtensionWidget>[3]): void { extensionSystem.setExtensionWidget(this, key, content, options); }
	private clearExtensionWidgets(): void { extensionSystem.clearExtensionWidgets(this); }
	resetExtensionUI(): void { extensionSystem.resetExtensionUI(this); }
	private renderWidgets(): void { extensionSystem.renderWidgets(this); }
	setExtensionFooter(factory: Parameters<typeof extensionSystem.setExtensionFooter>[1]): void { extensionSystem.setExtensionFooter(this, factory); }
	setExtensionHeader(factory: Parameters<typeof extensionSystem.setExtensionHeader>[1]): void { extensionSystem.setExtensionHeader(this, factory); }
	addExtensionTerminalInputListener(handler: Parameters<typeof extensionSystem.addExtensionTerminalInputListener>[1]): () => void { return extensionSystem.addExtensionTerminalInputListener(this, handler); }
	clearExtensionTerminalInputListeners(): void { extensionSystem.clearExtensionTerminalInputListeners(this); }
	createExtensionUIContext() { return extensionSystem.createExtensionUIContext(this); }
	showExtensionSelector(title: string, options: string[], opts?: import("@gsd/pi-coding-agent/core/extensions/index.js").ExtensionUIDialogOptions): Promise<string | undefined> { return extensionSystem.showExtensionSelector(this, title, options, opts); }
	showExtensionConfirm(title: string, message: string, opts?: import("@gsd/pi-coding-agent/core/extensions/index.js").ExtensionUIDialogOptions): Promise<boolean> { return extensionSystem.showExtensionConfirm(this, title, message, opts); }
	showExtensionInput(title: string, placeholder?: string, opts?: import("@gsd/pi-coding-agent/core/extensions/index.js").ExtensionUIDialogOptions): Promise<string | undefined> { return extensionSystem.showExtensionInput(this, title, placeholder, opts); }
	showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> { return extensionSystem.showExtensionEditor(this, title, prefill); }
	setCustomEditorComponent(factory: Parameters<typeof extensionSystem.setCustomEditorComponent>[1]): void { extensionSystem.setCustomEditorComponent(this, factory); }
	showExtensionNotify(message: string, type?: import("./interactive-notify-render.js").ExtensionNotifyType): void { extensionSystem.showExtensionNotify(this, message, type); }
	showExtensionCustom<T>(factory: Parameters<typeof extensionSystem.showExtensionCustom<T>>[1], options?: Parameters<typeof extensionSystem.showExtensionCustom<T>>[2]): Promise<T> { return extensionSystem.showExtensionCustom(this, factory, options); }
	showExtensionError(extensionPath: string, error: string, stack?: string): void { extensionSystem.showExtensionError(this, extensionPath, error, stack); }

	private setupKeyHandlers(): void { keyHandlers.setupKeyHandlers(this); }
	handleClipboardImagePaste(): Promise<void> { return keyHandlers.handleClipboardImagePaste(this); }
	handlePastedImagePath(filePath: string): void { keyHandlers.handlePastedImagePath(this, filePath); }
	getSlashCommandContext() { return inputRouter.getSlashCommandContext(this); }
	updatePendingMessagesDisplay(): void { inputRouter.updatePendingMessagesDisplay(this); }
	restoreQueuedMessagesToEditor(options?: Parameters<typeof inputRouter.restoreQueuedMessagesToEditor>[1]): number { return inputRouter.restoreQueuedMessagesToEditor(this, options); }
	queueCompactionMessage(text: string, mode: "steer" | "followUp"): void { inputRouter.queueCompactionMessage(this, text, mode); }
	isExtensionCommand(text: string): boolean { return inputRouter.isExtensionCommand(this, text); }
	isKnownSlashCommand(text: string): boolean { return inputRouter.isKnownSlashCommand(this, text); }
	async flushCompactionQueue(options?: Parameters<typeof inputRouter.flushCompactionQueue>[1]): Promise<void> { return inputRouter.flushCompactionQueue(this, options); }
	flushPendingBashComponents(): void { inputRouter.flushPendingBashComponents(this); }
	updateTerminalTitle(): void { modeInit.updateTerminalTitle(this); }

	showStatus(message: string, options?: { append?: boolean }): void { chatRender.showStatus(this, message, options); }
	addMessageToChat(message: import("@gsd/pi-agent-core").AgentMessage, options?: { populateHistory?: boolean }): void { chatRender.addMessageToChat(this, message, options); }
	rebuildChatFromMessages(): void { chatRender.rebuildChatFromMessages(this); }

	isShuttingDown = false;
	async shutdown(): Promise<void> { return keyHandlers.shutdown(this); }
	async checkShutdownRequested(): Promise<void> { return keyHandlers.checkShutdownRequested(this); }
	handleCtrlZ(): void { keyHandlers.handleCtrlZ(this); }
	async handleFollowUp(): Promise<void> { return keyHandlers.handleFollowUp(this); }
	handleDequeue(): void { keyHandlers.handleDequeue(this); }
	updateEditorBorderColor(): void { keyHandlers.updateEditorBorderColor(this); }
	cycleThinkingLevel(): void { keyHandlers.cycleThinkingLevel(this); }
	async cycleModel(direction: "forward" | "backward"): Promise<void> { return keyHandlers.cycleModel(this, direction); }
	toggleToolOutputExpansion(): void { keyHandlers.toggleToolOutputExpansion(this); }
	setToolsExpanded(expanded: boolean): void { keyHandlers.setToolsExpanded(this, expanded); }
	toggleGsdStatusWidget(): void {
		// Compute the effective expansion so the toggle always visually flips:
		// undefined = use widgetMode default, otherwise use the explicit value.
		const progress = this.gsdProgressState;
		const defaultExpanded = progress !== undefined && progress.widgetMode !== "min";
		const currentlyExpanded = this.gsdStatusExpanded !== undefined ? this.gsdStatusExpanded : defaultExpanded;
		this.gsdStatusExpanded = !currentlyExpanded;
		this.gsdStatusWidget.invalidate();
		this.footer.invalidate();
		this.ui.requestRender();
	}
	setToolRailAnimation(enabled: boolean): void {
		this.settingsManager.setToolRailAnimation(enabled);
		setRailAnimationEnabled(enabled);
		for (const child of this.chatContainer.children) {
			if (child instanceof ToolExecutionComponent) child.refreshRailAnimation();
		}
		this.ui.requestRender();
	}
	toggleThinkingBlockVisibility(): void { keyHandlers.toggleThinkingBlockVisibility(this); }
	openExternalEditor(): void { keyHandlers.openExternalEditor(this); }

	showSelector(create: Parameters<typeof selectors.showSelector>[1]): void { selectors.showSelector(this, create); }
	showSettingsSelector(): void { selectors.showSettingsSelector(this); }
	async handleModelCommand(searchTerm?: string): Promise<void> { return selectors.handleModelCommand(this, searchTerm); }
	async updateAvailableProviderCount(): Promise<void> { return selectors.updateAvailableProviderCount(this); }
	showModelSelector(initialSearchInput?: string): void { selectors.showModelSelector(this, initialSearchInput); }
	async showModelsSelector(): Promise<void> { return selectors.showModelsSelector(this); }
	showUserMessageSelector(): void { selectors.showUserMessageSelector(this); }
	showTreeSelector(initialSelectedId?: string): void { selectors.showTreeSelector(this, initialSelectedId); }
	showSessionSelector(): void { selectors.showSessionSelector(this); }
	async handleResumeSession(sessionPath: string): Promise<void> { return selectors.handleResumeSession(this, sessionPath); }
	showProviderManager(): void { selectors.showProviderManager(this); }
	async showOAuthSelector(mode: "login" | "logout"): Promise<void> { return selectors.showOAuthSelector(this, mode); }
	async showLoginDialog(providerId: string): Promise<void> { return selectors.showLoginDialog(this, providerId); }

	async handleReloadCommand(): Promise<void> { return commandHandlers.handleReloadCommand(this); }
	async handleClearCommand(): Promise<void> { return commandHandlers.handleClearCommand(this); }
	handleDebugCommand(): void { commandHandlers.handleDebugCommand(this); }
	handleDaxnuts(): void { commandHandlers.handleDaxnuts(this); }
	checkDaxnutsEasterEgg(model: { provider: string; id: string }): void { commandHandlers.checkDaxnutsEasterEgg(this, model); }
	async handleBashCommand(command: string, excludeFromContext?: boolean, displayCommand?: string, loginShell?: boolean): Promise<void> { return commandHandlers.handleBashCommand(this, command, excludeFromContext, displayCommand, loginShell); }
	async executeCompaction(customInstructions?: string, isAuto?: boolean) { return commandHandlers.executeCompaction(this, customInstructions, isAuto); }
}
