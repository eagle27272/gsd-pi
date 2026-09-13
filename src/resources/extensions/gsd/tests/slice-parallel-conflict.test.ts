/**
 * Tests for slice-level parallel conflict detection.
 * Verifies hasFileConflict() correctly identifies when two slices
 * touch too many of the same files to safely run in parallel.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasFileConflict } from "../slice-parallel-conflict.js";
import { _clearGsdRootCache } from "../paths.js";
import { milestoneIdToPhaseNum, slicePlanFileName } from "../layout-policy.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PHASE_DIR = "01-test";

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-slice-conflict-test-"));
  mkdirSync(join(base, ".gsd", "phases", PHASE_DIR), { recursive: true });
  return base;
}

/** Flat-phase plan file: .gsd/phases/NN-slug/NN-MM-PLAN.md */
function writeSlicePlan(base: string, mid: string, sid: string, content: string): void {
  const dir = join(base, ".gsd", "phases", PHASE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, slicePlanFileName(milestoneIdToPhaseNum(mid), sid, "PLAN")),
    content,
    "utf-8",
  );
}

describe("hasFileConflict", () => {
  let base: string;

  beforeEach(() => {
    base = makeTmpBase();
  });

  afterEach(() => {
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  });

  it("two slices with >5 overlapping file paths → blocked (true)", () => {
    const planA = `# Plan S01
## Tasks
- T01: Update src/auth/login.ts
- T02: Update src/auth/register.ts
- T03: Update src/auth/session.ts
- T04: Update src/auth/middleware.ts
- T05: Update src/auth/types.ts
- T06: Update src/auth/utils.ts
`;
    const planB = `# Plan S02
## Tasks
- T01: Refactor src/auth/login.ts
- T02: Refactor src/auth/register.ts
- T03: Refactor src/auth/session.ts
- T04: Refactor src/auth/middleware.ts
- T05: Refactor src/auth/types.ts
- T06: Refactor src/auth/utils.ts
`;
    writeSlicePlan(base, "M001", "S01", planA);
    writeSlicePlan(base, "M001", "S02", planB);
    assert.equal(hasFileConflict(base, "M001", "S01", "S02"), true);
  });

  it("two slices with 0 overlapping paths → allowed (false)", () => {
    const planA = `# Plan S01
## Tasks
- T01: Create src/api/routes.ts
- T02: Create src/api/handlers.ts
`;
    const planB = `# Plan S02
## Tasks
- T01: Create src/ui/components.ts
- T02: Create src/ui/styles.ts
`;
    writeSlicePlan(base, "M001", "S01", planA);
    writeSlicePlan(base, "M001", "S02", planB);
    assert.equal(hasFileConflict(base, "M001", "S01", "S02"), false);
  });

  it("missing PLAN.md → conservative block (true)", () => {
    // Only create one slice's plan
    writeSlicePlan(base, "M001", "S01", "# Plan\n- T01: src/foo.ts");
    // S02 has no plan at all
    assert.equal(hasFileConflict(base, "M001", "S01", "S02"), true);
  });

  it("one slice empty plan → allowed (false)", () => {
    writeSlicePlan(base, "M001", "S01", "# Plan S01\n## Tasks\n- T01: Create src/foo.ts");
    writeSlicePlan(base, "M001", "S02", "# Plan S02\n## Tasks\n(no tasks yet)");
    assert.equal(hasFileConflict(base, "M001", "S01", "S02"), false);
  });

  it("resolves plans in a phase dir whose slug does not match the milestone id", () => {
    // The phase slug is derived from the milestone title, so it is never
    // predictable from the milestone id alone — resolution must go through
    // resolveSliceFile rather than any constructed path.
    rmSync(join(base, ".gsd", "phases", PHASE_DIR), { recursive: true, force: true });
    const dir = join(base, ".gsd", "phases", "01-payments-rework");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-01-PLAN.md"), "# Plan S01\n- T01: src/api/routes.ts", "utf-8");
    writeFileSync(join(dir, "01-02-PLAN.md"), "# Plan S02\n- T01: src/ui/styles.ts", "utf-8");
    assert.equal(hasFileConflict(base, "M001", "S01", "S02"), false);
  });

  it("blocks a non-canonical slice id whose plan is absent rather than borrowing S01's plan (#1975)", () => {
    // R01 is a remediation slice added by gsd_reassess_roadmap. Its plan file is
    // 01-R01-PLAN.md; it must never resolve to S01's 01-01-PLAN.md.
    writeSlicePlan(base, "M001", "S01", "# Plan S01\n- T01: Create src/api/routes.ts");
    assert.equal(hasFileConflict(base, "M001", "S01", "R01"), true);
  });

  it("analyses R01's own plan once it exists (regression: plan segment is the slice id)", () => {
    writeSlicePlan(base, "M001", "S01", "# Plan S01\n- T01: Create src/api/routes.ts");
    writeSlicePlan(base, "M001", "R01", "# Plan R01\n- T01: Create src/ui/styles.ts");
    assert.equal(hasFileConflict(base, "M001", "S01", "R01"), false);
  });

  it("blocks when no phase directory exists at all (unknown overlap → fail closed)", () => {
    rmSync(join(base, ".gsd", "phases", PHASE_DIR), { recursive: true, force: true });
    assert.equal(hasFileConflict(base, "M001", "S01", "S02"), true);
  });
});
