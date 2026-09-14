/**
 * execCommand stdin support. Callers that need to hand a child a secret must be
 * able to do it over stdin — putting the value in argv exposes it to `ps`.
 */
import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.js";

const echoStdin = [
	"-e",
	"let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{process.stdout.write(b)});",
];

describe("execCommand stdin", () => {
	it("pipes the supplied string to the child's stdin", async () => {
		const res = await execCommand(process.execPath, echoStdin, process.cwd(), { stdin: "sk-secret-value" });
		expect(res.code).toBe(0);
		expect(res.stdout).toBe("sk-secret-value");
	});

	it("closes stdin so a reading child still exits when no stdin is supplied", async () => {
		const res = await execCommand(process.execPath, echoStdin, process.cwd());
		expect(res.code).toBe(0);
		expect(res.stdout).toBe("");
	});

	it("still resolves when the child exits without reading stdin", async () => {
		const res = await execCommand(process.execPath, ["-e", "process.exit(3)"], process.cwd(), {
			stdin: "x".repeat(1024 * 1024),
		});
		expect(res.code).toBe(3);
	});
});
