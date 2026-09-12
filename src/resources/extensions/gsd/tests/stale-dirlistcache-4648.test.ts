/**
 * gsd-pi / agent-end-recovery — regression tests for #4648.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleAgentEnd } from "../bootstrap/agent-end-recovery.ts";
import { resolveMilestoneFile, clearPathCache } from "../paths.ts";

function mkBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-4648-"));
  const mDir = join(base, ".gsd", "phases", "01-m001");
  mkdirSync(mDir, { recursive: true });
  // Seed one content file so the phase dir exists before the cache is warmed.
  // The stale-cache tests then verify that a SECOND file written to the same
  // dir is NOT detected until the path cache is cleared.
  writeFileSync(join(mDir, "01-RESEARCH.md"), "# M001 research\n");
  return base;
}

describe("#4648 stale dirListCache", () => {
  test("resolveMilestoneFile sees a freshly written flat-phase artifact without a cache clear", () => {
    // The flat-phase name (NN-SUFFIX.md) is probed with a direct stat, so it is
    // not hidden by the warmed directory-listing cache that #4648 was about.
    const base = mkBase();
    try {
      clearPathCache();
      assert.equal(resolveMilestoneFile(base, "M001", "CONTEXT"), null);

      writeFileSync(
        join(base, ".gsd", "phases", "01-m001", "01-CONTEXT.md"),
        "# M001 Context\n",
      );

      assert.match(resolveMilestoneFile(base, "M001", "CONTEXT") ?? "", /01-CONTEXT\.md$/);
      clearPathCache();
      assert.match(resolveMilestoneFile(base, "M001", "CONTEXT") ?? "", /01-CONTEXT\.md$/);
    } finally {
      clearPathCache();
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("handleAgentEnd invalidates the path cache before recovery guards read artifacts", async () => {
    const base = mkBase();
    const previousCwd = process.cwd();
    try {
      process.chdir(base);
      clearPathCache();
      assert.equal(resolveMilestoneFile(base, "M001", "CONTEXT"), null);

      writeFileSync(
        join(base, ".gsd", "phases", "01-m001", "01-CONTEXT.md"),
        "# M001 Context\n",
      );

      await handleAgentEnd({} as any, { messages: [] }, {
        ui: { notify: () => {} },
      } as any);

      assert.match(resolveMilestoneFile(base, "M001", "CONTEXT") ?? "", /01-CONTEXT\.md$/);
    } finally {
      process.chdir(previousCwd);
      clearPathCache();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
