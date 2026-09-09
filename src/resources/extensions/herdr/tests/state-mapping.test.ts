import test from "node:test";
import assert from "node:assert/strict";
import { buildHerdrTitle, buildStateLabels } from "../state-mapping.ts";
import type { HerdrStateInput } from "../../shared/herdr-events.ts";

test("buildHerdrTitle: milestone + slice + task + phase", () => {
  const s: HerdrStateInput = {
    phase: "executing",
    activeMilestone: { id: "M2" },
    activeSlice: { id: "S1" },
    activeTask: { id: "T3" },
  };
  assert.equal(buildHerdrTitle(s), "M2 S1/T3 · executing");
});

test("buildHerdrTitle: milestone only", () => {
  assert.equal(
    buildHerdrTitle({ phase: "planning", activeMilestone: { id: "M2" } }),
    "M2 · planning",
  );
});

test("buildHerdrTitle: milestone + task, no slice → space-joined (not M2/T3)", () => {
  assert.equal(
    buildHerdrTitle({ phase: "executing", activeMilestone: { id: "M2" }, activeTask: { id: "T3" } }),
    "M2 T3 · executing",
  );
});

test("buildHerdrTitle: no unit → phase only", () => {
  assert.equal(buildHerdrTitle({ phase: "researching" }), "researching");
});

test("buildHerdrTitle: normalizes and truncates to 80 chars", () => {
  const s: HerdrStateInput = {
    phase: "executing",
    activeMilestone: { id: "M1", title: "x".repeat(200) },
  };
  const out = buildHerdrTitle(s);
  assert.ok(out.length <= 80, `expected <=80, got ${out.length}`);
  assert.ok(!/\s{2,}/.test(out));
});

test("buildStateLabels: progress fraction prefers tasks, then slices, then milestones", () => {
  assert.deepEqual(
    buildStateLabels({
      phase: "executing",
      activeMilestone: { id: "M2" },
      progress: {
        milestones: { done: 1, total: 4 },
        slices: { done: 2, total: 3 },
        tasks: { done: 3, total: 8 },
      },
    }),
    { working: "M2 · 3/8 tasks" },
  );
  assert.deepEqual(
    buildStateLabels({
      phase: "executing",
      progress: { milestones: { done: 1, total: 4 } },
    }),
    { working: "1/4 milestones" },
  );
});

test("buildStateLabels: no progress → empty object", () => {
  assert.deepEqual(buildStateLabels({ phase: "planning" }), {});
});
