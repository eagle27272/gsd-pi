import test from "node:test";
import assert from "node:assert/strict";
import { HerdrReporter } from "../reporter.ts";
import type { HerdrEnv } from "../env.ts";

const env: HerdrEnv = { paneId: "w1:p2", binPath: "/bin/herdr" };

function spyReporter() {
  const calls: string[][] = [];
  const r = new HerdrReporter({ env, runner: (_file, args) => calls.push(args) });
  return { r, calls };
}

test("reportState builds the documented report-agent argv", () => {
  const { r, calls } = spyReporter();
  r.reportState("working");
  assert.deepEqual(calls[0], [
    "pane", "report-agent", "w1:p2",
    "--source", "custom:gsd", "--agent", "gsd",
    "--state", "working", "--seq", "1",
  ]);
});

test("reportState appends --message when given", () => {
  const { r, calls } = spyReporter();
  r.reportState("blocked", { message: "waiting on approval" });
  assert.deepEqual(calls[0].slice(-4), ["--seq", "1", "--message", "waiting on approval"]);
});

test("--seq strictly increases across mixed calls", () => {
  const { r, calls } = spyReporter();
  r.reportState("working");
  r.reportMetadata({ title: "M1 · planning" });
  r.reportSession({ sessionId: "abc" });
  r.release();
  const seqs = calls.map((a) => Number(a[a.indexOf("--seq") + 1]));
  assert.deepEqual(seqs, [1, 2, 3, 4]);
});

test("reportState dedups identical consecutive calls but not after a change", () => {
  const { r, calls } = spyReporter();
  r.reportState("working");
  r.reportState("working");
  r.reportState("idle");
  r.reportState("idle", { message: "done" });
  assert.deepEqual(calls.map((a) => a[a.indexOf("--state") + 1]), ["working", "idle", "idle"]);
});

test("reportMetadata dedups identical payloads", () => {
  const { r, calls } = spyReporter();
  r.reportMetadata({ title: "M1", stateLabels: { working: "1/2 tasks" } });
  r.reportMetadata({ title: "M1", stateLabels: { working: "1/2 tasks" } });
  assert.equal(calls.length, 1);
});

test("reportMetadata: null title emits --clear-title; empty labels emit --clear-state-labels", () => {
  const { r, calls } = spyReporter();
  r.reportMetadata({ title: null, stateLabels: {} });
  assert.ok(calls[0].includes("--clear-title"));
  assert.ok(calls[0].includes("--clear-state-labels"));
});

test("reportMetadata: one --state-label per entry", () => {
  const { r, calls } = spyReporter();
  r.reportMetadata({ title: "M1", stateLabels: { working: "w", blocked: "b" } });
  const labels = calls[0].filter((_, i) => calls[0][i - 1] === "--state-label");
  assert.deepEqual(labels.sort(), ["blocked=b", "working=w"]);
});

test("release is never deduped and resets the dedup caches", () => {
  const { r, calls } = spyReporter();
  r.reportState("idle");
  r.release();
  r.release();
  r.reportState("idle"); // sends again — cache was reset by release
  assert.deepEqual(
    calls.map((a) => a[1]),
    ["report-agent", "release-agent", "release-agent", "report-agent"],
  );
});

test("title/label text is normalized and truncated to 80 chars", () => {
  const { r, calls } = spyReporter();
  r.reportMetadata({ title: "a\nb   c" + "x".repeat(200) });
  const title = calls[0][calls[0].indexOf("--title") + 1];
  assert.ok(title.length <= 80);
  assert.ok(!/\s{2,}/.test(title) && !title.includes("\n"));
});

test("a throwing runner is swallowed", () => {
  const r = new HerdrReporter({ env, runner: () => { throw new Error("boom"); } });
  assert.doesNotThrow(() => r.reportState("working"));
});

test("the default runner does not spawn for a bogus bin (smoke: no throw)", () => {
  const r = new HerdrReporter({ env: { paneId: "w1:p2", binPath: "/nonexistent/herdr-xyz" } });
  assert.doesNotThrow(() => r.reportState("working"));
});
