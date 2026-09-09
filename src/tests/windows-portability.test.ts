import test from "node:test";
import assert from "node:assert/strict";
import { encodeCwd } from "../resources/extensions/subagent/isolation.ts";

test("encodeCwd produces a filesystem-safe token for Windows paths", () => {
	const encoded = encodeCwd("C:\\Users\\Alice\\repo");
	assert.match(encoded, /^[A-Za-z0-9_-]+$/);
	assert.ok(!encoded.includes(":"));
	assert.ok(!encoded.includes("\\"));
	assert.ok(!encoded.includes("/"));
});
