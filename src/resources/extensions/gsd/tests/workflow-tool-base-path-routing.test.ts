// Project/App: gsd-pi
// File Purpose: Executable contract that registered GSD tools route writes to the
// milestone's auto-worktree using the parameter spelling their own schemas declare.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

// Prefer the compiled recorder so the dist-test run does not import a .ts module.
const recorderBase = fileURLToPath(
  new URL("./workflow-executors-base-path-recorder", import.meta.url),
);
const recorderPath = [".js", ".ts"]
  .map((extension) => `${recorderBase}${extension}`)
  .find(existsSync);
assert.ok(recorderPath, "base-path recorder fixture must sit next to this test");
process.env.GSD_WORKFLOW_EXECUTORS_MODULE = recorderPath;

import { registerDbTools } from "../bootstrap/db-tools.ts";

interface RegisteredTool {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ): Promise<{ details?: { basePath?: string } }>;
}

const tempDirs = new Set<string>();

function registeredTool(name: string): RegisteredTool {
  const tools: RegisteredTool[] = [];
  registerDbTools({
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as Parameters<typeof registerDbTools>[0]);
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} must be registered`);
  return tool;
}

/** A project root with two concurrently live milestone worktrees. */
function createProjectWithWorktrees(...milestoneIds: string[]): [string, string[]] {
  const project = mkdtempSync(join(tmpdir(), "gsd-tool-routing-"));
  tempDirs.add(project);
  const worktrees = milestoneIds.map((milestoneId) => {
    const worktree = join(project, ".gsd", "worktrees", milestoneId);
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: /tmp/fake-git-dir\n", "utf-8");
    return worktree;
  });
  return [project, worktrees];
}

async function resolvedBasePath(
  toolName: string,
  params: Record<string, unknown>,
  cwd: string,
): Promise<string | undefined> {
  const result = await registeredTool(toolName)
    .execute("routing-call-1", params, undefined, undefined, { cwd });
  return result.details?.basePath;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("a camelCase milestoneId tool routes to its own milestone worktree", async () => {
  const [project, [, second]] = createProjectWithWorktrees("M001-first", "M002-second");

  assert.equal(
    await resolvedBasePath("gsd_task_complete", { milestoneId: "M002-second" }, project),
    second,
  );
});

test("a snake_case milestone_id tool routes to its own milestone worktree", async () => {
  const [project, [, second]] = createProjectWithWorktrees("M001-first", "M002-second");

  assert.equal(
    await resolvedBasePath("gsd_summary_save", { milestone_id: "M002-second" }, project),
    second,
  );
});

test("a milestone with no worktree is not routed into an unrelated sole worktree", async () => {
  const [project] = createProjectWithWorktrees("M001-first");

  assert.equal(
    await resolvedBasePath("gsd_task_complete", { milestoneId: "M009-absent" }, project),
    project,
  );
});
