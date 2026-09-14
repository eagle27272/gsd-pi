import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CompactionEntry } from "@gsd/pi-coding-agent/core/session-manager.js";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { SettingsManager } from "@gsd/pi-coding-agent/core/settings-manager.js";
import { AgentSessionCompactionModule } from "./agent-session-compaction.ts";
import type { AgentSessionHost } from "./agent-session-host.js";

function makeCompactionModule(overrides: Partial<Record<string, unknown>> = {}): {
	module: AgentSessionCompactionModule;
	calls: string[];
} {
	const calls: string[] = [];
	const host = {
		disconnectFromAgent: () => calls.push("disconnect"),
		reconnectToAgent: () => calls.push("reconnect"),
		abort: async () => {
			calls.push("abort");
		},
		emit: () => {},
		model: undefined,
		_extensionRunner: { hasHandlers: () => false, emit: async () => undefined },
		...overrides,
	} as unknown as AgentSessionHost;
	return { module: new AgentSessionCompactionModule(host), calls };
}

describe("AgentSessionCompactionModule.compact", () => {
	it("settles the in-flight turn before unsubscribing from the agent", async () => {
		const { module, calls } = makeCompactionModule();

		await assert.rejects(() => module.compact());

		assert.deepEqual(calls, ["abort", "disconnect", "reconnect"]);
	});

	it("reports the compaction it just appended, not an older one with the same summary", async () => {
		const sessionManager = SessionManager.inMemory("/tmp/gsd-compaction-test");
		sessionManager.newSession({ cwd: "/tmp/gsd-compaction-test" });

		const summary = "fixed template summary";
		const appendTurn = (text: string) => {
			sessionManager.appendMessage({ role: "user", content: text } as never);
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `reply to ${text}` }],
				stopReason: "stop",
			} as never);
		};

		appendTurn("first");
		const staleCompactionId = sessionManager.appendCompaction(summary, sessionManager.getBranch()[0].id, 100);
		appendTurn("second");

		const seen: CompactionEntry[] = [];
		const { module } = makeCompactionModule({
			model: { id: "test-model", provider: "test", contextWindow: 100_000 },
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			agent: { state: { messages: [] } },
			getCompactionRequestAuth: async () => ({ apiKey: "k", headers: {} }),
			_extensionRunner: {
				hasHandlers: (type: string) => type === "session_before_compact",
				emit: async (event: { type: string; compactionEntry?: CompactionEntry }) => {
					if (event.type === "session_before_compact") {
						return {
							compaction: {
								summary,
								firstKeptEntryId: sessionManager.getBranch().slice(-1)[0].id,
								tokensBefore: 200,
							},
						};
					}
					if (event.type === "session_compact" && event.compactionEntry) {
						seen.push(event.compactionEntry);
					}
					return undefined;
				},
			},
		});

		await module.compact();

		assert.equal(seen.length, 1);
		assert.notEqual(seen[0].id, staleCompactionId);
		assert.equal(seen[0].tokensBefore, 200);
	});
});
