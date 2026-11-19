import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "@gsd/pi-ai";
import { createEditTool } from "./edit.ts";

function createToolOverFile(initial: string) {
	let content = initial;
	const tool = createEditTool("/work", {
		operations: {
			readFile: async () => Buffer.from(content, "utf-8"),
			writeFile: async (_path, next) => {
				content = next;
			},
			access: async () => {},
		},
	});
	return { tool, read: () => content };
}

async function run(tool: ReturnType<typeof createEditTool>, rawArgs: Record<string, unknown>) {
	const prepared = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
	const validated = validateToolArguments(tool, { type: "toolCall", id: "t1", name: "edit", arguments: prepared as any });
	return tool.execute("t1", validated as any);
}

describe("edit tool input shapes", () => {
	it("accepts a single edit object in place of an edits array", async () => {
		const { tool, read } = createToolOverFile("alpha\nbeta\n");

		await run(tool, { path: "f.txt", edits: { oldText: "beta", newText: "gamma" } });

		assert.equal(read(), "alpha\ngamma\n");
	});

	it("accepts a single edit object serialized as a JSON string", async () => {
		const { tool, read } = createToolOverFile("alpha\nbeta\n");

		await run(tool, { path: "f.txt", edits: JSON.stringify({ oldText: "beta", newText: "gamma" }) });

		assert.equal(read(), "alpha\ngamma\n");
	});

	it("ignores extra fields a model invents on a replacement", async () => {
		const { tool, read } = createToolOverFile("alpha\nbeta\n");

		await run(tool, { path: "f.txt", edits: [{ oldText: "beta", newText: "gamma", replaceAll: true }] });

		assert.equal(read(), "alpha\ngamma\n");
	});
});
