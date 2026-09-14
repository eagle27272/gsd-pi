// Project/App: gsd-pi
// File Purpose: Regression tests for gating the isolated-subagent delta merge on success.
//
// Single-agent isolated mode gated the merge on `if (isolation)` alone. Because
// runSingleAgent returns normally for a non-zero exit rather than throwing, a
// failed agent's half-finished patches were applied straight into the live repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	applyIsolationDelta,
	type DeltaPatch,
	type IsolationDeltaTarget,
	type IsolationEnvironment,
} from "../isolation.js";

function git(repo: string, args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf-8" });
}

/** Temp repo containing `file.txt` = "original", plus a valid patch turning it into "modified". */
function makeRepo(): { repo: string; patch: DeltaPatch; cleanup: () => void } {
	const repo = mkdtempSync(join(tmpdir(), "subagent-delta-"));
	git(repo, ["init", "-q"]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Test"]);
	writeFileSync(join(repo, "file.txt"), "original\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);

	writeFileSync(join(repo, "file.txt"), "modified\n");
	const content = git(repo, ["diff"]);
	git(repo, ["checkout", "--", "file.txt"]);

	return { repo, patch: { path: "delta.patch", content }, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

function makeIsolation(patches: DeltaPatch[], calls: string[]): IsolationEnvironment {
	return {
		workDir: "/unused",
		cleanup: async () => {},
		captureDelta: async () => {
			calls.push("captureDelta");
			return patches;
		},
	};
}

test("applyIsolationDelta does not merge a failed agent's diff", async (t) => {
	const { repo, patch, cleanup } = makeRepo();
	t.after(cleanup);

	const calls: string[] = [];
	const result = { exitCode: 1, stderr: "agent blew up" };
	await applyIsolationDelta(makeIsolation([patch], calls), repo, result);

	assert.deepEqual(calls, [], "a failed agent's delta must never even be captured");
	assert.equal(readFileSync(join(repo, "file.txt"), "utf-8"), "original\n", "live repo must be untouched");
	assert.equal(result.exitCode, 1, "the agent's own failure code is preserved");
});

test("applyIsolationDelta merges a successful agent's diff", async (t) => {
	const { repo, patch, cleanup } = makeRepo();
	t.after(cleanup);

	const result: IsolationDeltaTarget = { exitCode: 0, stderr: "" };
	await applyIsolationDelta(makeIsolation([patch], []), repo, result);

	assert.equal(readFileSync(join(repo, "file.txt"), "utf-8"), "modified\n");
	assert.equal(result.mergeResult?.success, true);
	assert.equal(result.exitCode, 0);
});

test("applyIsolationDelta fails the result when the merge conflicts", async (t) => {
	const { repo, patch, cleanup } = makeRepo();
	t.after(cleanup);
	// Move the live file out from under the patch so `git apply --check` rejects it.
	writeFileSync(join(repo, "file.txt"), "diverged\n");

	const result: { exitCode: number; stderr: string; stopReason?: string; errorMessage?: string } = {
		exitCode: 0,
		stderr: "",
	};
	await applyIsolationDelta(makeIsolation([patch], []), repo, result);

	assert.equal(result.exitCode, 1);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /Patch merge failed/);
	assert.equal(readFileSync(join(repo, "file.txt"), "utf-8"), "diverged\n", "a rejected patch changes nothing");
});

test("applyIsolationDelta is a no-op when isolation is not in use", async (t) => {
	const { repo, cleanup } = makeRepo();
	t.after(cleanup);

	const result: IsolationDeltaTarget = { exitCode: 0, stderr: "" };
	await applyIsolationDelta(null, repo, result);

	assert.equal(result.mergeResult, undefined);
	assert.equal(readFileSync(join(repo, "file.txt"), "utf-8"), "original\n");
});
