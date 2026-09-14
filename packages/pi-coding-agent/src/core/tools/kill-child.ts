import type { ChildProcess } from "node:child_process";
import { SIGKILL_GRACE_MS } from "../../utils/shell.js";

/**
 * Terminate a spawned search tool, escalating to SIGKILL when it ignores SIGTERM.
 *
 * `ChildProcess.killed` only records that a signal was sent, so a SIGTERM-immune
 * `rg`/`fd` would otherwise be orphaned for the lifetime of the host.
 *
 * Returns a disposer that cancels the pending escalation; call it once the child
 * has been reaped.
 */
export function killChildWithEscalation(child: ChildProcess, graceMs: number = SIGKILL_GRACE_MS): () => void {
	if (child.exitCode !== null || child.signalCode !== null) return () => {};
	child.kill("SIGTERM");
	const escalation = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, graceMs);
	escalation.unref?.();
	return () => clearTimeout(escalation);
}
