/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.js";
import { trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.js";

/**
 * Per-stream ceiling on buffered output. `execCommand` holds stdout and stderr
 * entirely in memory, so a runaway command (a `find /`, a looping build) would
 * otherwise grow the heap until the host dies.
 */
export const MAX_EXEC_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/** Per-stream buffered output ceiling. Defaults to {@link MAX_EXEC_OUTPUT_BYTES}. */
	maxOutputBytes?: number;
	/**
	 * Data to write to the child's stdin, which is then closed. Use this rather
	 * than an argv element for secrets — argv is world-readable via `ps`.
	 */
	stdin?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	/**
	 * True when the child died from a signal, whether we sent it (timeout, abort)
	 * or something outside the process did (OOM killer, `kill -9`, a supervisor).
	 */
	killed: boolean;
	/** Terminating signal, or null when the child exited normally. */
	signal: NodeJS.Signals | null;
}

/** Bounded string accumulator: keeps the first `limit` bytes and records the overflow. */
function createOutputBuffer(limit: number) {
	const chunks: string[] = [];
	let bytes = 0;
	let dropped = 0;
	return {
		append(data: Buffer): void {
			if (bytes >= limit) {
				dropped += data.length;
				return;
			}
			const room = limit - bytes;
			if (data.length <= room) {
				chunks.push(data.toString());
				bytes += data.length;
				return;
			}
			chunks.push(data.subarray(0, room).toString());
			bytes = limit;
			dropped += data.length - room;
		},
		toString(): string {
			const text = chunks.join("");
			return dropped > 0 ? `${text}\n[output truncated at ${limit} bytes; ${dropped} more dropped]` : text;
		},
	};
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: [options?.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		// Register for shutdown reaping so a child cannot outlive the host holding a
		// lock (a stranded `git` keeps .git/index.lock and wedges every later write).
		if (proc.pid) trackDetachedChildPid(proc.pid);

		if (options?.stdin !== undefined) {
			// A child that exits before draining stdin gives us EPIPE; its real
			// exit code is already being captured below, so swallow the write error.
			proc.stdin?.on("error", () => {});
			proc.stdin?.end(options.stdin, "utf8");
		}

		const limit = options?.maxOutputBytes ?? MAX_EXEC_OUTPUT_BYTES;
		const stdout = createOutputBuffer(limit);
		const stderr = createOutputBuffer(limit);
		let spawnError: string | undefined;
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let escalationId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// Force kill after 5 seconds if SIGTERM doesn't work.
				// `subprocess.killed` only means kill() was called, not that the
				// process exited — check actual liveness, or a SIGTERM-immune
				// child would never be escalated and the caller would hang
				// forever despite passing `timeout`.
				escalationId = setTimeout(() => {
					if (proc.exitCode === null && proc.signalCode === null) {
						proc.kill("SIGKILL");
					}
				}, 5000);
				escalationId.unref?.();
			}
		};

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data: Buffer) => {
			stdout.append(data);
		});

		proc.stderr?.on("data", (data: Buffer) => {
			stderr.append(data);
		});

		const cleanup = () => {
			if (proc.pid) untrackDetachedChildPid(proc.pid);
			if (timeoutId) clearTimeout(timeoutId);
			if (escalationId) clearTimeout(escalationId);
			if (options?.signal) {
				options.signal.removeEventListener("abort", killProcess);
			}
		};

		const finish = (code: number, signal: NodeJS.Signals | null) => {
			cleanup();
			const stderrText = [stderr.toString(), spawnError].filter(Boolean).join("\n");
			resolve({ stdout: stdout.toString(), stderr: stderrText, code, killed: killed || signal !== null, signal });
		};

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then(({ code, signal }) => {
				// A signal-terminated child has no exit code. Reporting 0 here would
				// make an OOM-killed command look like it succeeded.
				finish(code ?? 1, signal);
			})
			.catch((err: unknown) => {
				// Spawn failures (ENOENT, EACCES) arrive here. Keeping the message is what
				// distinguishes "git is not installed" from "git exited 1".
				spawnError = err instanceof Error ? err.message : String(err);
				finish(1, null);
			});
	});
}
