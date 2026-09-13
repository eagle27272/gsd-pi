/**
 * Tests for `/gsd add-tests` slice discovery.
 *
 * findLastCompletedSlice() picks the newest slice with a SUMMARY projection in
 * the flat-phase layout (.gsd/phases/NN-slug/NN-MM-SUMMARY.md).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findLastCompletedSlice } from "../commands-add-tests.js";
import { _clearGsdRootCache, clearPathCache } from "../paths.js";

describe("findLastCompletedSlice", () => {
  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-add-tests-")));
    _clearGsdRootCache();
    clearPathCache();
  });

  afterEach(() => {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(base, { recursive: true, force: true });
  });

  function phase(dirName: string, files: Record<string, string>): string {
    const dir = join(base, ".gsd", "phases", dirName);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, "utf-8");
    }
    return dir;
  }

  it("returns null when the phase has no slice SUMMARY files", () => {
    phase("01-foundation", { "01-01-PLAN.md": "# plan\n", "01-ROADMAP.md": "# roadmap\n" });
    assert.equal(findLastCompletedSlice(base, "M001"), null);
  });

  it("returns the highest-numbered slice with a SUMMARY in the flat-phase dir", () => {
    phase("01-foundation", {
      "01-01-SUMMARY.md": "# S01 done\n",
      "01-03-SUMMARY.md": "# S03 done\n",
      "01-02-PLAN.md": "# S02 planned but not done\n",
    });
    assert.equal(findLastCompletedSlice(base, "M001"), "S03");
  });

  it("orders slices numerically, not lexically", () => {
    phase("01-foundation", {
      "01-02-SUMMARY.md": "# S02 done\n",
      "01-10-SUMMARY.md": "# S10 done\n",
    });
    assert.equal(findLastCompletedSlice(base, "M001"), "S10");
  });

  it("ignores the milestone-level SUMMARY and per-task SUMMARY files", () => {
    phase("02-payments", {
      "02-SUMMARY.md": "# milestone summary\n",
      "S01-T01-SUMMARY.md": "# task summary\n",
    });
    assert.equal(findLastCompletedSlice(base, "M002"), null);
  });

  it("returns null when the milestone has no phase directory", () => {
    phase("02-payments", { "02-01-SUMMARY.md": "# S01 done\n" });
    assert.equal(findLastCompletedSlice(base, "M001"), null);
  });
});
