import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import type { AgentSession } from "./agent-session.js";
import { AgentSessionRuntime } from "./agent-session-runtime.ts";
import type { AgentSessionServices } from "./agent-session-services.js";

const CWD = "/tmp/gsd-fork-test";

function makeInMemorySessionWithTwoTurns(): SessionManager {
	const sessionManager = SessionManager.inMemory(CWD);
	sessionManager.newSession({ cwd: CWD });
	for (const text of ["first", "second"]) {
		sessionManager.appendMessage({ role: "user", content: text } as never);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `reply to ${text}` }],
			stopReason: "stop",
		} as never);
	}
	return sessionManager;
}

interface ShutdownObservation {
	sessionId: string;
	entryCount: number;
	disposedSessionId: string;
}

function makeRuntime(sessionManager: SessionManager, observed: ShutdownObservation[]): AgentSessionRuntime {
	const session = {
		sessionManager,
		get sessionFile() {
			return sessionManager.getSessionFile();
		},
		get sessionId() {
			return sessionManager.getSessionId();
		},
		extensionRunner: {
			hasHandlers: (type: string) => type === "session_shutdown",
			emit: async () => {
				observed.push({
					sessionId: sessionManager.getSessionId(),
					entryCount: sessionManager.getEntries().length,
					disposedSessionId: "",
				});
				return undefined;
			},
		},
		dispose: () => {
			const last = observed[observed.length - 1];
			if (last) last.disposedSessionId = sessionManager.getSessionId();
		},
	} as unknown as AgentSession;

	const services = { cwd: CWD, agentDir: "/tmp/gsd-fork-test-agent" } as unknown as AgentSessionServices;

	return new AgentSessionRuntime(session, services, async () => ({ session, services, diagnostics: [] }) as never);
}

describe("AgentSessionRuntime.fork with an in-memory session", () => {
	it("tears the current session down before the shared manager is re-pointed", async () => {
		const sessionManager = makeInMemorySessionWithTwoTurns();
		const entriesBefore = sessionManager.getEntries().length;
		const sessionIdBefore = sessionManager.getSessionId();
		const observed: ShutdownObservation[] = [];

		const forkTarget = sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user");
		assert.ok(forkTarget);

		await makeRuntime(sessionManager, observed).fork(forkTarget.id, { position: "at" });

		assert.equal(observed.length, 1);
		assert.equal(observed[0].sessionId, sessionIdBefore);
		assert.equal(observed[0].entryCount, entriesBefore);
		assert.equal(observed[0].disposedSessionId, sessionIdBefore);
		assert.notEqual(sessionManager.getSessionId(), sessionIdBefore);
	});

	it("tears down before a full reset when forking to a new empty session", async () => {
		const sessionManager = makeInMemorySessionWithTwoTurns();
		const entriesBefore = sessionManager.getEntries().length;
		const sessionIdBefore = sessionManager.getSessionId();
		const observed: ShutdownObservation[] = [];

		const firstUserEntry = sessionManager.getBranch().find((e) => e.type === "message" && e.message.role === "user");
		assert.ok(firstUserEntry);

		await makeRuntime(sessionManager, observed).fork(firstUserEntry.id, { position: "before" });

		assert.equal(observed.length, 1);
		assert.equal(observed[0].sessionId, sessionIdBefore);
		assert.equal(observed[0].entryCount, entriesBefore);
		assert.equal(observed[0].disposedSessionId, sessionIdBefore);
	});
});
