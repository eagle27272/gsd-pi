import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { HerdrReporter, __resetHerdrSeqForTest } from "../reporter.ts";
import type { HerdrEnv } from "../env.ts";

const env: HerdrEnv = { paneId: "w1:p2", binPath: "/bin/herdr", socketPath: "/tmp/herdr.sock" };

// --seq is a process-global counter shared by every reporter instance; reset it
// before each test so per-test sequences start from a fresh seed.
beforeEach(() => __resetHerdrSeqForTest());

function spyReporter() {
  const calls: string[][] = [];
  const r = new HerdrReporter({ env, runner: (_file, args) => calls.push(args) });
  return { r, calls };
}

function seqOf(args: string[]): number {
  return Number(args[args.indexOf("--seq") + 1]);
}

test("reportState builds the documented report-agent argv", () => {
  const { r, calls } = spyReporter();
  r.reportState("working");
  assert.deepEqual(calls[0].slice(0, -1), [
    "pane", "report-agent", "w1:p2",
    "--source", "custom:gsd", "--agent", "gsd",
    "--state", "working", "--seq",
  ]);
});

test("reportState appends --message after --seq", () => {
  const { r, calls } = spyReporter();
  r.reportState("blocked", { message: "waiting on approval" });
  assert.deepEqual(calls[0].slice(-2), ["--message", "waiting on approval"]);
  assert.equal(calls[0].at(-4), "--seq");
});

test("--seq strictly increases across mixed calls", () => {
  const { r, calls } = spyReporter();
  r.reportState("working");
  r.reportMetadata({ title: "M1 · planning" });
  r.reportSession({ sessionId: "abc" });
  r.release();
  const seqs = calls.map(seqOf);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
});

test("--seq is process-global across separate reporter instances", () => {
  const callsA: string[][] = [];
  const a = new HerdrReporter({ env, runner: (_f, args) => callsA.push(args) });
  a.reportState("working");

  const callsB: string[][] = [];
  const b = new HerdrReporter({ env, runner: (_f, args) => callsB.push(args) });
  b.reportState("idle");
  assert.ok(seqOf(callsB[0]) > seqOf(callsA[0]));
});

test("--seq is seeded from the wall clock", () => {
  const before = Date.now() * 1000;
  __resetHerdrSeqForTest();
  const { r, calls } = spyReporter();
  r.reportState("working");
  const seq = seqOf(calls[0]);
  assert.ok(seq >= before, `${seq} < ${before}`);
  assert.ok(seq <= Date.now() * 1000 + 1, `${seq} > now`);
  assert.ok(Number.isSafeInteger(seq));
});

test("a restarted process outranks the previous process's last --seq", async () => {
  const first = spyReporter();
  for (let i = 0; i < 200; i++) first.r.reportState(i % 2 === 0 ? "working" : "idle");
  const lastOfFirst = seqOf(first.calls.at(-1)!);

  await sleep(2);
  __resetHerdrSeqForTest(); // a fresh gsd process in the same pane

  const second = spyReporter();
  second.r.reportState("working");
  assert.ok(
    seqOf(second.calls[0]) > lastOfFirst,
    `restart seq ${seqOf(second.calls[0])} must exceed ${lastOfFirst} or Herdr ignores it`,
  );
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
  const r = new HerdrReporter({
    env: { paneId: "w1:p2", binPath: "/nonexistent/herdr-xyz", socketPath: "/tmp/herdr.sock" },
  });
  assert.doesNotThrow(() => r.reportState("working"));
});
