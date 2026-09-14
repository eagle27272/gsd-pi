import assert from "node:assert/strict";
import { test } from "node:test";
import { type ExecutionEnv, ok } from "../types.js";
import { executeShellWithCapture } from "./shell-output.js";
import { DEFAULT_MAX_BYTES } from "./truncate.js";

interface RecordingEnv {
	env: ExecutionEnv;
	files: Map<string, string>;
	tempFileCount: () => number;
}

/**
 * Execution env whose `createTempFile` resolves on a later microtask, which is
 * the window the capture code has to stay single-file across.
 */
function createRecordingEnv(chunks: string[]): RecordingEnv {
	const files = new Map<string, string>();
	let created = 0;

	const env = {
		cwd: "/",
		async createTempFile() {
			await Promise.resolve();
			await Promise.resolve();
			created += 1;
			const path = `/tmp/bash-${created}.log`;
			files.set(path, "");
			return ok(path);
		},
		async appendFile(path: string, content: string | Uint8Array) {
			const text = typeof content === "string" ? content : new TextDecoder().decode(content);
			files.set(path, (files.get(path) ?? "") + text);
			return ok(undefined);
		},
		async exec(_command: string, options?: { onStdout?: (chunk: string) => void }) {
			for (const chunk of chunks) options?.onStdout?.(chunk);
			return ok({ stdout: "", stderr: "", exitCode: 0 });
		},
	} as unknown as ExecutionEnv;

	return { env, files, tempFileCount: () => created };
}

function makeChunks(count: number, bytesPerChunk: number): string[] {
	return Array.from({ length: count }, (_, index) => {
		const marker = `chunk${String(index).padStart(4, "0")}`;
		return `${marker}${"x".repeat(bytesPerChunk - marker.length - 1)}\n`;
	});
}

test("capture writes overflow output to exactly one temp file", async () => {
	const chunks = makeChunks(60, 2048);
	const { env, tempFileCount } = createRecordingEnv(chunks);

	const result = await executeShellWithCapture(env, "noop");

	assert.ok(result.ok, "capture should succeed");
	assert.equal(tempFileCount(), 1);
});

test("capture preserves every emitted chunk in the full output file", async () => {
	const chunks = makeChunks(60, 2048);
	const { env, files } = createRecordingEnv(chunks);

	const result = await executeShellWithCapture(env, "noop");

	assert.ok(result.ok, "capture should succeed");
	const fullOutputPath = result.value.fullOutputPath;
	assert.ok(fullOutputPath, "output above the byte limit should be spilled to a file");
	const expected = chunks.join("");
	const captured = files.get(fullOutputPath) ?? "";
	assert.equal(captured.length, expected.length, "captured byte count");
	assert.equal(captured, expected);
});

test("capture leaves small output entirely in memory", async () => {
	const chunks = makeChunks(4, 512);
	const { env, tempFileCount } = createRecordingEnv(chunks);

	const result = await executeShellWithCapture(env, "noop");

	assert.ok(result.ok, "capture should succeed");
	assert.equal(result.value.fullOutputPath, undefined);
	assert.equal(tempFileCount(), 0);
	assert.equal(result.value.output, chunks.join(""));
	assert.ok(chunks.join("").length < DEFAULT_MAX_BYTES);
});
