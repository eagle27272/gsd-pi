// Project/App: gsd-pi
// File Purpose: Pins that entering GSD WITHOUT auto refuses a pre-flat-phase layout.
//
// The deleted session_start migration block fired on every session; its
// replacement, assertNoLegacyLayout, was wired only into startAuto (resume) and
// bootstrapAutoSession (fresh auto start). An operator who types `/gsd` reaches
// neither. hasGsdBootstrapArtifacts keys on `phases/`, so the legacy project
// reports "not bootstrapped" and showProjectInit would bootstrap a second,
// empty .gsd tree alongside the untouched milestones/<MID>/ one.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { showSmartEntry } from "../guided-flow.js";

test("entering without auto refuses a content-bearing milestones/<MID>/ layout", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-smart-entry-legacy-layout-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), "# M001: Legacy layout\n");

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    hasUI: false,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: () => {},
    },
  } as unknown as Parameters<typeof showSmartEntry>[0];
  const pi = {
    sendMessage: () => {
      throw new Error("a refused entry must not dispatch a prompt");
    },
    getActiveTools: () => [],
    setActiveTools: () => {},
  } as unknown as Parameters<typeof showSmartEntry>[1];

  await assert.rejects(
    showSmartEntry(ctx, pi, base),
    /pre-flat-phase milestones\/<MID>\/ layout/,
    "entry without auto must refuse the layout the auto paths already refuse",
  );

  // The refusal has to land before init: bootstrapping a fresh .gsd beside the
  // legacy tree is exactly the corruption the guard exists to prevent.
  assert.equal(
    existsSync(join(base, ".gsd", "phases")),
    false,
    "a refused entry must not bootstrap a flat-phase tree",
  );
  assert.equal(
    existsSync(join(base, ".gsd", "PREFERENCES.md")),
    false,
    "a refused entry must not run the init wizard",
  );
});
