import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  BUG_REPORT_GUIDELINES,
  categoryToLabels,
  matchExistingIssue,
  enrichBody,
  renderDraft,
  type IssueHit,
  type ReportEnv,
} from "../report.ts";

const hit = (over: Partial<IssueHit>): IssueHit => ({
  number: 1, title: "t", url: "https://x/1", state: "open", ...over,
});

describe("categoryToLabels", () => {
  test("runtime/dx/test → [bug]", () => {
    for (const c of ["runtime", "dx", "test"] as const) {
      assert.deepEqual(categoryToLabels(c), ["bug"]);
    }
  });
  test("docs → [bug, documentation]", () => {
    assert.deepEqual(categoryToLabels("docs"), ["bug", "documentation"]);
  });
});

describe("matchExistingIssue", () => {
  test("returns null on empty list", () => {
    assert.equal(matchExistingIssue("gsd auto hangs on unit phase", []), null);
  });
  test("matches on case-insensitive substring", () => {
    const hits = [hit({ number: 12, title: "gsd auto hangs on unit phase sometimes" })];
    assert.equal(matchExistingIssue("gsd auto hangs on unit phase", hits)?.number, 12);
  });
  test("matches on high token overlap despite reordering", () => {
    const hits = [hit({ number: 7, title: "Unit phase hangs during gsd auto" })];
    assert.equal(matchExistingIssue("gsd auto hangs on unit phase", hits)?.number, 7);
  });
  test("does not match a weakly related title", () => {
    const hits = [hit({ number: 9, title: "Docs typo in README install section" })];
    assert.equal(matchExistingIssue("gsd auto hangs on unit phase", hits), null);
  });
});

describe("enrichBody", () => {
  const env: ReportEnv = {
    version: "1.18.0", commit: "abc1234", platform: "darwin", arch: "arm64",
    node: "v22.19.0", cwdProject: "some-app",
  };
  test("appends an environment block and footer", () => {
    const out = enrichBody("Original body.", env);
    assert.match(out, /Original body\./);
    assert.match(out, /--- environment ---/);
    assert.match(out, /gsd-pi: 1\.18\.0/);
    assert.match(out, /commit: abc1234/);
    assert.match(out, /darwin arm64/);
    assert.match(out, /node: v22\.19\.0/);
    assert.match(out, /_Filed via gsd-pi self-report\._\s*$/);
  });
  test("omits the commit line when commit is null", () => {
    const out = enrichBody("b", { ...env, commit: null });
    assert.doesNotMatch(out, /commit:/);
  });
});

describe("renderDraft", () => {
  test("shows title, labels, and body", () => {
    const out = renderDraft({ title: "T", labels: ["bug", "documentation"], body: "B" });
    assert.match(out, /T/);
    assert.match(out, /bug, documentation/);
    assert.match(out, /B/);
  });
});

describe("BUG_REPORT_GUIDELINES", () => {
  test("names the non-bug exclusions", () => {
    const text = BUG_REPORT_GUIDELINES.join("\n").toLowerCase();
    assert.ok(text.includes("test:unit"), "mentions the baseline test:unit failures");
    assert.ok(text.includes("flaky"), "mentions the rotating flaky tests");
    assert.ok(text.includes("current task"), "excludes code being written this task");
    assert.ok(text.includes("report_gsd_bug"), "tells the model which tool to call");
    assert.ok(text.includes("subagent"), "tells subagents to defer to the main session");
  });
});
