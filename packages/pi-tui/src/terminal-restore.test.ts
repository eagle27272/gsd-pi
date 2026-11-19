import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ProcessTerminal } from "./terminal.ts";

function captureStdout() {
	const writes: string[] = [];
	const original = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
		return true;
	}) as typeof process.stdout.write;
	return {
		writes,
		restore: () => {
			process.stdout.write = original;
		},
	};
}

describe("ProcessTerminal.setTitle", () => {
	it("drops control characters so a title cannot inject escape sequences", () => {
		const capture = captureStdout();
		try {
			new ProcessTerminal().setTitle("proj\x07\x1b[2Jname\x9b");
		} finally {
			capture.restore();
		}

		assert.equal(capture.writes.join(""), "\x1b]0;proj[2Jname\x07");
	});
});

describe("ProcessTerminal.restoreModesForExit", () => {
	it("turns off every mode the terminal enabled", () => {
		const terminal = new ProcessTerminal() as any;
		terminal._kittyProtocolActive = true;
		terminal._modifyOtherKeysActive = true;
		terminal._mouseActive = true;
		const capture = captureStdout();
		try {
			terminal.restoreModesForExit();
		} finally {
			capture.restore();
		}

		const output = capture.writes.join("");
		assert.ok(output.includes("\x1b[?2004l"), "bracketed paste");
		assert.ok(output.includes("\x1b[<u"), "kitty keyboard protocol");
		assert.ok(output.includes("\x1b[>4;0m"), "modifyOtherKeys");
		assert.ok(output.includes("\x1b[?1000l") || output.includes("\x1b[?1006l"), "mouse reporting");
	});
});

describe("ProcessTerminal on a TTY", () => {
	const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();
	let killCalls: Array<[number, string | number | undefined]> = [];
	let originalKill: typeof process.kill;
	let capture: ReturnType<typeof captureStdout>;

	function stub(target: object, key: string, value: unknown) {
		savedDescriptors.set(`${(target as any) === process.stdout ? "stdout" : "stdin"}.${key}`, Object.getOwnPropertyDescriptor(target, key));
		Object.defineProperty(target, key, { value, configurable: true, writable: true });
	}

	beforeEach(() => {
		killCalls = [];
		originalKill = process.kill;
		stub(process.stdout, "isTTY", true);
		stub(process.stdin, "setRawMode", () => process.stdin);
		stub(process.stdin, "resume", () => process.stdin);
		stub(process.stdin, "setEncoding", () => process.stdin);
		capture = captureStdout();
	});

	afterEach(() => {
		capture.restore();
		process.kill = originalKill;
		for (const [name, descriptor] of savedDescriptors) {
			const [owner, key] = name.split(".");
			const target = owner === "stdout" ? process.stdout : process.stdin;
			if (descriptor) Object.defineProperty(target, key, descriptor);
			else delete (target as any)[key];
		}
		savedDescriptors.clear();
	});

	it("restores terminal modes when the process exits without stop()", () => {
		const before = process.listenerCount("exit");
		const terminal = new ProcessTerminal();
		process.kill = ((pid: number, signal?: string | number) => {
			killCalls.push([pid, signal]);
			return true;
		}) as typeof process.kill;

		terminal.start(
			() => {},
			() => {},
		);
		try {
			assert.equal(process.listenerCount("exit"), before + 1);
			capture.writes.length = 0;
			process.emit("exit", 0);
			assert.ok(capture.writes.join("").includes("\x1b[?2004l"));
		} finally {
			terminal.stop();
		}
		assert.equal(process.listenerCount("exit"), before, "stop() must remove the exit hook");
	});

	it("does not re-enable modifyOtherKeys after stop()", async () => {
		const terminal = new ProcessTerminal();
		process.kill = (() => true) as typeof process.kill;

		terminal.start(
			() => {},
			() => {},
		);
		terminal.stop();
		capture.writes.length = 0;
		await new Promise((resolve) => setTimeout(resolve, 250));

		assert.ok(!capture.writes.join("").includes("\x1b[>4;2m"));
	});

	it("still starts when the sandbox forbids SIGWINCH", () => {
		const terminal = new ProcessTerminal();
		process.kill = (() => {
			throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		}) as typeof process.kill;

		try {
			assert.doesNotThrow(() =>
				terminal.start(
					() => {},
					() => {},
				),
			);
		} finally {
			terminal.stop();
		}
	});
});
