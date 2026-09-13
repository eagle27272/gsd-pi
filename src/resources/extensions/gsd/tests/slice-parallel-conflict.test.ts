/**
 * Tests for slice-level parallel conflict detection.
 * Verifies hasFileConflict() correctly identifies when two slices
 * touch too many of the same files to safely run in parallel.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasFileConflict } from "../slice-parallel-conflict.js";
import { canonicalPhaseDirName, milestoneIdToPhaseNum, slicePlanFileName } from "../layout-policy.js";
import { _clearGsdRootCache, clearPathCache } from "../paths.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-slice-conflict-test-")));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

/** Write a flat-phase slice plan: .gsd/phases/NN-slug/NN-MM-PLAN.md */
function writeSlicePlan(base: string, mid: string, sid: string, content: string): void {
  const dir = join(base, ".gsd", "phases", canonicalPhaseDirName(mid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, slicePlanFileName(milestoneIdToPhaseNum(mid), sid, "PLAN")), content, "utf-8");
}

describe("hasFileConflict", () => {
  let base: string;

  beforeEach(() => {
    base = makeTmpBase();
    _clearGsdRootCache();
    clearPathCache();
  });

  afterEach(() => {
    _clearGsdRootCache();
    clearPathCache();
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

  it("reads plans from a titled flat-phase directory, not a legacy milestones/ tree", () => {
    const phaseDir = join(base, ".gsd", "phases", "02-payments");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(
      join(phaseDir, "02-01-PLAN.md"),
      "# Plan S01\n- T01: Create src/pay/charge.ts\n",
      "utf-8",
    );
    writeFileSync(
      join(phaseDir, "02-02-PLAN.md"),
      "# Plan S02\n- T01: Create src/ui/cart.ts\n",
      "utf-8",
    );

    assert.equal(
      hasFileConflict(base, "M002", "S01", "S02"),
      false,
      "both plans resolve in the flat-phase dir, so the disjoint file sets must allow parallel",
    );
  });
});
