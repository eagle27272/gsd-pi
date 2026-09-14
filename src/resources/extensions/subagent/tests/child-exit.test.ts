// Project/App: gsd-pi
// File Purpose: Regression tests for subagent child-process termination reporting.
//
// Node's `close` handler receives `(code, signal)`. A signal-killed child has a
// null code, so `code ?? 0` reported a SIGKILLed subagent as exit 0 — success —
// and everything downstream (merge gating, retry, run status) believed it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { isChildProcessRunning, resolveSubagentExitCode } from "../child-exit.js";

test("resolveSubagentExitCode reports a signal-terminated child as failed", () => {
	assert.notEqual(resolveSubagentExitCode(null, "SIGKILL"), 0);
	assert.notEqual(resolveSubagentExitCode(null, "SIGTERM"), 0);
});

test("resolveSubagentExitCode passes a normal exit code through", () => {
	assert.equal(resolveSubagentExitCode(0, null), 0);
	assert.equal(resolveSubagentExitCode(7, null), 7);
});

test("resolveSubagentExitCode reports an unknown termination as failed", () => {
	assert.notEqual(resolveSubagentExitCode(null, null), 0);
});

test("isChildProcessRunning tracks liveness, not whether a signal was sent", async () => {
	const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
	const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));

	assert.equal(isChildProcessRunning(proc), true, "a live child is running");

	proc.kill("SIGTERM");
	// `proc.killed` flips true the instant kill() is called, which is exactly why
	// it cannot gate a SIGKILL escalation — the child may still be very much alive.
	assert.equal(proc.killed, true);

	await exited;
	assert.equal(isChildProcessRunning(proc), false, "an exited child is not running");
});
