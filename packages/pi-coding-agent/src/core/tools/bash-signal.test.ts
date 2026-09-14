/**
 * Regression test: a signal-terminated bash command must not report success.
 *
 * Timeout, abort and the hard-deadline force-kill all surface as thrown errors
 * before the exit code is inspected. The residual case — an external killer
 * (OOM, `kill -9`, a supervisor) — reaches the exit check with a null code,
 * which the tool used to wave through as a successful command with partial
 * output. Nothing downstream could tell that run apart from a clean exit 0.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "./bash.js";

const isWin = process.platform === "win32";

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n") ?? ""
	);
}

test(
	"bash tool fails a command whose shell is killed by a signal",
	{ skip: isWin ? "POSIX signal semantics" : false, timeout: 20_000 },
	async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "bash-signal-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));

		const bashTool = createBashTool(dir);
		// No timeout and no abort: the shell SIGKILLs itself, so the only evidence of
		// failure is the signal Node reports alongside a null exit code.
		let thrown: Error | undefined;
		try {
			const result = await bashTool.execute("bash-signal-test", { command: "printf 'PARTIAL\\n'; kill -9 $$" });
			assert.fail(`Expected a signal-killed command to fail, got: ${getTextOutput(result as any)}`);
		} catch (err) {
			thrown = err as Error;
		}

		assert.ok(thrown, "signal-killed command must throw");
		assert.match(thrown.message, /SIGKILL/, `Expected the signal named in:\n${thrown.message}`);
		assert.match(thrown.message, /PARTIAL/, `Expected partial output preserved in:\n${thrown.message}`);
	},
);

test("bash tool still succeeds for a normally exiting command", { timeout: 20_000 }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "bash-signal-ok-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const result = await createBashTool(dir).execute("bash-signal-ok", { command: "echo hello" });
	assert.match(getTextOutput(result as any), /hello/);
});
