/**
 * Behavioural regression test for #2645 — double mergeAndExit guard — and #7,
 * which gave the guard milestone identity.
 *
 * AutoSession.milestoneMergedInPhasesFor records WHICH milestone the in-loop
 * closeout already merged. stopAuto reads it to skip the redundant Step-4
 * merge (which previously failed because the branch was already deleted).
 * As a session-wide boolean it never expired, so every milestone after the
 * first in a run had its merge silently skipped (#7).
 *
 * Refs #4829 (rewrite from positional source-grep on phases.ts/auto.ts).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AutoSession, hasMergedMilestoneInPhases } from "../auto/session.ts";

describe("AutoSession.milestoneMergedInPhasesFor (#2645, #7)", () => {
  test("defaults to null on a fresh session", () => {
    const session = new AutoSession();
    assert.equal(
      session.milestoneMergedInPhasesFor,
      null,
      "new session should have no merged milestone recorded",
    );
  });

  test("reset() clears the recorded milestone back to null", () => {
    const session = new AutoSession();
    session.milestoneMergedInPhasesFor = "M001";
    session.reset();
    assert.equal(
      session.milestoneMergedInPhasesFor,
      null,
      "reset() should clear milestoneMergedInPhasesFor back to null",
    );
  });
});

describe("hasMergedMilestoneInPhases (#7)", () => {
  test("suppresses a second merge of the same milestone", () => {
    assert.equal(
      hasMergedMilestoneInPhases({ milestoneMergedInPhasesFor: "M001" }, "M001"),
      true,
    );
  });

  test("does not suppress the next milestone's merge", () => {
    assert.equal(
      hasMergedMilestoneInPhases({ milestoneMergedInPhasesFor: "M001" }, "M002"),
      false,
      "a merged M001 must not mark M002 as already merged",
    );
  });

  test("a null milestone id never counts as merged", () => {
    assert.equal(
      hasMergedMilestoneInPhases({ milestoneMergedInPhasesFor: null }, null),
      false,
      "null === null must not read as 'already merged'",
    );
    assert.equal(
      hasMergedMilestoneInPhases({ milestoneMergedInPhasesFor: "M001" }, undefined),
      false,
    );
  });

  test("nothing merged yet means nothing is suppressed", () => {
    assert.equal(
      hasMergedMilestoneInPhases({ milestoneMergedInPhasesFor: null }, "M001"),
      false,
    );
  });
});
