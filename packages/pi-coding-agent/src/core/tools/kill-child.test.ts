import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { test } from "node:test";
import { killChildWithEscalation } from "./kill-child.js";

const GRACE_MS = 150;

/** Spawns `setup` then idles, resolving once the child has announced readiness. */
async function spawnReadyChild(setup: string): Promise<ChildProcess> {
	const child = spawn("sh", ["-c", `${setup}\necho ready\nwhile true; do sleep 0.05; done`], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
	return child;
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

test("escalates to SIGKILL when the child ignores SIGTERM", async (t) => {
	const child = await spawnReadyChild('trap "" TERM');
	t.after(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
	const exited = waitForExit(child);

	killChildWithEscalation(child, GRACE_MS);

	assert.equal((await exited).signal, "SIGKILL");
});

test("leaves a child that honours SIGTERM alone", async () => {
	const child = await spawnReadyChild("");
	const exited = waitForExit(child);

	const cancel = killChildWithEscalation(child, GRACE_MS);
	const result = await exited;
	cancel();

	assert.equal(result.signal, "SIGTERM");
});

test("does not signal a child that has already exited", async () => {
	const child = spawn("sh", ["-c", "exit 0"], { stdio: ["ignore", "pipe", "pipe"] });
	await waitForExit(child);

	killChildWithEscalation(child, GRACE_MS);

	assert.equal(child.signalCode, null);
});
