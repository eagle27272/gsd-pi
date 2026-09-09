// gsd-pi — Shared Herdr event channel contracts.
//
// Neutral module for gsd <-> herdr decoupling: both the GSD extension and the
// herdr extension import from here; neither imports the other. Mirrors the
// pattern of the removed shared/cmux-events.ts (commit 9b5c992c).

export const HERDR_CHANNELS = {
  /** Auto-mode workflow state changed; refresh the Herdr pane title / state labels. */
  SYNC: "herdr:sync",
  /** Auto-mode ended; clear GSD-owned Herdr pane title / state labels. */
  CLEAR: "herdr:clear",
} as const;

/** Structural slice of GSD preferences the herdr side needs. */
export interface HerdrPreferencesInput {
  herdr?: {
    enabled?: boolean; // default: true
    notifications?: boolean; // default: true
    title?: boolean; // default: true
  };
}

/** Structural slice of GSDState the herdr side needs. */
export interface HerdrStateInput {
  phase: string;
  activeMilestone?: { id: string; title?: string };
  activeSlice?: { id: string };
  activeTask?: { id: string };
  progress?: {
    milestones: { done: number; total: number };
    slices?: { done: number; total: number };
    tasks?: { done: number; total: number };
  };
}

export interface HerdrSyncEvent {
  preferences?: HerdrPreferencesInput;
  state: HerdrStateInput;
}

export interface HerdrClearEvent {
  preferences?: HerdrPreferencesInput;
}
