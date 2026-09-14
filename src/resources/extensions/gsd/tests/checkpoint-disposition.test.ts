// Project/App: gsd-pi
// File Purpose: Safety-harness checkpoint disposition after a unit stops (#17).

import assert from "node:assert/strict";
import { test } from "node:test";

import { _resolveCheckpointDisposition } from "../auto/unit-phase.ts";

test("a cancelled unit rolls back when auto_rollback is on", () => {
  assert.equal(_resolveCheckpointDisposition("cancelled", true), "rollback");
});

test("a cancelled unit retains the checkpoint when auto_rollback is off", () => {
  assert.equal(_resolveCheckpointDisposition("cancelled", false), "retain");
});

test("a completed unit with no artifact is a failure, not a cleanup", () => {
  // The old harness ran `cleanupCheckpoint` here, destroying the pre-unit ref
  // for a unit that had in fact failed its artifact check.
  assert.equal(_resolveCheckpointDisposition("no-artifact", true), "rollback");
  assert.equal(_resolveCheckpointDisposition("no-artifact", false), "retain");
});

test("a genuinely completed unit cleans up its checkpoint", () => {
  assert.equal(_resolveCheckpointDisposition("completed", true), "cleanup");
  assert.equal(_resolveCheckpointDisposition("completed", false), "cleanup");
});
