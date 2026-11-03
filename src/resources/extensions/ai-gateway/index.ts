import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { buildBaseUrl, readLauncherConfig } from "./launcher-config.js";
import { buildGatewayModels } from "./models.js";
import { createTokenRefresher, type TokenCredentials } from "./token.js";

const PROVIDER_ID = "ai-gateway";
const CLIENT_LABEL = "gsd-pi";
// The gateway only accepts this shape for X-JH-Session-Id; anything else would be dropped or rejected.
const SESSION_LABEL_RE = /^[A-Za-z0-9-]{8,64}$/;

type RefreshToken = (credentials?: unknown) => Promise<TokenCredentials>;

function register(pi: ExtensionAPI, refresh: RefreshToken, sessionId?: string): boolean {
	const config = readLauncherConfig();
	if (!config) return false;

	const headers: Record<string, string> = { "X-JH-Client": CLIENT_LABEL };
	if (sessionId && SESSION_LABEL_RE.test(sessionId)) headers["X-JH-Session-Id"] = sessionId;

	pi.registerProvider(PROVIDER_ID, {
		name: "AI Gateway",
		api: "anthropic-messages",
		baseUrl: buildBaseUrl(config),
		headers,
		models: buildGatewayModels(config.models),
		isReady: () => readLauncherConfig() !== null,
		oauth: {
			name: "AI Gateway (claude-ai-gw)",
			login: async () => refresh(),
			refreshToken: async () => refresh(),
			getApiKey: (credentials) => credentials.access,
		},
	});
	return true;
}

export function createAiGateway(refresh: RefreshToken = createTokenRefresher()) {
	return function aiGateway(pi: ExtensionAPI): void {
		try {
			register(pi, refresh);
		} catch {
			// A broken launcher setup must not stop gsd from starting.
		}

		pi.on("session_start", (_event, ctx) => {
			try {
				pi.unregisterProvider(PROVIDER_ID);
			} catch {
				// Nothing was registered yet.
			}

			let sessionId: string | undefined;
			try {
				sessionId = ctx.sessionManager?.getSessionId();
			} catch {
				sessionId = undefined;
			}

			try {
				if (!register(pi, refresh, sessionId)) return;
			} catch {
				return;
			}

			// An expired placeholder makes the first request refresh through the launcher.
			const authStorage = ctx.modelRegistry?.authStorage;
			if (authStorage && authStorage.get(PROVIDER_ID) === undefined) {
				authStorage.set(PROVIDER_ID, { type: "oauth", access: "", refresh: "", expires: 0 });
			}
		});
	};
}

export default createAiGateway();
