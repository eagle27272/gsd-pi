import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

import type { Theme } from "@gsd/pi-coding-agent";

import { BgManagerOverlay } from "../resources/extensions/bg-shell/overlay.ts";
import {
	cleanupAll,
	processes,
	startProcess,
	terminateProcess,
} from "../resources/extensions/bg-shell/process-manager.ts";
import { waitForCondition } from "../resources/extensions/gsd/tests/test-helpers.ts";

const theme = {
	fg: (_color: unknown, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const noopTui = { requestRender: () => {} };

function isPidAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const sleeperCommand = "sleep 30";

function spawnSleeper(label: string) {
	return startProcess({ command: sleeperCommand, cwd: tmpdir(), label });
}

test("restart keeps the overlay selection anchored to the restarted process", async (t) => {
	cleanupAll();
	t.after(cleanupAll);

	const a = spawnSleeper("A");
	const b = spawnSleeper("B");
	const c = spawnSleeper("C");

	const overlay = new BgManagerOverlay(noopTui, theme, () => {});
	t.after(() => overlay.dispose());

	await waitForCondition(
		() => isPidAlive(a.proc.pid) && isPidAlive(b.proc.pid) && isPidAlive(c.proc.pid),
		{ timeoutMs: 5_000, description: "all three sleepers to be alive" },
	);

	overlay.handleInput("j"); // A -> B
	overlay.handleInput("r"); // restart B

	// restartProcess deletes B and re-inserts it under a fresh id, so the Map's
	// insertion order becomes [A, C, B'] — index 1 now resolves to C.
	const restarted = await waitForCondition(
		() => {
			if (processes.has(b.id) || processes.size !== 3) return null;
			return Array.from(processes.values()).find((p) => p.label === "B") ?? null;
		},
		{ timeoutMs: 15_000, description: "B to be restarted under a new id" },
	);

	overlay.handleInput("x"); // kill selected

	await waitForCondition(() => !isPidAlive(restarted.proc.pid), {
		timeoutMs: 10_000,
		description: "the restarted process to be killed",
	});
	assert.equal(isPidAlive(c.proc.pid), true, "kill must not hit the process that shifted into the old index");
	assert.equal(isPidAlive(a.proc.pid), true, "kill must not hit an unrelated process");
});

test("overlay selection survives a process disappearing from the registry", async (t) => {
	cleanupAll();
	t.after(cleanupAll);

	const a = spawnSleeper("A");
	const b = spawnSleeper("B");
	const c = spawnSleeper("C");

	const overlay = new BgManagerOverlay(noopTui, theme, () => {});
	t.after(() => overlay.dispose());

	await waitForCondition(
		() => isPidAlive(a.proc.pid) && isPidAlive(b.proc.pid) && isPidAlive(c.proc.pid),
		{ timeoutMs: 5_000, description: "all three sleepers to be alive" },
	);

	overlay.handleInput("j");
	overlay.handleInput("j"); // select C

	// A dead entry aged out by pruneDeadProcesses shifts every later row up by one.
	terminateProcess(a.id, 200);
	await waitForCondition(() => !isPidAlive(a.proc.pid), {
		timeoutMs: 10_000,
		description: "A to exit before it is pruned",
	});
	processes.delete(a.id);

	overlay.handleInput("x");

	await waitForCondition(() => !isPidAlive(c.proc.pid), {
		timeoutMs: 10_000,
		description: "the selected process C to be killed",
	});
	assert.equal(isPidAlive(b.proc.pid), true, "B must not be killed after the list shifted");
});

test("overlay renders without throwing at pathological widths", (t) => {
	cleanupAll();
	t.after(cleanupAll);

	const overlay = new BgManagerOverlay(noopTui, theme, () => {});
	t.after(() => overlay.dispose());

	for (const width of [1, 2, 3, 4, 50]) {
		overlay.invalidate();
		assert.doesNotThrow(() => overlay.render(width), `render(${width}) should not throw`);
	}
});
