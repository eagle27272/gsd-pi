import { describe, expect, test } from "vitest";
import { Type } from "@sinclair/typebox";
import { normalizeToolArguments } from "../normalize-tool-arguments.js";
import { validateToolArguments } from "../validation.js";

describe("normalizeToolArguments", () => {
	test("aliases filePath to path for read", () => {
		const args = { filePath: "src/app.js" };
		normalizeToolArguments("read", args);
		expect(args).toEqual({ path: "src/app.js" });
	});

	test("aliases file_path to path for write", () => {
		const args = { file_path: "src/app.js", content: "x" };
		normalizeToolArguments("write", args);
		expect(args).toEqual({ path: "src/app.js", content: "x" });
	});

	test("aliases file to path for read", () => {
		const args = { file: ".gsd/milestones/M003/M003-CONTEXT.md" };
		normalizeToolArguments("read", args);
		expect(args).toEqual({ path: ".gsd/milestones/M003/M003-CONTEXT.md" });
	});

	test("parses JSON-string tasks for subagent", () => {
		const args = {
			tasks: '[{"agent":"tester","task":"Evaluate Q3"}]',
		};
		normalizeToolArguments("subagent", args);
		expect(args.tasks).toEqual([{ agent: "tester", task: "Evaluate Q3" }]);
	});

	test("leaves non-JSON strings unchanged", () => {
		const args = { tasks: "not-json" };
		normalizeToolArguments("subagent", args);
		expect(args.tasks).toBe("not-json");
	});
});

describe("validateToolArguments integration", () => {
	test("accepts read calls that use filePath instead of path", () => {
		const tool = {
			name: "read",
			description: "read",
			parameters: Type.Object({
				path: Type.String(),
			}),
		};
		const validated = validateToolArguments(tool, {
			type: "toolCall",
			id: "read-1",
			name: "read",
			arguments: { filePath: "README.md" },
		});
		expect(validated.path).toBe("README.md");
	});

	test("accepts read calls that use file instead of path", () => {
		const tool = {
			name: "read",
			description: "read",
			parameters: Type.Object({
				path: Type.String(),
			}),
		};
		const validated = validateToolArguments(tool, {
			type: "toolCall",
			id: "read-2",
			name: "read",
			arguments: { file: "README.md" },
		});
		expect(validated.path).toBe("README.md");
	});
});
