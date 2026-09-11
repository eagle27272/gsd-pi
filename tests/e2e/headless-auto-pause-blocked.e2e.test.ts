// Project/App: gsd-pi
// File Purpose: E2E gate for headless auto-mode pause and blocked recovery behavior.

import { execFileSync } from "node:child_process";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	artifactsFor,
	createTmpProject,
	gsdSync,
	parseJsonEvents,
	writeTranscript,
} from "./_shared/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function binaryAvailable(): { ok: boolean; reason?: string } {
	const bin = process.env.GSD_SMOKE_BINARY;
	if (!bin) return { ok: false, reason: "GSD_SMOKE_BINARY not set; build with `npm run build:core` and re-export." };
	if (!existsSync(bin)) return { ok: false, reason: `binary not found at ${bin}` };
	return { ok: true };
}

function commitFixture(dir: string): void {
	commitPaths(dir, [".gitignore", "package.json", "src/answer.js", "test/answer.test.js"], "test: seed headless pause fixture");
}

function commitPaths(dir: string, paths: string[], message: string): void {
	execFileSync("git", ["add", ...paths], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "pipe" });
}

function git(dir: string, args: string[]): void {
	execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

function gitOutput(dir: string, args: string[]): string {
	return execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

function nodeOutput(dir: string, args: string[]): string {
	return execFileSync(process.execPath, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

interface SeedHierarchyCounts {
	milestones: number;
	slices: number;
	tasks: number;
}

interface SeedCounts {
	hierarchy: SeedHierarchyCounts;
}

/**
 * Load the fixture's on-disk markdown into the project database.
 *
 * This used to shell out to the two-step `gsd headless recover`, the
 * operator-facing markdown→DB import. That command and the kernel behind it
 * are gone: the database is the sole authority and no production path adopts
 * markdown. What survives for exactly this purpose is md-importer's
 * `migrateFromMarkdown`, the explicitly test-only scaffolding importer.
 *
 * `minimum` is the floor the calling fixture needs. Seeding that silently
 * imported nothing would leave `headless auto` running against an empty
 * project, where the pause/blocked assertions below would pass for the wrong
 * reason.
 *
 * Runs in a child process so the test never holds a SQLite handle on the
 * project `headless auto` is about to run against.
 */
function seedDatabaseFromMarkdown(dir: string, minimum: SeedHierarchyCounts): SeedCounts {
	const moduleUrl = (name: string) =>
		JSON.stringify(pathToFileURL(join(REPO_ROOT, "dist", "resources", "extensions", "gsd", name)).href);
	const script = [
		`const { migrateFromMarkdown } = await import(${moduleUrl("md-importer.js")});`,
		`const { closeDatabase } = await import(${moduleUrl("gsd-db.js")});`,
		"const counts = migrateFromMarkdown(process.argv[1]);",
		"closeDatabase();",
		"process.stdout.write(JSON.stringify(counts));",
	].join("\n");

	let raw: string;
	try {
		raw = execFileSync(process.execPath, ["--input-type=module", "-e", script, dir], {
			cwd: dir,
			encoding: "utf8",
			timeout: 60_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		const detail = (err as { stderr?: string })?.stderr ?? String(err);
		throw new Error(`fixture DB seeding failed:\n${detail.slice(0, 1200)}`);
	}

	const counts = JSON.parse(raw) as SeedCounts;
	for (const kind of ["milestones", "slices", "tasks"] as const) {
		assert.ok(
			counts.hierarchy[kind] >= minimum[kind],
			`fixture DB seeding imported ${counts.hierarchy[kind]} ${kind}, expected at least ${minimum[kind]}: ${raw}`,
		);
	}
	return counts;
}

function commitRecoveredMilestone(dir: string): void {
	// Track projections so auto-start's migrateToExternalState aborts (#1364).
	// An ignored in-project .gsd/ is eligible for that move, and pass-0
	// reconciliation then flakes on roadmap-missing instead of the provider error.
	commitPaths(dir, [
		".gsd/milestones/M001/M001-CONTEXT.md",
		".gsd/milestones/M001/M001-ROADMAP.md",
		".gsd/milestones/M001/slices/S01/S01-PLAN.md",
	], "test: seed recovered milestone projections");
}

function writeRecoveredMilestone(dir: string): void {
	const milestoneDir = join(dir, ".gsd", "milestones", "M001");
	const sliceDir = join(milestoneDir, "slices", "S01");
	mkdirSync(join(sliceDir, "tasks"), { recursive: true });

	writeFileSync(
		join(milestoneDir, "M001-CONTEXT.md"),
		[
			"# M001: Provider Pause Fixture",
			"",
			"## Purpose",
			"Exercise headless auto-mode pause handling.",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(milestoneDir, "M001-ROADMAP.md"),
		[
			"# M001: Provider Pause Fixture",
			"",
			"## Slices",
			"",
			"- [ ] **S01: Update answer** `risk:low` `depends:[]`",
			"  > Demo: answer() returns ready.",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(sliceDir, "S01-PLAN.md"),
		[
			"# S01: Update answer",
			"",
			"**Goal:** Make the answer implementation return ready.",
			"",
			"## Tasks",
			"",
			"- [ ] **T01: Update answer implementation** `est:5m`",
			"",
			"### T01: Update answer implementation",
			"",
			"Inputs:",
			"- `src/answer.js`",
			"",
			"Expected Output:",
			"- `src/answer.js`",
			"",
			"Verification:",
			"- `node --test test/answer.test.js`",
			"",
		].join("\n"),
	);
}

function writeCompletedConflictMilestone(dir: string): void {
	const milestoneDir = join(dir, ".gsd", "milestones", "M001");
	mkdirSync(milestoneDir, { recursive: true });
	writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), "## Git\n- isolation: worktree\n");
	writeFileSync(
		join(milestoneDir, "M001-ROADMAP.md"),
		[
			"# M001: Merge Conflict Fixture",
			"",
			"## Slices",
			"",
			"- [x] **S01: Conflict slice** `risk:low` `depends:[]`",
			"  > After this: the milestone branch has source work that must be merged.",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(milestoneDir, "M001-VALIDATION.md"),
		"---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nPassed.\n",
	);
	writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), "# M001 Summary\n\nDone.\n");
}

/**
 * Mint the completed-but-unmerged survivor state the fixture needs.
 *
 * The markdown seeder writes legacy hierarchy rows only — it never adopts them
 * into the canonical lifecycle (#1657) — so the DB-authoritative readers the
 * merge guard consults still see no Milestone lifecycle at all. Complete the
 * Milestone the way the canonical seam does: adopt/transition the lifecycle
 * inside one `milestone.complete` Domain Operation (the only operation type
 * trg_workflow_lifecycle_transition accepts for a completed Milestone), then
 * project that status onto the legacy row. The event stays fixture-named so it
 * is never mistaken for a real closeout receipt.
 */
async function markSeededMilestoneComplete(dir: string): Promise<void> {
	const { closeAllWorkflowDatabases, openWorkflowDatabase } = await import(
		"../../dist/resources/extensions/gsd/db-workspace.js"
	);
	const { executeDomainOperation } = await import(
		"../../dist/resources/extensions/gsd/db/domain-operation.js"
	);
	const { adoptOrTransitionLifecycle, readDomainOperationFence } = await import(
		"../../dist/resources/extensions/gsd/db/writers/lifecycle-commands.js"
	);
	const { projectCanonicalStatusToLegacy } = await import("../../dist/resources/extensions/gsd/gsd-db.js");
	try {
		const opened = openWorkflowDatabase(dir);
		assert.equal(opened.ok, true, "recovered fixture database should open");
		const fence = readDomainOperationFence();
		executeDomainOperation(
			{
				operationType: "milestone.complete",
				idempotencyKey: "test/milestone-complete/M001",
				expectedRevision: fence.revision,
				expectedAuthorityEpoch: fence.authorityEpoch,
				actorType: "test",
				sourceTransport: "test",
				payload: { milestoneId: "M001" },
			},
			(context) => {
				adoptOrTransitionLifecycle(context, {
					itemKind: "milestone",
					milestoneId: "M001",
					lifecycleStatus: "completed",
				});
				projectCanonicalStatusToLegacy(context, {
					entity: "milestone",
					milestoneId: "M001",
					status: "complete",
					completedAt: "2026-01-01T00:00:00.000Z",
				});
				return {
					events: [{
						eventType: "test.milestone.completed",
						entityType: "milestone",
						entityId: "M001",
						payload: {},
						destinations: ["projection"],
					}],
					projections: [{
						projectionKey: "lifecycle/m001",
						projectionKind: "milestone-lifecycle",
						rendererVersion: "1",
					}],
				};
			},
		);
	} finally {
		closeAllWorkflowDatabases();
	}
}

describe("headless auto pause e2e (fake LLM)", () => {
	const avail = binaryAvailable();
	const skipReason = avail.ok ? null : avail.reason;

	test("headless auto exits blocked when auto-mode pauses on provider error", { skip: skipReason ?? false }, (t) => {
		const project = createTmpProject({
			git: true,
			files: {
				".gitignore": ".gsd/worktrees/\n",
				"package.json": JSON.stringify({ type: "module", scripts: { test: "node --test test/answer.test.js" } }, null, 2) + "\n",
				"src/answer.js": "export function answer() {\n\treturn \"pending\";\n}\n",
				"test/answer.test.js": [
					"import test from \"node:test\";",
					"import assert from \"node:assert/strict\";",
					"import { answer } from \"../src/answer.js\";",
					"",
					"test(\"answer returns ready\", () => {",
					"\tassert.equal(answer(), \"ready\");",
					"});",
					"",
				].join("\n"),
			},
		});
		t.after(project.cleanup);
		commitFixture(project.dir);
		writeRecoveredMilestone(project.dir);
		commitRecoveredMilestone(project.dir);

		// tasks: 0 is the real import result, not an oversight. parseProjectionPlan
		// drops a checkbox task whose id is repeated by a `### T01: ...` detail
		// heading (the heading branch sees a known id and clears the pending
		// entry), and this PLAN has both. The pause path only needs the
		// milestone/slice pair: auto dispatches the unplanned slice, the fake LLM
		// answers 429, and the run pauses before any task would be read.
		seedDatabaseFromMarkdown(project.dir, { milestones: 1, slices: 1, tasks: 0 });
		assert.ok(
			existsSync(join(project.dir, ".gsd", "milestones", "M001", "M001-ROADMAP.md")),
			"seeded ROADMAP must stay on disk so auto pass-0 cannot emit roadmap-missing",
		);

		const transcript = writeTranscript([
			{
				turn: 1,
				expect: { modelId: "gsd-fake-model" },
				emit: { kind: "error_429", message: "invalid api key" },
			},
		]);

		const result = gsdSync(
			[
				"headless",
				"--output-format",
				"stream-json",
				"--events",
				"extension_ui_request,message_start,message_end,agent_end",
				"--model",
				"gsd-fake-model",
				"--timeout",
				"45000",
				"--max-restarts",
				"0",
				"auto",
			],
			{
				cwd: project.dir,
				timeoutMs: 60_000,
				env: {
					GSD_FAKE_LLM_TRANSCRIPT: transcript,
				},
			},
		);

		const artifacts = artifactsFor("headless-auto-pause-blocked");
		artifacts.write("stdout.jsonl", result.stdout);
		artifacts.write("stderr.log", result.stderr);

		assert.equal(
			result.code,
			10,
			`expected blocked exit 10, got code=${result.code} signal=${result.signal} timedOut=${result.timedOut}. artifacts: ${artifacts.dir}`,
		);
		assert.ok(!result.timedOut, "headless auto pause must exit before the harness timeout");
		assert.ok(!/Timeout after/i.test(result.stderrClean), `headless should not report timeout:\n${result.stderrClean}`);

		const events = parseJsonEvents(result.stdoutClean);
		const notifyMessages = events
			.filter((event) => event.type === "extension_ui_request" && event.method === "notify")
			.map((event) => String(event.message ?? ""));

		assert.ok(
			notifyMessages.some((message) => /auto-mode paused due to provider error/i.test(message)),
			`expected provider-error pause notification, got:\n${notifyMessages.join("\n")}`,
		);
		assert.ok(
			notifyMessages.some((message) => /^auto-mode paused/i.test(message)),
			`expected terminal auto-mode paused notification, got:\n${notifyMessages.join("\n")}`,
		);
	});

	test("headless auto exits blocked when survivor milestone merge needs manual conflict resolution", { skip: skipReason ?? false }, async (t) => {
		const project = createTmpProject({
			git: true,
			files: {
				".gitignore": ".gsd/worktrees/\n",
				"package.json": JSON.stringify({ type: "module" }, null, 2) + "\n",
				"src/conflict.js": "export const value = \"base\";\n",
			},
		});
		t.after(project.cleanup);
		commitPaths(project.dir, [".gitignore", "package.json", "src/conflict.js"], "test: seed merge conflict fixture");
		writeCompletedConflictMilestone(project.dir);

		// No slice PLAN in this fixture, so the import yields no tasks: the
		// milestone/slice pair is the whole survivor state the merge guard needs.
		seedDatabaseFromMarkdown(project.dir, { milestones: 1, slices: 1, tasks: 0 });
		await markSeededMilestoneComplete(project.dir);

		git(project.dir, ["checkout", "-b", "milestone/M001"]);
		writeFileSync(join(project.dir, "src/conflict.js"), "export const value = \"milestone\";\n");
		commitPaths(project.dir, ["src/conflict.js"], "feat: milestone conflict");
		git(project.dir, ["checkout", "main"]);
		writeFileSync(join(project.dir, "src/conflict.js"), "export const value = \"main\";\n");
		commitPaths(project.dir, ["src/conflict.js"], "feat: main conflict");

		const result = gsdSync(
			[
				"headless",
				"--output-format",
				"stream-json",
				"--events",
				"extension_ui_request,message_start,message_end,agent_end",
				"--model",
				"gsd-fake-model",
				"--timeout",
				"45000",
				"--max-restarts",
				"0",
				"auto",
			],
			{
				cwd: project.dir,
				timeoutMs: 60_000,
			},
		);

		const artifacts = artifactsFor("headless-survivor-merge-conflict-blocked");
		artifacts.write("stdout.jsonl", result.stdout);
		artifacts.write("stderr.log", result.stderr);

		assert.equal(
			result.code,
			10,
			`expected blocked exit 10, got code=${result.code} signal=${result.signal} timedOut=${result.timedOut}. artifacts: ${artifacts.dir}`,
		);
		assert.ok(!result.timedOut, "headless survivor merge conflict must exit before the harness timeout");
		assert.ok(!/Timeout after/i.test(result.stderrClean), `headless should not report timeout:\n${result.stderrClean}`);

		const events = parseJsonEvents(result.stdoutClean);
		const notifyMessages = events
			.filter((event) => event.type === "extension_ui_request" && event.method === "notify")
			.map((event) => String(event.message ?? ""));
		const commandMessages = events
			.filter((event) => event.type === "message_start" || event.type === "message_end")
			.map((event) => String((event.message as { content?: unknown } | undefined)?.content ?? ""));
		const visibleMessages = [...notifyMessages, ...commandMessages];

		assert.ok(
			visibleMessages.some((message) => /M001 is complete but not merged/i.test(message)),
			`expected unmerged milestone blocker, got:\n${visibleMessages.join("\n")}`,
		);
		assert.ok(
			visibleMessages.some((message) => /src\/conflict\.js/.test(message)),
			`expected conflicted source file in messages, got:\n${visibleMessages.join("\n")}`,
		);
		assert.ok(
			visibleMessages.some((message) => /\/gsd dispatch complete-milestone M001/i.test(message)),
			`expected complete-milestone repair instruction, got:\n${visibleMessages.join("\n")}`,
		);

		assert.throws(
			() => git(project.dir, ["merge", "--no-ff", "--no-edit", "milestone/M001"]),
			/manual|conflict|Command failed/i,
			"manual merge should expose the same source conflict the blocked run reported",
		);
		writeFileSync(join(project.dir, "src/conflict.js"), "export const value = \"milestone\";\n");
		commitPaths(project.dir, ["src/conflict.js"], "merge: manually resolve milestone M001");
		assert.equal(gitOutput(project.dir, ["diff", "--name-only", "--diff-filter=U"]), "");

		const resume = gsdSync(
			[
				"headless",
				"--output-format",
				"stream-json",
				"--events",
				"extension_ui_request,agent_end",
				"--model",
				"gsd-fake-model",
				"--timeout",
				"45000",
				"--max-restarts",
				"0",
				"auto",
			],
			{
				cwd: project.dir,
				timeoutMs: 60_000,
			},
		);

		const resumeArtifacts = artifactsFor("headless-survivor-merge-conflict-resumed");
		resumeArtifacts.write("stdout.jsonl", resume.stdout);
		resumeArtifacts.write("stderr.log", resume.stderr);

		assert.equal(
			resume.code,
			0,
			`expected resume to clean up completed milestone and exit 0, got code=${resume.code} signal=${resume.signal} timedOut=${resume.timedOut}. artifacts: ${resumeArtifacts.dir}`,
		);
		assert.ok(!resume.timedOut, "headless survivor merge resume must exit before the harness timeout");
		assert.ok(!/Timeout after/i.test(resume.stderrClean), `headless should not report timeout:\n${resume.stderrClean}`);

		const resumeEvents = parseJsonEvents(resume.stdoutClean);
		const resumeNotifyMessages = resumeEvents
			.filter((event) => event.type === "extension_ui_request" && event.method === "notify")
			.map((event) => String(event.message ?? ""));

		assert.ok(
			resumeNotifyMessages.some((message) => /Orphan audit: Deleted merged branch milestone\/M001/i.test(message)),
			`expected completed milestone branch cleanup notification, got:\n${resumeNotifyMessages.join("\n")}`,
		);
		assert.ok(
			resumeNotifyMessages.some((message) => /Auto-mode stopped .*all milestones complete/i.test(message)),
			`expected terminal cleanup notification, got:\n${resumeNotifyMessages.join("\n")}`,
		);
		assert.ok(
			!resumeNotifyMessages.some((message) => /Survivor-branch finalization for M001 failed/i.test(message)),
			`manual resolution rerun should not repeat survivor finalization failure, got:\n${resumeNotifyMessages.join("\n")}`,
		);
		assert.equal(gitOutput(project.dir, ["branch", "--list", "milestone/M001"]), "");
		assert.equal(
			nodeOutput(project.dir, ["--input-type=module", "-e", "import { value } from './src/conflict.js'; process.stdout.write(value);"]),
			"milestone",
		);
	});
});
