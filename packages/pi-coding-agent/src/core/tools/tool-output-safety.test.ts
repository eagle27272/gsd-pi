import assert from "node:assert/strict";
import { existsSync, rmSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { OutputAccumulator } from "./output-accumulator.ts";
import { truncateLine } from "./truncate.ts";

describe("truncateLine", () => {
	it("does not cut an astral character in half", () => {
		const line = `${"a".repeat(9)}😀tail`;

		const { text, wasTruncated } = truncateLine(line, 10);

		assert.equal(wasTruncated, true);
		assert.equal(text, `${"a".repeat(9)}... [truncated]`);
		assert.doesNotThrow(() => encodeURIComponent(text), "output must be well-formed UTF-16");
	});

	it("keeps an astral character that fits entirely", () => {
		const { text } = truncateLine(`${"a".repeat(8)}😀tail`, 10);

		assert.equal(text, `${"a".repeat(8)}😀... [truncated]`);
	});
});

describe("OutputAccumulator temp file", { skip: process.platform === "win32" }, () => {
	it("is readable only by the current user", async () => {
		const accumulator = new OutputAccumulator({ maxBytes: 10, tempFilePrefix: "gsd-perm-test" });
		accumulator.append(Buffer.from("x".repeat(100)));
		accumulator.finish();
		const path = accumulator.snapshot({ persistIfTruncated: true }).fullOutputPath;
		assert.ok(path, "output over the cap must be persisted");

		for (let i = 0; i < 50 && !existsSync(path); i++) await new Promise((resolve) => setTimeout(resolve, 10));
		try {
			assert.equal(statSync(path).mode & 0o777, 0o600);
		} finally {
			rmSync(path, { force: true });
		}
	});
});
