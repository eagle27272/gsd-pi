// Project/App: gsd-pi
// File Purpose: Pure budget and context guard decisions for GSD auto-mode.
/**
 * Budget alert level tracking and enforcement for auto-mode.
 * Pure functions — no module state or side effects.
 */

import type { BudgetEnforcementMode, TokenProfile } from "./types.js";

export type BudgetAlertLevel = 0 | 75 | 80 | 90 | 100;

export function getBudgetAlertLevel(budgetPct: number): BudgetAlertLevel {
  if (budgetPct >= 1.0) return 100;
  if (budgetPct >= 0.90) return 90;
  if (budgetPct >= 0.80) return 80;
  if (budgetPct >= 0.75) return 75;
  return 0;
}

export function getNewBudgetAlertLevel(previousLevel: BudgetAlertLevel, budgetPct: number): BudgetAlertLevel | null {
  const currentLevel = getBudgetAlertLevel(budgetPct);
  if (currentLevel === 0 || currentLevel <= previousLevel) return null;
  return currentLevel;
}

export function getBudgetEnforcementAction(
  enforcement: BudgetEnforcementMode,
  budgetPct: number,
): "none" | "warn" | "pause" | "halt" {
  if (budgetPct < 1.0) return "none";
  if (enforcement === "halt") return "halt";
  if (enforcement === "pause") return "pause";
  return "warn";
}

/** The cost-bearing shape of a metrics-ledger unit entry. */
export interface LedgerUnitCost {
  id?: unknown;
  cost?: unknown;
}

/**
 * Split a metrics ledger into the cost of one unit and the rolling average of
 * every *other* unit — the baseline `getUnitCostSpikeAction` judges it against.
 *
 * The unit under judgement must not appear in its own baseline. While it did
 * (#17), a spike diluted the average it was compared to: with N ledger units
 * and multiplier 3, firing required `cost·(N−3) ≥ 3·priorTotal`, so no spike
 * could trip the guard until the fourth unit of a run — `[100]`, `[1,100]` and
 * `[1,1,100]` all passed. A unit may contribute several ledger rows; all of
 * them belong to its own cost, none to the baseline.
 */
export function splitUnitCostBaseline(
  units: readonly LedgerUnitCost[] | null | undefined,
  unitId: string,
): { unitCostUsd: number; rollingAvgUsd: number } {
  if (!Array.isArray(units) || units.length === 0) {
    return { unitCostUsd: 0, rollingAvgUsd: 0 };
  }
  let unitCostUsd = 0;
  let baselineCost = 0;
  let baselineUnits = 0;
  for (const unit of units) {
    const cost = typeof unit?.cost === "number" ? unit.cost : 0;
    if (!Number.isFinite(cost) || cost < 0) continue;
    if (unit?.id === unitId) {
      unitCostUsd += cost;
      continue;
    }
    baselineCost += cost;
    baselineUnits++;
  }
  return {
    unitCostUsd,
    rollingAvgUsd: baselineUnits > 0 ? baselineCost / baselineUnits : 0,
  };
}

export function getUnitCostSpikeAction(
  unitCostUsd: number,
  rollingAvgUsd: number,
  multiplier = 3.0,
): "none" | "pause" {
  if (!Number.isFinite(unitCostUsd) || unitCostUsd < 0) return "none";
  if (!Number.isFinite(rollingAvgUsd) || rollingAvgUsd <= 0) return "none";
  if (!Number.isFinite(multiplier) || multiplier <= 0) return "none";
  return unitCostUsd >= (rollingAvgUsd * multiplier) ? "pause" : "none";
}

/**
 * Resolve the rolling-average cost-spike multiplier for `getUnitCostSpikeAction`
 * from preferences. The `burn-max` token profile opts out of the spike pause
 * entirely (returns Infinity, which `getUnitCostSpikeAction` treats as "none").
 * An explicit finite, positive `unit_cost_spike_multiplier` overrides the
 * default; otherwise the default of 3.0 applies.
 */
export function resolveUnitCostSpikeMultiplier(
  prefs: { token_profile?: TokenProfile; unit_cost_spike_multiplier?: number } | null | undefined,
): number {
  if (prefs?.token_profile === "burn-max") return Infinity;
  const override = prefs?.unit_cost_spike_multiplier;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;
  return 3.0;
}

export function getContextPauseAction(
  contextPercent: number | null | undefined,
  thresholdPercent: number,
): "none" | "pause" {
  if (!Number.isFinite(contextPercent) || !Number.isFinite(thresholdPercent)) return "none";
  if (contextPercent === null || contextPercent === undefined || thresholdPercent <= 0) return "none";

  const usage = contextPercent <= 1 ? contextPercent * 100 : contextPercent;
  const threshold = thresholdPercent <= 1 ? thresholdPercent * 100 : thresholdPercent;
  return usage >= threshold ? "pause" : "none";
}

/** Normalize compaction_threshold_percent pref (0.5–0.95 ratio) to a 0–100 scale. */
export function resolveCompactionThresholdPercent(raw: number | undefined): number {
  const value =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0.5 && raw <= 0.95 ? raw : 0.6;
  return value <= 1 ? value * 100 : value;
}

export const HARD_CONTEXT_REROOT_THRESHOLD_PERCENT = 90;

export function shouldWarnStepSessionForContext(
  contextPercent: number | null | undefined,
  compactionThresholdPercent?: number,
): boolean {
  return getContextPauseAction(
    contextPercent,
    resolveCompactionThresholdPercent(compactionThresholdPercent),
  ) === "pause";
}

export function shouldRerootStepSessionForContext(
  contextPercent: number | null | undefined,
): boolean {
  return getContextPauseAction(
    contextPercent,
    HARD_CONTEXT_REROOT_THRESHOLD_PERCENT,
  ) === "pause";
}
