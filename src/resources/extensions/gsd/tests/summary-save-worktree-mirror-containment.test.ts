// GSD Extension — Regression test for #9 (second sink): the worktree
// projection mirror joins a caller-supplied relative artifact path onto the
// worktree `.gsd` root and writes it. The path-builder guards upstream are the
// first line of defence; this sink writes bytes, so it must refuse an escaping
// relative path on its own rather than inherit containment from its caller.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _mirrorArtifactToActiveWorktreeProjectionForTest as mirrorArtifact,
  executeSummarySave,
} from "../tools/workflow-tool-executors.ts";
import { clearPathCache, resolveGsdPathContract } from "../paths.ts";
import { openDatabase, closeDatabase } from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";

let base: string;

function makeWorktree(): string {
  base = mkdtempSync(join(tmpdir(), "gsd-mirror-containment-"));
  const worktree = join(base, ".gsd", "worktrees", "M001");
  mkdirSync(join(worktree, ".gsd"), { recursive: true });
  clearPathCache();
  return worktree;
}

describe("worktree projection mirror containment (#9)", () => {
  afterEach(() => {
    try { invalidateAllCaches(); } catch { /* ignore */ }
    try { clearPathCache(); } catch { /* ignore */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("refuses a relative path that escapes the worktree .gsd root", async () => {
    const worktree = makeWorktree();
    const contract = resolveGsdPathContract(worktree);
    assert.ok(contract.worktreeGsd, "fixture must produce a worktree contract");
    assert.notEqual(contract.worktreeGsd, contract.projectGsd);

    const escapee = join(base, "escaped-SUMMARY.md");
    await assert.rejects(
      () => mirrorArtifact(worktree, "../../../../escaped-SUMMARY.md", "# pwned\n", true),
      /escapes the worktree projection root/,
    );
    assert.equal(existsSync(escapee), false, "no file may be written outside the worktree .gsd root");
  });

  it("refuses the escape even when the mirror is best-effort", async () => {
    const worktree = makeWorktree();
    const escapee = join(base, "escaped-RESEARCH.md");

    // `required: false` tolerates a transient IO failure on the mirror; an
    // attempt to leave the projection root is not that, so it still throws.
    await assert.rejects(
      () => mirrorArtifact(worktree, "../../../../escaped-RESEARCH.md", "# pwned\n", false),
      /escapes the worktree projection root/,
    );
    assert.equal(existsSync(escapee), false, "no file may be written outside the worktree .gsd root");
  });

  it("still mirrors a contained relative path", async () => {
    const worktree = makeWorktree();
    const contract = resolveGsdPathContract(worktree);

    await mirrorArtifact(worktree, "phases/01-m001/S01-T01-SUMMARY.md", "# ok\n", true);

    assert.equal(
      existsSync(join(contract.worktreeGsd!, "phases", "01-m001", "S01-T01-SUMMARY.md")),
      true,
    );
  });
});

// End-to-end pin on the property #9 actually reported: no gsd_summary_save
// argument may place bytes outside the project. Several independent guards
// enforce this (tool schema, file-name builders, db-writer, this mirror), so
// this asserts the composed outcome rather than any single one of them.
describe("gsd_summary_save never writes outside the project (#9)", () => {
  afterEach(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    try { invalidateAllCaches(); } catch { /* ignore */ }
    try { clearPathCache(); } catch { /* ignore */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  for (const artifactType of ["SUMMARY", "RESEARCH"]) {
    it(`refuses a traversing task_id for ${artifactType}`, async () => {
      base = mkdtempSync(join(tmpdir(), "gsd-summary-save-traversal-"));
      mkdirSync(join(base, ".gsd"), { recursive: true });
      openDatabase(join(base, ".gsd", "gsd.db"));
      clearPathCache();

      const escapee = join(base, `escaped-${artifactType}.md`);
      const result = await executeSummarySave({
        milestone_id: "M001",
        slice_id: "S01",
        task_id: `../../../../escaped`,
        artifact_type: artifactType,
        content: "# pwned\n",
      }, base);

      assert.equal(result.isError, true, "a traversing task_id must be refused");
      assert.equal(existsSync(escapee), false, "no file may be written outside the project");
    });
  }
});
