// Regression tests for #1526: phase-dir slug drift when a milestone title changes.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { renamePhaseDirOnTitleChange } from "../phase-dir-rename.ts";
import { canonicalPhaseDirName, resolveMilestonePath } from "../paths.ts";
import { createWorkspace } from "../workspace.ts";
import {
  closeDatabase,
  getArtifactsByPathPrefix,
  insertArtifact,
  insertMilestone,
  openDatabase,
  upsertMilestonePlanning,
} from "../gsd-db.ts";

function makeProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-phase-dir-rename-"));
  mkdirSync(join(base, ".gsd", "phases"), { recursive: true });
  return base;
}

/**
 * Managed-state layout: `<project>/.gsd` is a symlink into the external state
 * dir, so the resolved DB path is `<state>/gsd.db` and bears no relation to the
 * project root.
 */
function makeSymlinkedProject(): { base: string; state: string } {
  const base = mkdtempSync(join(tmpdir(), "gsd-phase-dir-rename-proj-"));
  const state = mkdtempSync(join(tmpdir(), "gsd-phase-dir-rename-state-"));
  mkdirSync(join(state, "phases"), { recursive: true });
  symlinkSync(state, join(base, ".gsd"), "dir");
  return { base, state };
}

test("renamePhaseDirOnTitleChange moves the old slug dir to the canonical name (#1526)", () => {
  const base = makeProject();
  try {
    const oldName = canonicalPhaseDirName("M001", "New milestone M001");
    const newName = canonicalPhaseDirName("M001", "Lokably brand foundation and welcome page rebuild");
    const oldDir = join(base, ".gsd", "phases", oldName);
    const newDir = join(base, ".gsd", "phases", newName);
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "01-CONTEXT.md"), "# New milestone M001\n");

    assert.equal(renamePhaseDirOnTitleChange(join(base, ".gsd"), "M001", "New milestone M001", "Lokably brand foundation and welcome page rebuild"), true);
    assert.equal(existsSync(oldDir), false, "old slug dir should be gone");
    assert.equal(existsSync(newDir), true, "canonical slug dir should exist");
    assert.equal(readFileSync(join(newDir, "01-CONTEXT.md"), "utf8"), "# New milestone M001\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("renamePhaseDirOnTitleChange is a no-op when the new dir already exists", () => {
  const base = makeProject();
  try {
    const oldName = canonicalPhaseDirName("M001", "Old title");
    const newName = canonicalPhaseDirName("M001", "New title");
    const oldDir = join(base, ".gsd", "phases", oldName);
    const newDir = join(base, ".gsd", "phases", newName);
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(oldDir, "old.md"), "old");
    writeFileSync(join(newDir, "new.md"), "new");

    assert.equal(renamePhaseDirOnTitleChange(join(base, ".gsd"), "M001", "Old title", "New title"), false);
    assert.equal(existsSync(oldDir), true, "old dir must be left in place");
    assert.equal(existsSync(join(newDir, "new.md")), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("renamePhaseDirOnTitleChange is a no-op when the old dir is missing", () => {
  const base = makeProject();
  try {
    assert.equal(renamePhaseDirOnTitleChange(join(base, ".gsd"), "M001", "Old title", "New title"), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("renamePhaseDirOnTitleChange is a no-op when the slug does not change", () => {
  const base = makeProject();
  try {
    const name = canonicalPhaseDirName("M001", "Foundation");
    const dir = join(base, ".gsd", "phases", name);
    mkdirSync(dir, { recursive: true });
    assert.equal(renamePhaseDirOnTitleChange(join(base, ".gsd"), "M001", "Foundation", "foundation"), false);
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("upsertMilestonePlanning renames the on-disk phase dir when the title changes (#1526)", () => {
  const base = makeProject();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "New milestone M001", status: "active" });

    const oldName = canonicalPhaseDirName("M001", "New milestone M001");
    const newName = canonicalPhaseDirName("M001", "Lokably brand foundation");
    const oldDir = join(base, ".gsd", "phases", oldName);
    const newDir = join(base, ".gsd", "phases", newName);
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "01-ROADMAP.md"), "# Placeholder\n");

    upsertMilestonePlanning("M001", { title: "Lokably brand foundation" });

    assert.equal(existsSync(oldDir), false, "placeholder slug dir should be renamed");
    assert.equal(existsSync(newDir), true, "canonical slug dir should exist after title update");
    assert.equal(readFileSync(join(newDir, "01-ROADMAP.md"), "utf8"), "# Placeholder\n");
  } finally {
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── Issue #2: rows re-keyed to a phase dir that never moved ─────────────────

test("upsertMilestonePlanning renames the phase dir when .gsd is a symlink to external state (#2)", () => {
  const { base, state } = makeSymlinkedProject();
  try {
    openDatabase(createWorkspace(base).contract.projectDb);
    insertMilestone({ id: "M003", title: "New milestone M003", status: "active" });

    const oldName = canonicalPhaseDirName("M003", "New milestone M003");
    const newName = canonicalPhaseDirName("M003", "Brand foundation");
    mkdirSync(join(state, "phases", oldName), { recursive: true });
    writeFileSync(join(state, "phases", oldName, "03-ROADMAP.md"), "# Placeholder\n");

    upsertMilestonePlanning("M003", { title: "Brand foundation" });

    assert.equal(existsSync(join(state, "phases", oldName)), false, "placeholder slug dir should be renamed");
    assert.equal(existsSync(join(state, "phases", newName)), true, "canonical slug dir should exist");
  } finally {
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("upsertMilestonePlanning never leaves artifact rows keyed to a missing phase dir (#2)", () => {
  const { base, state } = makeSymlinkedProject();
  try {
    openDatabase(createWorkspace(base).contract.projectDb);
    insertMilestone({ id: "M003", title: "New milestone M003", status: "active" });

    const oldName = canonicalPhaseDirName("M003", "New milestone M003");
    mkdirSync(join(state, "phases", oldName), { recursive: true });
    writeFileSync(join(state, "phases", oldName, "03-ROADMAP.md"), "# Placeholder\n");
    insertArtifact({
      path: `phases/${oldName}/03-ROADMAP.md`,
      artifact_type: "roadmap",
      milestone_id: "M003",
      slice_id: null,
      task_id: null,
      full_content: "# Placeholder\n",
    });

    upsertMilestonePlanning("M003", { title: "Brand foundation" });

    const rows = getArtifactsByPathPrefix("phases/");
    assert.equal(rows.length, 1);
    for (const row of rows) {
      assert.equal(existsSync(join(state, row.path)), true, `row path has no file on disk: ${row.path}`);
    }
  } finally {
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("artifact rows stay under the resolved dir when the rename is blocked (#2)", () => {
  const base = makeProject();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M003", title: "New milestone M003", status: "active" });

    const oldName = canonicalPhaseDirName("M003", "New milestone M003");
    const blockerName = canonicalPhaseDirName("M003", "Brand foundation");
    mkdirSync(join(base, ".gsd", "phases", oldName), { recursive: true });
    writeFileSync(join(base, ".gsd", "phases", oldName, "03-ROADMAP.md"), "# Placeholder\n");
    // A pre-existing dir at the canonical name blocks the rename.
    mkdirSync(join(base, ".gsd", "phases", blockerName), { recursive: true });
    insertArtifact({
      path: `phases/${oldName}/03-ROADMAP.md`,
      artifact_type: "roadmap",
      milestone_id: "M003",
      slice_id: null,
      task_id: null,
      full_content: "# Placeholder\n",
    });

    upsertMilestonePlanning("M003", { title: "Brand foundation" });

    // Rows must agree with the dir path resolution picks, and it must exist —
    // whichever of the two candidates that turns out to be.
    const resolved = resolveMilestonePath(base, "M003");
    assert.ok(resolved, "milestone dir should resolve");
    const resolvedName = basename(resolved);
    for (const row of getArtifactsByPathPrefix("phases/")) {
      assert.equal(row.path.split("/")[1], resolvedName, `row is keyed off the resolved dir: ${row.path}`);
      assert.equal(existsSync(join(base, ".gsd", "phases", resolvedName)), true);
    }
  } finally {
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
  }
});

test("a rejected status transition leaves the phase dir untouched (#2)", () => {
  const base = makeProject();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M003", title: "New milestone M003", status: "complete" });

    const oldName = canonicalPhaseDirName("M003", "New milestone M003");
    const newName = canonicalPhaseDirName("M003", "Brand foundation");
    mkdirSync(join(base, ".gsd", "phases", oldName), { recursive: true });

    // Reopening a closed milestone is rejected, so nothing about the rename may
    // have happened by the time the transaction rolls back.
    assert.throws(() => upsertMilestonePlanning("M003", { title: "Brand foundation", status: "active" }));

    assert.equal(existsSync(join(base, ".gsd", "phases", oldName)), true, "dir must not move when the write is rejected");
    assert.equal(existsSync(join(base, ".gsd", "phases", newName)), false);
  } finally {
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
  }
});
