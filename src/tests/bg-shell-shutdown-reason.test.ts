import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import { registerBgShellLifecycle } from "../resources/extensions/bg-shell/bg-shell-lifecycle.ts";
import {
	cleanupAll,
	getManifestPath,
	processes,
	startProcess,
} from "../resources/extensions/bg-shell/process-manager.ts";
import type { BgShellSharedState } from "../resources/extensions/bg-shell/index.ts";
import type { ProcessManifest } from "../resources/extensions/bg-shell/types.ts";
import { waitForCondition } from "../resources/extensions/gsd/tests/test-helpers.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
	} as unknown as ExtensionAPI;
	const fire = async (event: string, payload?: unknown, ctx?: unknown): Promise<void> => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	return { pi, fire };
}

function makeState(cwd: string, sessionFile: string): BgShellSharedState {
	return {
		latestCtx: {
			cwd,
			hasUI: false,
			sessionManager: { getSessionFile: () => sessionFile },
		} as unknown as ExtensionContext,
		refreshWidget: () => {},
	};
}

function isPidAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// Shell-native sleeper: exercises the real spawn path without platform-specific quoting.
const sleeperCommand = "sleep 30";

function makeTempCwd(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "bg-shell-shutdown-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("session_shutdown(new) reaps session-scoped processes but keeps persistent ones", async (t) => {
	t.after(cleanupAll);
	const cwd = makeTempCwd(t);
	const { pi, fire } = fakePi();
	registerBgShellLifecycle(pi, makeState(cwd, "session-a"));

	const scoped = startProcess({
		command: sleeperCommand,
		cwd,
		ownerSessionFile: "session-a",
		label: "scoped",
	});
	const persistent = startProcess({
		command: sleeperCommand,
		cwd,
		ownerSessionFile: "session-a",
		persistAcrossSessions: true,
		label: "persistent",
	});

	await waitForCondition(
		() => isPidAlive(scoped.proc.pid) && isPidAlive(persistent.proc.pid),
		{ timeoutMs: 5_000, description: "both spawned children to be alive" },
	);

	await fire("session_shutdown", {
		type: "session_shutdown",
		reason: "new",
		targetSessionFile: "session-b",
	});

	await waitForCondition(() => !isPidAlive(scoped.proc.pid), {
		timeoutMs: 5_000,
		description: "session-scoped child to exit",
	});
	assert.equal(
		isPidAlive(persistent.proc.pid),
		true,
		"persist_across_sessions process must survive a session transition",
	);
});

test("session_shutdown(new) writes the surviving processes to the manifest", async (t) => {
	t.after(cleanupAll);
	const cwd = makeTempCwd(t);
	const { pi, fire } = fakePi();
	registerBgShellLifecycle(pi, makeState(cwd, "session-a"));

	const scoped = startProcess({
		command: sleeperCommand,
		cwd,
		ownerSessionFile: "session-a",
		label: "scoped",
	});
	const persistent = startProcess({
		command: sleeperCommand,
		cwd,
		ownerSessionFile: "session-a",
		persistAcrossSessions: true,
		label: "persistent",
	});

	await waitForCondition(
		() => isPidAlive(scoped.proc.pid) && isPidAlive(persistent.proc.pid),
		{ timeoutMs: 5_000, description: "both spawned children to be alive" },
	);

	await fire("session_shutdown", {
		type: "session_shutdown",
		reason: "new",
		targetSessionFile: "session-b",
	});

	const manifest = JSON.parse(readFileSync(getManifestPath(cwd), "utf-8")) as ProcessManifest[];
	assert.deepEqual(
		manifest.map((entry) => entry.id),
		[persistent.id],
		"manifest should list exactly the processes that survived the transition",
	);
	assert.equal(manifest[0]?.pid, persistent.proc.pid);
});

test("session_shutdown(quit) tears down every tracked process", async (t) => {
	t.after(cleanupAll);
	const cwd = makeTempCwd(t);
	const { pi, fire } = fakePi();
	registerBgShellLifecycle(pi, makeState(cwd, "session-a"));

	const scoped = startProcess({
		command: sleeperCommand,
		cwd,
		ownerSessionFile: "session-a",
		label: "scoped",
	});
	const persistent = startProcess({
		command: sleeperCommand,
		cwd,
		ownerSessionFile: "session-a",
		persistAcrossSessions: true,
		label: "persistent",
	});

	await waitForCondition(
		() => isPidAlive(scoped.proc.pid) && isPidAlive(persistent.proc.pid),
		{ timeoutMs: 5_000, description: "both spawned children to be alive" },
	);

	await fire("session_shutdown", { type: "session_shutdown", reason: "quit" });

	await waitForCondition(
		() => !isPidAlive(scoped.proc.pid) && !isPidAlive(persistent.proc.pid),
		{ timeoutMs: 5_000, description: "all children to exit on quit" },
	);
	assert.equal(processes.size, 0, "quit should clear the registry");
});
