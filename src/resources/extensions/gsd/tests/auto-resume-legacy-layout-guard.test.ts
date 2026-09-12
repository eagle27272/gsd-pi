// Project/App: gsd-pi
// File Purpose: Pins that the resume path refuses a pre-flat-phase layout.
//
// startAuto returns from the resume branch long before bootstrapAutoSession —
// the only other caller of assertNoLegacyLayout — so a resumed session used to
// keep running against a layout the fresh-start path refuses outright. Fresh
// start refusing while resume silently misreads is the dangerous asymmetry.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startAuto } from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";

test("resuming auto-mode refuses a content-bearing milestones/<MID>/ layout", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-resume-legacy-layout-"));
  t.after(() => {
    autoSession.reset();
    rmSync(base, { recursive: true, force: true });
  });

  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), "# M001: Legacy layout\n");

  autoSession.reset();
  // Resume, not fresh start: startAuto takes the paused branch and returns
  // before it would ever reach bootstrapAutoSession's guard.
  autoSession.paused = true;

  const notifications: string[] = [];
  const ctx = {
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: { getSessionId: () => "resume-legacy-layout-test" },
    modelRegistry: { getAvailable: () => [], isProviderRequestReady: () => false },
    model: undefined,
  } as unknown as Parameters<typeof startAuto>[0];
  const pi = { getThinkingLevel: () => "off" } as unknown as Parameters<typeof startAuto>[1];

  await assert.rejects(
    startAuto(ctx, pi, base, false),
    /pre-flat-phase milestones\/<MID>\/ layout/,
    "resume must refuse the layout the fresh-start path already refuses",
  );
  assert.equal(autoSession.active, false, "a refused resume must not activate auto-mode");
});
