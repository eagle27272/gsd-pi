import test from "node:test";
import assert from "node:assert/strict";
import { makeHerdrEmitters } from "../auto.ts";
import { HERDR_CHANNELS } from "../../shared/herdr-events.ts";

function fakePi() {
  const emitted: Array<[string, unknown]> = [];
  const pi = { events: { emit: (e: string, p: unknown) => emitted.push([e, p]) } } as any;
  return { pi, emitted };
}

test("syncHerdr emits SYNC with preferences + state", () => {
  const { pi, emitted } = fakePi();
  const { syncHerdr } = makeHerdrEmitters(pi);
  const state = { phase: "executing", activeMilestone: { id: "M1" } } as any;
  syncHerdr({ herdr: { enabled: true } } as any, state);
  assert.deepEqual(emitted, [[HERDR_CHANNELS.SYNC, { preferences: { herdr: { enabled: true } }, state }]]);
});

test("clearHerdr emits CLEAR with preferences", () => {
  const { pi, emitted } = fakePi();
  const { clearHerdr } = makeHerdrEmitters(pi);
  clearHerdr(undefined);
  assert.deepEqual(emitted, [[HERDR_CHANNELS.CLEAR, { preferences: undefined }]]);
});
