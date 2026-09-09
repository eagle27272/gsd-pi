// gsd-pi — Map GSD workflow state onto Herdr pane display strings.
// Pure functions; mirrors the removed cmux buildCmuxStatusLabel / buildCmuxProgress.

import type { HerdrStateInput } from "../shared/herdr-events.js";

export type HerdrLabelState = "working" | "idle" | "blocked";

const MAX = 80;

/** Strip control chars, collapse whitespace, hard-truncate to Herdr's 80-char cap. */
export function normalizeDisplay(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX);
}

/**
 * e.g. "M2 S1/T3 · executing", "M2 T3 · executing" (no slice), "M2 · planning",
 * or just "researching". The task id joins the slice with "/" ONLY when a slice
 * is active; without a slice it joins the milestone id with a space.
 */
export function buildHerdrTitle(s: HerdrStateInput): string {
  const unit: string[] = [];
  if (s.activeMilestone) unit.push(s.activeMilestone.id);
  if (s.activeSlice) unit.push(s.activeSlice.id);
  if (s.activeTask) {
    if (s.activeSlice) {
      const prev = unit.pop();
      unit.push(prev ? `${prev}/${s.activeTask.id}` : s.activeTask.id);
    } else {
      unit.push(s.activeTask.id);
    }
  }
  const left = unit.join(" ");
  return normalizeDisplay(left ? `${left} · ${s.phase}` : s.phase);
}

/** A `working` state-label carrying the tightest available progress fraction. */
export function buildStateLabels(s: HerdrStateInput): Partial<Record<HerdrLabelState, string>> {
  const p = s.progress;
  if (!p) return {};
  const pick = (done: number, total: number, noun: string): string | null =>
    total > 0 ? `${done}/${total} ${noun}` : null;

  const frac =
    pick(p.tasks?.done ?? 0, p.tasks?.total ?? 0, "tasks") ??
    pick(p.slices?.done ?? 0, p.slices?.total ?? 0, "slices") ??
    pick(p.milestones.done, p.milestones.total, "milestones");

  if (!frac) return {};
  const prefix = s.activeMilestone ? `${s.activeMilestone.id} · ` : "";
  return { working: normalizeDisplay(`${prefix}${frac}`) };
}
