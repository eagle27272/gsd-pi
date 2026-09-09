import test from "node:test";
import assert from "node:assert/strict";
import { __wire, isBlockedNotification } from "../index.ts";
import { HERDR_CHANNELS } from "../../shared/herdr-events.ts";

type Handler = (event: unknown, ctx?: unknown) => void;

function fakePi() {
  const on = new Map<string, Handler[]>();
  const busOn = new Map<string, Handler[]>();
  const add = (m: Map<string, Handler[]>, k: string, h: Handler) => {
    const arr = m.get(k) ?? [];
    arr.push(h);
    m.set(k, arr);
  };
  const pi = {
    on: (event: string, handler: Handler) => add(on, event, handler),
    events: {
      on: (event: string, handler: Handler) => add(busOn, event, handler),
      emit: (event: string, payload: unknown) => (busOn.get(event) ?? []).forEach((h) => h(payload)),
    },
  } as unknown as import("@gsd/pi-coding-agent").ExtensionAPI;
  const fire = (event: string, payload?: unknown, ctx?: unknown) =>
    (on.get(event) ?? []).forEach((h) => h(payload, ctx));
  return { pi, fire };
}

function fakeReporter() {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    reportState: (s: string, o?: unknown) => calls.push(["state", { s, o }]),
    reportSession: (o: unknown) => calls.push(["session", o]),
    reportMetadata: (o: unknown) => calls.push(["metadata", o]),
    release: () => calls.push(["release", null]),
  };
}

const allOn = () => ({ enabled: true, notifications: true, title: true });

test("agent_start / turn_start → working; turn_end / stop(completed) → idle", () => {
  const { pi, fire } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, allOn);
  fire("agent_start", { type: "agent_start" });
  fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
  fire("turn_end", { type: "turn_end" });
  fire("stop", { type: "stop", reason: "completed" });
  assert.deepEqual(rep.calls.map((c) => [c[0], (c[1] as any).s]), [
    ["state", "working"], ["state", "working"], ["state", "idle"], ["state", "idle"],
  ]);
});

test("stop(blocked) and blocked/input_needed notifications → blocked", () => {
  const { pi, fire } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, allOn);
  fire("stop", { type: "stop", reason: "blocked" });
  fire("notification", { type: "notification", kind: "blocked", message: "need approval" });
  fire("notification", { type: "notification", kind: "input_needed", message: "pick one" });
  fire("notification", { type: "notification", kind: "idle", message: "ignored" });
  assert.deepEqual(
    rep.calls.map((c) => [c[0], (c[1] as any).s, (c[1] as any).o?.message]),
    [["state", "blocked", undefined], ["state", "blocked", "need approval"], ["state", "blocked", "pick one"]],
  );
});

test("session_start reads identity from ctx.sessionManager", () => {
  const { pi, fire } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, allOn);
  fire("session_start", { type: "session_start", reason: "startup" }, {
    sessionManager: { getSessionId: () => "sid-1", getSessionFile: () => "/s/sid-1.jsonl" },
  });
  assert.deepEqual(rep.calls, [["session", { sessionId: "sid-1", sessionPath: "/s/sid-1.jsonl" }]]);
});

test("session_shutdown then session_end → exactly one release", () => {
  const { pi, fire } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, allOn);
  fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
  fire("session_end", { type: "session_end", reason: "user" });
  assert.deepEqual(rep.calls, [["release", null]]);
});

test("enabled:false registers no lifecycle handlers", () => {
  const { pi, fire } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, () => ({ enabled: false, notifications: true, title: true }));
  fire("agent_start", { type: "agent_start" });
  fire("turn_end", { type: "turn_end" });
  assert.equal(rep.calls.length, 0);
});

test("SYNC → reportMetadata with title + labels; title:false suppresses it", () => {
  const { pi } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, allOn);
  pi.events.emit(HERDR_CHANNELS.SYNC, {
    state: { phase: "executing", activeMilestone: { id: "M2" }, activeTask: { id: "T3" },
      progress: { milestones: { done: 1, total: 3 }, tasks: { done: 3, total: 8 } } },
  });
  assert.deepEqual(rep.calls, [["metadata", { title: "M2 T3 · executing", stateLabels: { working: "M2 · 3/8 tasks" } }]]);

  const rep2 = fakeReporter();
  const { pi: pi2 } = fakePi();
  __wire(pi2, rep2, () => ({ enabled: true, notifications: true, title: false }));
  pi2.events.emit(HERDR_CHANNELS.SYNC, { state: { phase: "executing", activeMilestone: { id: "M2" } } });
  assert.equal(rep2.calls.length, 0);
});

test("CLEAR → reportMetadata clears title + labels", () => {
  const { pi } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, allOn);
  pi.events.emit(HERDR_CHANNELS.CLEAR, {});
  assert.deepEqual(rep.calls, [["metadata", { title: null, stateLabels: {} }]]);
});

test("CLEAR is a no-op when herdr.enabled is false", () => {
  const { pi } = fakePi();
  const rep = fakeReporter();
  __wire(pi, rep, () => ({ enabled: false, notifications: true, title: true }));
  pi.events.emit(HERDR_CHANNELS.CLEAR, {});
  assert.equal(rep.calls.length, 0);
});

test("isBlockedNotification allowlist", () => {
  assert.equal(isBlockedNotification("blocked"), true);
  assert.equal(isBlockedNotification("input_needed"), true);
  assert.equal(isBlockedNotification("error"), false);
  assert.equal(isBlockedNotification("idle"), false);
});
