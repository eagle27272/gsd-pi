import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import gsdBugReport, { runReport, type ReportDeps } from "../index.ts";
import { resetSession, filedThisSession } from "../session-state.ts";

const baseEnvSnapshot = (): ReturnType<NonNullable<ReportDeps["now"]>> => ({
  version: "1.18.0", commit: "abc1234", platform: "darwin", arch: "arm64",
  node: "v22.19.0", cwdProject: "some-app",
});

function fakeGh(over: Partial<ReportDeps["gh"]> = {}): ReportDeps["gh"] {
  return {
    ghAvailable: () => true,
    searchIssues: () => ({ ok: true, data: [] }),
    createIssue: () => ({ ok: true, data: "https://github.com/eagle27272/gsd-pi/issues/99" }),
    ...over,
  };
}

const input = {
  title: "gsd auto hangs on unit phase",
  body: "Steps: run gsd auto. Expected: proceeds. Actual: hangs.",
  category: "runtime" as const,
};

beforeEach(() => resetSession());

describe("runReport", () => {
  test("disabled → status disabled, nothing filed", async () => {
    let created = 0;
    const r = await runReport(input, {
      env: { GSD_BUG_REPORT: "off" },
      gh: fakeGh({ createIssue: () => { created++; return { ok: true, data: "x" }; } }),
      confirm: async () => true,
      now: baseEnvSnapshot,
    });
    assert.equal(r.status, "disabled");
    assert.equal(created, 0);
  });

  test("duplicate → status duplicate, no confirm, no create", async () => {
    let confirmed = false;
    const r = await runReport(input, {
      env: {},
      gh: fakeGh({
        searchIssues: () => ({ ok: true, data: [
          { number: 7, title: "Unit phase hangs during gsd auto", url: "https://gh/7", state: "open" },
        ] }),
      }),
      confirm: async () => { confirmed = true; return true; },
      now: baseEnvSnapshot,
    });
    assert.equal(r.status, "duplicate");
    assert.match(r.message, /#7/);
    assert.equal(confirmed, false);
  });

  test("decline at confirm → status declined, no create, counter unchanged", async () => {
    let created = 0;
    const r = await runReport(input, {
      env: {},
      gh: fakeGh({ createIssue: () => { created++; return { ok: true, data: "x" }; } }),
      confirm: async () => false,
      now: baseEnvSnapshot,
    });
    assert.equal(r.status, "declined");
    assert.equal(created, 0);
  });

  test("approve → status filed, URL returned, counter increments", async () => {
    const r = await runReport(input, {
      env: {}, gh: fakeGh(), confirm: async () => true, now: baseEnvSnapshot,
    });
    assert.equal(r.status, "filed");
    assert.equal(r.url, "https://github.com/eagle27272/gsd-pi/issues/99");
    assert.equal(filedThisSession(), 1);
  });

  test("createIssue fails after confirm → status manual, counter NOT incremented", async () => {
    const r = await runReport(input, {
      env: {},
      gh: fakeGh({ createIssue: () => ({ ok: false, error: "gh: 403" }) }),
      confirm: async () => true,
      now: baseEnvSnapshot,
    });
    assert.equal(r.status, "manual");
    assert.match(r.message, /403/);
    assert.match(r.message, /issues\/new/);
    // a failed create must not consume the per-session budget
    assert.equal(filedThisSession(), 0);
  });

  test("no-UI confirm seam → status manual (not declined), nothing filed", async () => {
    let created = 0;
    const r = await runReport(input, {
      env: {},
      gh: fakeGh({ createIssue: () => { created++; return { ok: true, data: "x" }; } }),
      confirm: async () => "no-ui",
      now: baseEnvSnapshot,
    });
    assert.equal(r.status, "manual");
    assert.match(r.message, /issues\/new/);
    assert.match(r.message, /Paste-ready command/);
    assert.equal(created, 0);
    assert.equal(filedThisSession(), 0);
  });

  test("soft cap → 4th call returns capped without touching gh", async () => {
    const deps: ReportDeps = { env: {}, gh: fakeGh(), confirm: async () => true, now: baseEnvSnapshot };
    for (let i = 0; i < 3; i++) await runReport({ ...input, title: `bug number ${i}` }, deps);
    let touched = false;
    const r = await runReport({ ...input, title: "bug number four" }, {
      ...deps,
      gh: fakeGh({ searchIssues: () => { touched = true; return { ok: true, data: [] }; } }),
    });
    assert.equal(r.status, "capped");
    assert.equal(touched, false);
  });

  test("gh unavailable → status manual, draft + prefilled URL in message, no create", async () => {
    const r = await runReport(input, {
      env: {},
      gh: fakeGh({ ghAvailable: () => false }),
      confirm: async () => true,
      now: baseEnvSnapshot,
    });
    assert.equal(r.status, "manual");
    assert.match(r.message, /issues\/new/);
    assert.match(r.message, /gsd auto hangs on unit phase/);
  });

  test("dedupe search failure is non-fatal → proceeds to confirm", async () => {
    const r = await runReport(input, {
      env: {},
      gh: fakeGh({ searchIssues: () => ({ ok: false, error: "network" }) }),
      confirm: async () => true,
      now: baseEnvSnapshot,
    });
    assert.equal(r.status, "filed");
  });
});

describe("gsdBugReport registration", () => {
  test("registers exactly the tool, command, and session_start hook", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const fakePi = {
      registerTool: (spec: { name: string; promptGuidelines?: string[] }) => {
        tools.push(spec.name);
        assert.ok((spec.promptGuidelines?.length ?? 0) > 0, "tool carries promptGuidelines");
      },
      registerCommand: (name: string) => { commands.push(name); },
      on: (event: string) => { events.push(event); },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gsdBugReport(fakePi as any);
    assert.deepEqual(tools, ["report_gsd_bug"]);
    assert.deepEqual(commands, ["report-gsd-bug"]);
    assert.ok(events.includes("session_start"));
  });
});
