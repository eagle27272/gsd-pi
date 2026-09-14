/**
 * Regression tests for execCommand's termination reporting.
 *
 * `waitForChildProcess` resolves a null code for a signal-terminated child.
 * Coalescing that null to zero reported an OOM-killed or externally `kill -9`'d
 * command — an interrupted `git commit`, say — as having succeeded.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand, MAX_EXEC_OUTPUT_BYTES } from "./exec.js";

const isWin = process.platform === "win32";

test(
	"execCommand reports an externally killed child as failed, not exit 0",
	{ skip: isWin ? "POSIX signal semantics" : false, timeout: 20_000 },
	async () => {
		// The child prints, then kills its own pid with SIGKILL. Nothing in-process
		// calls kill(), so this is the external-killer case: `killed` stays false and
		// the only evidence of death is the signal Node reports alongside a null code.
		const script = "process.stdout.write('partial\\n'); setTimeout(() => process.kill(process.pid, 'SIGKILL'), 50);";
		const result = await execCommand(process.execPath, ["-e", script], process.cwd());

		assert.equal(result.signal, "SIGKILL");
		assert.notEqual(result.code, 0, "a SIGKILLed command must not report success");
		assert.equal(result.killed, true, "a signal-terminated child was killed, however it was signalled");
		assert.match(result.stdout, /partial/, "partial output is still returned");
	},
);

test("execCommand reports a clean exit code with no signal", { timeout: 20_000 }, async () => {
	const result = await execCommand(process.execPath, ["-e", "process.exit(3)"], process.cwd());
	assert.equal(result.code, 3);
	assert.equal(result.signal, null);
	assert.equal(result.killed, false);
});

test("execCommand surfaces the spawn error when the binary does not exist", { timeout: 20_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "exec-enoent-"));
	try {
		const result = await execCommand(join(dir, "definitely-not-a-real-binary"), [], dir);
		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /ENOENT/, `spawn failure must be distinguishable from exit 1:\n${result.stderr}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("execCommand caps accumulated output instead of buffering without bound", { timeout: 60_000 }, async () => {
	const chunk = "x".repeat(64 * 1024);
	const iterations = Math.ceil((MAX_EXEC_OUTPUT_BYTES * 2) / chunk.length);
	const script = `const c = 'x'.repeat(${chunk.length}); for (let i = 0; i < ${iterations}; i++) process.stdout.write(c);`;
	const result = await execCommand(process.execPath, ["-e", script], process.cwd(), {
		maxOutputBytes: 256 * 1024,
	});

	assert.equal(result.code, 0);
	assert.ok(
		result.stdout.length < 256 * 1024 + 1024,
		`stdout should be capped near the limit, got ${result.stdout.length} bytes`,
	);
	assert.match(result.stdout, /output truncated/i);
});
