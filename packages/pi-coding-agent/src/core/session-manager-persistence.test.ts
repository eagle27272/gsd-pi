import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AssistantMessage } from "@gsd/pi-ai";
import { SessionManager } from "./session-manager.ts";

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function parseLines(path: string): Array<Record<string, any>> {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

describe("SessionManager persistence", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "gsd-session-persist-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("opening a file without a readable header", () => {
		it("keeps the unreadable file instead of overwriting it", () => {
			const path = join(dir, "torn.jsonl");
			const body = [
				'{"type":"session","version":3,"id":"abc","timest',
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: userMessage("precious history"),
				}),
			].join("\n");
			writeFileSync(path, `${body}\n`);

			const manager = SessionManager.open(path, dir);

			const preserved = readdirSync(dir).filter((name) => name !== "torn.jsonl");
			assert.equal(preserved.length, 1, "the original bytes must survive under a different name");
			assert.equal(readFileSync(join(dir, preserved[0]), "utf8"), `${body}\n`);
			assert.ok(!preserved[0].endsWith(".jsonl"), "the backup must not be listed as a resumable session");
			assert.equal(manager.getSessionFile(), path);
			assert.equal(parseLines(path)[0].type, "session");
		});

		it("starts a fresh session in place when the file is empty", () => {
			const path = join(dir, "empty.jsonl");
			writeFileSync(path, "");

			SessionManager.open(path, dir);

			assert.deepEqual(readdirSync(dir), ["empty.jsonl"]);
			assert.equal(parseLines(path)[0].type, "session");
		});
	});

	describe("appending to a file that does not end in a newline", () => {
		it("keeps the new entry on its own line", () => {
			const path = join(dir, "no-newline.jsonl");
			const header = { type: "session", version: 3, id: "abc", timestamp: new Date().toISOString(), cwd: dir };
			const first = {
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: assistantMessage("first"),
			};
			writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(first)}`);

			const manager = SessionManager.open(path, dir);
			manager.appendMessage(userMessage("second"));

			const lines = parseLines(path);
			assert.deepEqual(
				lines.map((line) => line.id ?? line.type),
				["abc", "m1", lines[2].id],
			);
			assert.equal(lines[2].message.content, "second");
		});
	});

	describe("a failed append", () => {
		it("is repaired by the next successful write so the file holds every entry", () => {
			const manager = SessionManager.create(dir, dir);
			manager.appendMessage(userMessage("one"));
			manager.appendMessage(assistantMessage("two"));
			const path = manager.getSessionFile() as string;
			assert.equal(parseLines(path).length, 3);

			unlinkSync(path);
			mkdirSync(path);
			assert.throws(() => manager.appendMessage(userMessage("lost while the disk was failing")));
			rmdirSync(path);

			manager.appendMessage(assistantMessage("after recovery"));

			const texts = parseLines(path)
				.filter((line) => line.type === "message")
				.map((line) => (typeof line.message.content === "string" ? line.message.content : line.message.content[0].text));
			assert.deepEqual(texts, ["one", "two", "lost while the disk was failing", "after recovery"]);

			const reloaded = SessionManager.open(path, dir);
			assert.equal(reloaded.getEntries().length, 4);
		});
	});
});
