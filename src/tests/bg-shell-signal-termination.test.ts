// gsd-pi — bg_shell must not mask the default termination action of SIGTERM/SIGINT.
//
// Registering ANY JS listener for a signal makes Node stop the libuv watcher from
// falling through to SIG_DFL, so a cleanup-only handler silently turns the host
// immortal: `kill <gsd-pid>` and Ctrl-C in headless mode run bg_shell's cleanup and
// the host keeps running. These tests spawn a real host child, signal it, and assert
// both that cleanup ran AND that the host actually died.
//
// The third test is the counterweight: handleCtrlZ (interactive-key-handlers.ts)
// installs a temporary ignore-SIGINT listener so Ctrl-C cannot kill a Ctrl-Z
// suspended host. bg_shell must defer to a listener like that instead of
// force-exiting over the top of it.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// dist-test keeps the original .ts sources alongside the compiled .js, so this
// resolves in both the compiled run and a direct source run.
const signalHandlersHref = pathToFileURL(
	join(__dirname, "..", "resources", "extensions", "bg-shell", "signal-handlers.ts"),
).href;

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const stripTypesSkipReason =
	nodeMajor! > 22 || (nodeMajor === 22 && nodeMinor! >= 6)
		? undefined
		: "--experimental-strip-types requires Node 22.6+";

// Signals only; Windows has no deliverable SIGTERM/SIGINT for a spawned child.
const windowsSkipReason =
	process.platform === "win32" ? "POSIX signal delivery is not emulated on Windows" : undefined;

interface HostExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

interface HostHandle {
	child: ChildProcess;
	/** Resolves with how the host died, or null if it outlived `timeoutMs`. */
	waitForExit: (timeoutMs: number) => Promise<HostExit | null>;
	hasExited: () => boolean;
}

/**
 * Spawn a host process that installs bg_shell's signal handlers over a cleanup
 * callback which touches `markerPath`, then stays alive on a timer. Resolves
 * once the host reports it is ready to be signalled.
 *
 * The host is SIGKILLed on test teardown: a host that wrongly survives its signal
 * would otherwise keep its stdio pipes open and hang the whole runner.
 */
async function startHost(
	t: { after: (fn: () => void) => void },
	markerPath: string,
	opts: { foreignSigintListener: boolean },
): Promise<HostHandle> {
	const script = [
		`import { writeFileSync } from "node:fs";`,
		`import { installBgShellSignalHandlers } from ${JSON.stringify(signalHandlersHref)};`,
		`installBgShellSignalHandlers(() => { writeFileSync(${JSON.stringify(markerPath)}, "cleaned"); });`,
		opts.foreignSigintListener
			? // Stand-in for handleCtrlZ's ignoreSigint guard.
				`process.on("SIGINT", () => {});`
			: "",
		`setInterval(() => {}, 1000);`,
		`process.stdout.write("ready\\n");`,
	].join("\n");

	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "-e", script],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	t.after(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	});

	let stderr = "";
	child.stderr!.setEncoding("utf-8");
	child.stderr!.on("data", (chunk: string) => {
		stderr += chunk;
	});

	let exitResult: HostExit | null = null;
	const exit = new Promise<HostExit>((resolve) => {
		child.once("exit", (code, signal) => {
			exitResult = { code, signal };
			resolve(exitResult);
		});
	});

	await new Promise<void>((resolve, reject) => {
		let stdout = "";
		child.stdout!.setEncoding("utf-8");
		child.stdout!.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.includes("ready")) resolve();
		});
		child.once("exit", () =>
			reject(new Error(`host exited before becoming ready. stderr: ${stderr}`)),
		);
	});

	return {
		child,
		hasExited: () => exitResult !== null,
		waitForExit: (timeoutMs: number) =>
			new Promise<HostExit | null>((resolve) => {
				const timer = setTimeout(() => resolve(null), timeoutMs);
				void exit.then((result) => {
					clearTimeout(timer);
					resolve(result);
				});
			}),
	};
}

/** Poll until `predicate` holds, or throw after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

function makeMarkerPath(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "bg-shell-signal-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "cleanup-ran");
}

describe("bg_shell signal handlers preserve default termination", { skip: stripTypesSkipReason ?? windowsSkipReason }, () => {
	test("SIGTERM runs cleanup and still terminates the host", { timeout: 30_000 }, async (t) => {
		const markerPath = makeMarkerPath(t);
		const host = await startHost(t, markerPath, { foreignSigintListener: false });

		host.child.kill("SIGTERM");
		const exit = await host.waitForExit(10_000);

		assert.equal(existsSync(markerPath), true, "cleanup callback should have run");
		assert.ok(exit, "host survived SIGTERM — bg_shell masked the default termination action");
		assert.ok(
			exit.signal === "SIGTERM" || exit.code === 143,
			`host should die from SIGTERM, got code=${exit.code} signal=${exit.signal}`,
		);
	});

	test("SIGINT runs cleanup and still terminates the host", { timeout: 30_000 }, async (t) => {
		const markerPath = makeMarkerPath(t);
		const host = await startHost(t, markerPath, { foreignSigintListener: false });

		host.child.kill("SIGINT");
		const exit = await host.waitForExit(10_000);

		assert.equal(existsSync(markerPath), true, "cleanup callback should have run");
		assert.ok(exit, "host survived SIGINT — bg_shell masked the default termination action");
		assert.ok(
			exit.signal === "SIGINT" || exit.code === 130,
			`host should die from SIGINT, got code=${exit.code} signal=${exit.signal}`,
		);
	});

	test("SIGINT leaves the host alive when another listener owns the signal", { timeout: 30_000 }, async (t) => {
		const markerPath = makeMarkerPath(t);
		const host = await startHost(t, markerPath, { foreignSigintListener: true });

		host.child.kill("SIGINT");

		// Cleanup still runs — bg_shell defers the *termination* decision, not the reaping.
		await waitFor(() => existsSync(markerPath), 10_000, "cleanup callback to run");

		// handleCtrlZ's ignoreSigint guard must win: the host survives.
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(
			host.hasExited(),
			false,
			"host must survive SIGINT while another listener owns the signal",
		);
	});
});
