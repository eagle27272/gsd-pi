/**
 * bg_shell signal handling — run orphan cleanup on host termination.
 *
 * Node suppresses a signal's default termination action as soon as ANY JS
 * listener is registered for it (the libuv watcher stops falling through to
 * SIG_DFL). A cleanup-only handler therefore makes the host immortal: `kill
 * <pid>` and Ctrl-C in headless mode reap the background processes and the host
 * keeps running. These handlers restore the default by re-raising after cleanup.
 */

const SIGNAL_NUMBERS = {
	SIGINT: 2,
	SIGTERM: 15,
} as const;

type TerminatingSignal = keyof typeof SIGNAL_NUMBERS;

/**
 * Install the cleanup handlers. Returns an uninstall function that removes
 * every listener this call registered.
 */
export function installBgShellSignalHandlers(cleanup: () => void): () => void {
	const installed = new Map<TerminatingSignal, () => void>();

	for (const signal of Object.keys(SIGNAL_NUMBERS) as TerminatingSignal[]) {
		const handler = () => {
			cleanup();

			// Another listener suppressed the default action independently of us, so
			// the signal is theirs to interpret and terminating would override them.
			// The live case is handleCtrlZ's ignore-SIGINT listener, which exists so
			// Ctrl-C cannot kill a SIGTSTP-suspended host.
			if (process.listeners(signal).some((listener) => listener !== handler)) return;

			// We are the only reason the default was masked. Step aside and re-raise
			// so the host dies exactly as it would have with no listener at all.
			process.off(signal, handler);
			process.kill(process.pid, signal);

			// Reached only if the re-raise was swallowed anyway — a listener added
			// between the check and the raise, or a platform without real signals.
			process.exit(128 + SIGNAL_NUMBERS[signal]);
		};

		installed.set(signal, handler);
		process.on(signal, handler);
	}

	process.on("beforeExit", cleanup);

	return () => {
		for (const [signal, handler] of installed) process.off(signal, handler);
		process.off("beforeExit", cleanup);
	};
}
