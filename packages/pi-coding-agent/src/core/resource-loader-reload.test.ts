import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DefaultResourceLoader } from "./resource-loader.ts";

describe("DefaultResourceLoader.reload", () => {
	let root: string;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-reload-")));
		mkdirSync(join(root, "agent"), { recursive: true });
		mkdirSync(join(root, "project"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("does not leave the previous load's event listeners subscribed", async () => {
		let emit: ((channel: string, data: unknown) => void) | undefined;
		let received = 0;
		const loader = new DefaultResourceLoader({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			noExtensions: true,
			extensionFactories: [
				(pi: any) => {
					emit = pi.events.emit;
					pi.events.on("ping", () => {
						received++;
					});
				},
			],
		});

		await loader.reload();
		await loader.reload();
		emit?.("ping", undefined);
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(received, 1);
	});
});
