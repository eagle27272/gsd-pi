/**
 * Regression tests for installDetachedChildReaper.
 *
 * The bash tool spawns its shell with `detached: true`, putting the child in its
 * own process group. That isolation is deliberate, but it also means the child
 * does NOT die with the host on SIGHUP (terminal or SSH closed) or SIGTERM
 * (`kill`, supervisor stop). A survivor still holding `.git/index.lock` wedges
 * every later git write in the repo — which is why bash.ts records those pids
 * via trackDetachedChildPid. The registration is inert until something drains
 * the set on shutdown.
 *
 * Two properties are load-bearing, and each gets its own test:
 *   1. Tracked children actually die when the host is signalled.
 *   2. The host itself still dies. Registering ANY listener for a signal
 *      suppresses Node's default termination, so a handler that only cleaned up
 *      would leave `kill <host>` hanging forever.
 *
 * Property 2 has a sharp edge worth testing directly: re-raising works only while
 * ours is the LAST listener for that signal. A co-registered listener that does
 * not exit (bg-shell installs exactly one — bg-shell-lifecycle.ts) keeps Node's
 * OS-level handler installed, so the re-raise is queued as another JS callback
 * instead of terminating us, and the host survives. The reaper needs an explicit
 * exit fallback for that case.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { installDetachedChildReaper } from "./shell.js";

// These tests spawn POSIX `sleep` and rely on detached process groups surviving
// the parent's death, which is Unix-primary. On Windows bash.ts does not pass
// `detached` at all and `sleep` does not exist, so skip there.
const skipOnWindows = process.platform === "win32" ? "Unix-primary detached-process-group semantics" : false;

// CI runs this file compiled, where `shell.js` sits next to it. A TS-direct dev
// run has only `shell.ts`, and the repo's loader rewrites relative `.js` → `.ts`
// but not the absolute URL the host child needs — so address the file that
// actually exists rather than relying on that rewrite.
const isCompiledRun = existsSync(fileURLToPath(new URL("./shell.js", import.meta.url)));
const shellModuleUrl = new URL(isCompiledRun ? "./shell.js" : "./shell.ts", import.meta.url).href;

interface HostOptions {
	/** Install the reaper under test. */
	reaper: boolean;
	/**
	 * Register a non-exiting SIGTERM/SIGHUP listener before the reaper, mimicking
	 * the bg-shell extension's cleanup handlers.
	 */
	competingListener?: boolean;
}

/**
 * Source for a stand-in host process: it tracks one detached child exactly the
 * way bash.ts does, reports that child's pid on stdout, then idles until
 * signalled.
 *
 * The reaper import is emitted conditionally so the no-reaper control still runs
 * (and still proves the child survives) even when the export does not exist yet.
 */
function hostScript(options: HostOptions): string {
	const lines = [
		`import { spawn } from "node:child_process";`,
		`import { trackDetachedChildPid } from ${JSON.stringify(shellModuleUrl)};`,
	];
	if (options.reaper) {
		lines.push(`import { installDetachedChildReaper } from ${JSON.stringify(shellModuleUrl)};`);
	}
	if (options.competingListener) {
		lines.push(`process.on("SIGTERM", () => {});`, `process.on("SIGHUP", () => {});`);
	}
	if (options.reaper) {
		lines.push(`installDetachedChildReaper();`);
	}
	lines.push(
		`const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });`,
		`child.unref();`,
		`trackDetachedChildPid(child.pid);`,
		`process.stdout.write(child.pid + "\\n");`,
		`setInterval(() => {}, 1000);`,
	);
	return lines.join("\n");
}

/**
 * Node flags the host child needs in order to import the shell module.
 *
 * Under the compiled dist-test run (what CI executes) the child needs nothing.
 * A TS-direct dev run hands it a `.ts` entry, so it needs the same `--import`
 * type-stripping loader the test runner itself was started with. Node echoes its
 * defaults into execArgv in both `--import=x` and `--import x` forms, so dedupe
 * or the loader registers twice.
 */
function hostNodeFlags(): string[] {
	if (isCompiledRun) return [];

	const loaders = new Set<string>();
	const argv = process.execArgv;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg.startsWith("--import=")) {
			loaders.add(arg.slice("--import=".length));
		} else if (arg === "--import" && argv[index + 1]) {
			loaders.add(argv[++index]!);
		}
	}

	const flags = [...loaders].flatMap((loader) => ["--import", loader]);
	if (argv.includes("--experimental-strip-types")) flags.push("--experimental-strip-types");
	return flags;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// Poll until the process is gone (ESRCH). Rejects if it is still alive at the
// deadline, naming the pid so a failure is diagnosable.
async function waitUntilDead(pid: number, deadlineMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		if (!isAlive(pid)) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Process ${pid} still alive after ${deadlineMs}ms`);
}

function waitForChildExit(
	child: ChildProcess,
	deadlineMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Host pid=${child.pid ?? "unknown"} did not exit within ${deadlineMs}ms`)),
			deadlineMs,
		);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
}

interface StartedHost {
	host: ChildProcess;
	/** Pid of the detached `sleep` the host tracked. */
	trackedPid: number;
}

/**
 * Start a host and wait until it reports its tracked child's pid. Registers
 * cleanup for both processes so a failed assertion never leaks a `sleep 60`.
 */
async function startHost(t: { after: (fn: () => void) => void }, options: HostOptions): Promise<StartedHost> {
	const host = spawn(process.execPath, [...hostNodeFlags(), "--input-type=module", "--eval", hostScript(options)], {
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	host.stdout?.on("data", (chunk) => {
		stdout += String(chunk);
	});
	host.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});

	const trackedPid = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(
			// Surface the host's stderr: when the export under test is missing, the
			// module-resolution error is the whole story and is otherwise invisible.
			() => reject(new Error(`Host never reported a tracked pid.\nstdout: ${stdout}\nstderr: ${stderr}`)),
			10_000,
		);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
		const check = setInterval(() => {
			const newline = stdout.indexOf("\n");
			if (newline === -1) return;
			const parsed = Number.parseInt(stdout.slice(0, newline).trim(), 10);
			clearInterval(check);
			clearTimeout(timer);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				reject(new Error(`Host reported an unusable pid: ${JSON.stringify(stdout)}`));
				return;
			}
			resolve(parsed);
		}, 25);
		if (typeof check === "object" && "unref" in check) check.unref();
		host.once("exit", (code, signal) => {
			clearInterval(check);
			clearTimeout(timer);
			reject(new Error(`Host exited early (code=${code}, signal=${signal}).\nstderr: ${stderr}`));
		});
	});

	t.after(() => {
		try {
			process.kill(-trackedPid, "SIGKILL");
		} catch {
			/* already gone */
		}
		try {
			process.kill(host.pid!, "SIGKILL");
		} catch {
			/* already gone */
		}
	});

	return { host, trackedPid };
}

// ------------------------------------------------------------------
// Control: proves the other tests are not vacuous. If a detached child died
// with its host anyway, every assertion below would pass without a reaper.
// ------------------------------------------------------------------
test(
	"detached child outlives a SIGTERMed host when no reaper is installed",
	{ timeout: 20_000, skip: skipOnWindows },
	async (t) => {
		const { host, trackedPid } = await startHost(t, { reaper: false });

		process.kill(host.pid!, "SIGTERM");
		const { signal } = await waitForChildExit(host, 8_000);
		assert.equal(signal, "SIGTERM", "host without listeners should die by SIGTERM's default action");

		// Give the child the same window the reaper tests allow before concluding.
		await new Promise((r) => setTimeout(r, 500));
		assert.ok(
			isAlive(trackedPid),
			"detached child should survive its host — this is the leak the reaper exists to close",
		);
	},
);

test(
	"installDetachedChildReaper reaps tracked detached children on host SIGTERM",
	{ timeout: 20_000, skip: skipOnWindows },
	async (t) => {
		const { host, trackedPid } = await startHost(t, { reaper: true });

		process.kill(host.pid!, "SIGTERM");
		const { signal } = await waitForChildExit(host, 8_000);

		assert.equal(signal, "SIGTERM", "host should still terminate by SIGTERM after the reaper re-raises it");
		await waitUntilDead(trackedPid, 8_000);
	},
);

test(
	"installDetachedChildReaper reaps tracked detached children on host SIGHUP",
	{ timeout: 20_000, skip: skipOnWindows },
	async (t) => {
		const { host, trackedPid } = await startHost(t, { reaper: true });

		process.kill(host.pid!, "SIGHUP");
		const { signal } = await waitForChildExit(host, 8_000);

		assert.equal(signal, "SIGHUP", "host should still terminate by SIGHUP after the reaper re-raises it");
		await waitUntilDead(trackedPid, 8_000);
	},
);

// ------------------------------------------------------------------
// The bg-shell shape: another listener for the same signal is registered, so
// Node keeps its OS-level handler installed and the reaper's re-raise is queued
// as a JS callback rather than terminating the host. Without an explicit exit
// fallback the host would hang here forever.
// ------------------------------------------------------------------
test(
	"installDetachedChildReaper still terminates the host when another listener swallows the re-raise",
	{ timeout: 20_000, skip: skipOnWindows },
	async (t) => {
		const { host, trackedPid } = await startHost(t, { reaper: true, competingListener: true });

		process.kill(host.pid!, "SIGTERM");
		const { code } = await waitForChildExit(host, 8_000);

		assert.equal(
			code,
			128 + constants.signals.SIGTERM,
			"host should exit 128+SIGTERM so the shell still reports a SIGTERM death",
		);
		await waitUntilDead(trackedPid, 8_000);
	},
);

// ------------------------------------------------------------------
// Bookkeeping: safe to call twice, and uninstall leaves the process exactly as
// it found it. Runs in-process on every platform.
// ------------------------------------------------------------------
test("installDetachedChildReaper is idempotent and its uninstall removes only its own listeners", () => {
	const baselineTerm = process.listenerCount("SIGTERM");
	const baselineHup = process.listenerCount("SIGHUP");

	const uninstall = installDetachedChildReaper();
	const uninstallAgain = installDetachedChildReaper();

	assert.equal(process.listenerCount("SIGTERM"), baselineTerm + 1, "second install should not stack a listener");
	assert.equal(process.listenerCount("SIGHUP"), baselineHup + 1, "second install should not stack a listener");

	uninstallAgain();
	assert.equal(process.listenerCount("SIGTERM"), baselineTerm);
	assert.equal(process.listenerCount("SIGHUP"), baselineHup);

	uninstall();
	assert.equal(process.listenerCount("SIGTERM"), baselineTerm, "uninstalling twice should be a no-op");
	assert.equal(process.listenerCount("SIGHUP"), baselineHup, "uninstalling twice should be a no-op");
});
