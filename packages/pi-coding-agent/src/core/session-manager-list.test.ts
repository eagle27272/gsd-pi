import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";

import { findMostRecentSession, getDefaultSessionDir, listSessionsFromDir } from "./session-manager-list.ts";

function makeAgentDir(): string {
	return mkdtempSync(join(tmpdir(), "gsd-session-list-"));
}

function legacyDirNameFor(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function writeSessionFile(dir: string, name: string, header: Record<string, unknown>): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, `${JSON.stringify(header)}\n`);
	return path;
}

function sessionHeader(cwd: string, id: string): Record<string, unknown> {
	return { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd };
}

function openDescriptorCount(): number | null {
	try {
		return readdirSync("/dev/fd").length;
	} catch {
		return null;
	}
}

describe("getDefaultSessionDir", () => {
	it("maps directories that flatten to the same name onto distinct session dirs", () => {
		const agentDir = makeAgentDir();
		try {
			const hyphenated = getDefaultSessionDir("/tmp/gsd-cwd/foo-bar", agentDir);
			const nested = getDefaultSessionDir("/tmp/gsd-cwd/foo/bar", agentDir);

			assert.equal(legacyDirNameFor("/tmp/gsd-cwd/foo-bar"), legacyDirNameFor("/tmp/gsd-cwd/foo/bar"));
			assert.notEqual(hyphenated, nested);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("returns the same directory for the same cwd", () => {
		const agentDir = makeAgentDir();
		try {
			assert.equal(getDefaultSessionDir("/tmp/gsd-cwd/foo-bar", agentDir), getDefaultSessionDir("/tmp/gsd-cwd/foo-bar", agentDir));
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("adopts sessions left behind in the pre-hash directory", () => {
		const agentDir = makeAgentDir();
		const cwd = "/tmp/gsd-cwd/solo-project";
		try {
			const legacyDir = join(agentDir, "sessions", legacyDirNameFor(cwd));
			writeSessionFile(legacyDir, "2026-01-01T00-00-00-000Z_a.jsonl", sessionHeader(cwd, "a"));

			const sessionDir = getDefaultSessionDir(cwd, agentDir);

			assert.deepEqual(readdirSync(sessionDir), ["2026-01-01T00-00-00-000Z_a.jsonl"]);
			assert.equal(findMostRecentSession(sessionDir), join(sessionDir, "2026-01-01T00-00-00-000Z_a.jsonl"));
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("splits a shared pre-hash directory so each cwd adopts only its own sessions", () => {
		const agentDir = makeAgentDir();
		const hyphenated = "/tmp/gsd-cwd/foo-bar";
		const nested = "/tmp/gsd-cwd/foo/bar";
		try {
			const legacyDir = join(agentDir, "sessions", legacyDirNameFor(hyphenated));
			writeSessionFile(legacyDir, "2026-01-01T00-00-00-000Z_hyphen.jsonl", sessionHeader(hyphenated, "hyphen"));
			writeSessionFile(legacyDir, "2026-01-02T00-00-00-000Z_nested.jsonl", sessionHeader(nested, "nested"));

			const hyphenatedDir = getDefaultSessionDir(hyphenated, agentDir);
			const nestedDir = getDefaultSessionDir(nested, agentDir);

			assert.deepEqual(readdirSync(hyphenatedDir), ["2026-01-01T00-00-00-000Z_hyphen.jsonl"]);
			assert.deepEqual(readdirSync(nestedDir), ["2026-01-02T00-00-00-000Z_nested.jsonl"]);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("leaves headerless files in the pre-hash directory rather than guessing an owner", () => {
		const agentDir = makeAgentDir();
		const cwd = "/tmp/gsd-cwd/solo-project";
		try {
			const legacyName = legacyDirNameFor(cwd);
			const legacyDir = join(agentDir, "sessions", legacyName);
			writeSessionFile(legacyDir, "2026-01-01T00-00-00-000Z_ok.jsonl", sessionHeader(cwd, "ok"));
			mkdirSync(legacyDir, { recursive: true });
			writeFileSync(join(legacyDir, "2026-01-02T00-00-00-000Z_broken.jsonl"), "not json\n");

			const sessionDir = getDefaultSessionDir(cwd, agentDir);

			assert.deepEqual(readdirSync(sessionDir), ["2026-01-01T00-00-00-000Z_ok.jsonl"]);
			assert.deepEqual(readdirSync(join(agentDir, "sessions", legacyName)), ["2026-01-02T00-00-00-000Z_broken.jsonl"]);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("removes the pre-hash directory once every session has been adopted", () => {
		const agentDir = makeAgentDir();
		const cwd = "/tmp/gsd-cwd/solo-project";
		try {
			const legacyName = legacyDirNameFor(cwd);
			writeSessionFile(join(agentDir, "sessions", legacyName), "2026-01-01T00-00-00-000Z_a.jsonl", sessionHeader(cwd, "a"));

			const sessionDir = getDefaultSessionDir(cwd, agentDir);

			assert.deepEqual(readdirSync(join(agentDir, "sessions")), [basename(sessionDir)]);
			assert.notEqual(basename(sessionDir), legacyName);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("findMostRecentSession", () => {
	it("does not leak a descriptor for a directory named like a session file", (t) => {
		const before = openDescriptorCount();
		if (before === null) {
			t.skip("no /dev/fd on this platform");
			return;
		}

		const dir = makeAgentDir();
		try {
			mkdirSync(join(dir, "not-a-session.jsonl"));
			writeSessionFile(dir, "real.jsonl", sessionHeader("/tmp/gsd-cwd/solo", "real"));

			for (let i = 0; i < 50; i++) {
				assert.equal(findMostRecentSession(dir), join(dir, "real.jsonl"));
			}

			assert.ok((openDescriptorCount() ?? 0) <= before + 5, "descriptors leaked while scanning session files");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("accepts a header longer than a single read chunk", () => {
		const dir = makeAgentDir();
		try {
			const header = sessionHeader("/tmp/gsd-cwd/solo", "long");
			header.parentSession = `/tmp/${"p".repeat(9000)}.jsonl`;
			writeSessionFile(dir, "long.jsonl", header);

			assert.equal(findMostRecentSession(dir), join(dir, "long.jsonl"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("listSessionsFromDir", () => {
	it("rejects a header without a string id", async () => {
		const dir = makeAgentDir();
		try {
			writeSessionFile(dir, "no-id.jsonl", { type: "session", version: 3, timestamp: new Date().toISOString(), cwd: "/tmp" });
			writeSessionFile(dir, "ok.jsonl", sessionHeader("/tmp/gsd-cwd/solo", "ok"));

			const sessions = await listSessionsFromDir(dir);

			assert.deepEqual(
				sessions.map((s) => s.id),
				["ok"],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
