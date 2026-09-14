/**
 * Child-process termination helpers for the subagent runner.
 *
 * Node reports termination as `(code, signal)`, and exactly one of the two is
 * non-null. Collapsing that pair to just the code loses the difference between
 * "exited cleanly" and "was killed", which is the difference between merging a
 * subagent's work and discarding it.
 */

/** Exit code stood in for a child that was killed rather than exiting on its own. */
const KILLED_EXIT_CODE = 1;

/**
 * Collapse Node's `(code, signal)` pair into a single exit code.
 *
 * A signal-terminated child has a null code; reporting 0 for it would make a
 * SIGKILLed subagent — OOM killer, supervisor, `kill -9` — look successful.
 * A null code with no signal is likewise unknown, never success.
 */
export function resolveSubagentExitCode(code: number | null, signal: NodeJS.Signals | null): number {
	if (signal !== null) return KILLED_EXIT_CODE;
	return code ?? KILLED_EXIT_CODE;
}

/**
 * Whether a child is still alive.
 *
 * `ChildProcess.killed` only records that a signal was *sent*, so it is true the
 * instant `kill("SIGTERM")` returns and cannot gate a SIGKILL escalation. Actual
 * liveness is the absence of both an exit code and a signal code.
 */
export function isChildProcessRunning(proc: { exitCode: number | null; signalCode: NodeJS.Signals | null }): boolean {
	return proc.exitCode === null && proc.signalCode === null;
}
