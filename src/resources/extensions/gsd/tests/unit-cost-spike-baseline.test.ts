// Project/App: gsd-pi
// File Purpose: The cost-spike baseline must exclude the unit being judged (#17).

import assert from "node:assert/strict";
import { test } from "node:test";

import { getUnitCostSpikeAction, splitUnitCostBaseline } from "../auto-budget.ts";

function spikeAction(costs: number[]): "none" | "pause" {
  // Last entry is the unit under judgement; earlier entries are its history.
  const units = costs.map((cost, i) => ({ id: `U${i}`, cost }));
  const target = `U${costs.length - 1}`;
  const { unitCostUsd, rollingAvgUsd } = splitUnitCostBaseline(units, target);
  return getUnitCostSpikeAction(unitCostUsd, rollingAvgUsd);
}

test("a 100x unit pauses on the very first unit that has any history", () => {
  // Every one of these was "none" while the current unit diluted its own
  // baseline: firing needed C·(N−3) ≥ 3·P, so no spike could trip the guard
  // until the fourth unit of a run.
  assert.equal(spikeAction([1, 100]), "pause");
  assert.equal(spikeAction([1, 1, 100]), "pause");
  assert.equal(spikeAction([1, 1, 1, 100]), "pause");
});

test("the first unit of a run has no baseline to spike against", () => {
  assert.equal(spikeAction([100]), "none");
});

test("a unit in line with its history does not pause", () => {
  assert.equal(spikeAction([10, 10, 12]), "none");
  assert.equal(spikeAction([10, 10, 29]), "none");
  assert.equal(spikeAction([10, 10, 30]), "pause");
});

test("repeated ledger entries for the same unit sum into its own cost, not the baseline", () => {
  const units = [
    { id: "U0", cost: 1 },
    { id: "U1", cost: 60 },
    { id: "U1", cost: 40 },
  ];
  assert.deepEqual(splitUnitCostBaseline(units, "U1"), { unitCostUsd: 100, rollingAvgUsd: 1 });
});

test("negative and non-finite costs drop out of the baseline entirely", () => {
  const units = [
    { id: "U0", cost: 2 },
    { id: "U1", cost: -5 },
    { id: "U2", cost: Number.NaN },
    { id: "U3", cost: 4 },
    { id: "U4", cost: 30 },
  ];
  assert.deepEqual(splitUnitCostBaseline(units, "U4"), { unitCostUsd: 30, rollingAvgUsd: 3 });
});

test("a unit with a non-numeric cost still counts as a zero-cost unit in the baseline", () => {
  const units = [
    { id: "U0", cost: 2 },
    { id: "U1", cost: "4" as unknown as number },
    { id: "U2", cost: 4 },
    { id: "U3", cost: 30 },
  ];
  assert.deepEqual(splitUnitCostBaseline(units, "U3"), { unitCostUsd: 30, rollingAvgUsd: 2 });
});

test("an empty or absent ledger yields no baseline", () => {
  assert.deepEqual(splitUnitCostBaseline([], "U0"), { unitCostUsd: 0, rollingAvgUsd: 0 });
  assert.deepEqual(splitUnitCostBaseline(null, "U0"), { unitCostUsd: 0, rollingAvgUsd: 0 });
  assert.deepEqual(splitUnitCostBaseline(undefined, "U0"), { unitCostUsd: 0, rollingAvgUsd: 0 });
});
