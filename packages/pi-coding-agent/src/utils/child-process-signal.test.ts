/**
 * Regression tests: waitForChildProcess must surface the terminating signal.
 *
 * Node delivers `(code, signal)` on `exit`/`close`. For a signal-terminated child
 * `code` is null, so a resolver that returns only the code makes an OOM-killed or
 * `kill -9`'d child indistinguishable from a clean `exit 0` once callers coalesce
 * null to zero. Every consumer needs the signal to tell those apart.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { waitForChildProcess } from "./child-process.js";

const isWin = process.platform === "win32";

/** Resolve once the child has printed its readiness marker, so the kill lands on a live process. */
function onceReady(child: ReturnType<typeof spawn>): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("child never signalled readiness")), 10_000);
		child.stdout?.on("data", (data: Buffer) => {
			if (data.toString().includes("READY")) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
}

test(
	"waitForChildProcess reports the terminating signal for an externally killed child",
	{ skip: isWin ? "POSIX signal semantics" : false, timeout: 20_000 },
	async () => {
		const child = spawn(process.execPath, ["-e", "console.log('READY'); setInterval(() => {}, 1000);"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		await onceReady(child);

		// Kill by pid rather than child.kill() so `child.killed` stays false — this is
		// the OOM-killer / external `kill -9` case, where nothing in-process knows.
		process.kill(child.pid!, "SIGKILL");

		const result = await waitForChildProcess(child);
		assert.equal(result.code, null, "a signal-terminated child has no exit code");
		assert.equal(result.signal, "SIGKILL");
		assert.equal(child.killed, false, "external kill must not set the in-process killed flag");
	},
);

test("waitForChildProcess reports the exit code with no signal for a normal exit", { timeout: 20_000 }, async () => {
	const child = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: ["ignore", "pipe", "pipe"] });
	const result = await waitForChildProcess(child);
	assert.deepEqual(result, { code: 7, signal: null });
});
