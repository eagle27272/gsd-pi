import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ghAvailable,
  searchIssues,
  createIssue,
  truncateBody,
  MAX_ISSUE_BODY,
  _setExecForTest,
  _resetGithubCacheForTest,
} from "../github.ts";

afterEach(() => {
  _setExecForTest(null);
  _resetGithubCacheForTest();
});

describe("ghAvailable", () => {
  test("true when version and auth both succeed", () => {
    _setExecForTest((_file, args) => (args.includes("--version") ? "gh version 2.100.0" : "Logged in"));
    assert.equal(ghAvailable(), true);
  });
  test("false when gh is missing (ENOENT)", () => {
    _setExecForTest(() => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); });
    assert.equal(ghAvailable(), false);
  });
  test("false when auth status fails", () => {
    _setExecForTest((_file, args) => {
      if (args.includes("--version")) return "gh version 2.100.0";
      throw new Error("not logged in");
    });
    assert.equal(ghAvailable(), false);
  });
});

describe("searchIssues", () => {
  test("parses the JSON array into IssueHit[]", () => {
    _setExecForTest(() => JSON.stringify([
      { number: 5, title: "A bug", url: "https://gh/5", state: "OPEN" },
    ]));
    const r = searchIssues("me/repo", "a bug");
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, [{ number: 5, title: "A bug", url: "https://gh/5", state: "OPEN" }]);
  });
  test("returns ok:false on a gh failure", () => {
    _setExecForTest(() => { throw new Error("gh: network error"); });
    const r = searchIssues("me/repo", "x");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /network error/);
  });
  test("returns ok:false on unparseable output", () => {
    _setExecForTest(() => "not json");
    assert.equal(searchIssues("me/repo", "x").ok, false);
  });
});

describe("truncateBody", () => {
  test("returns a body at or under the cap unchanged", () => {
    assert.equal(truncateBody("short body"), "short body");
    const exact = "x".repeat(MAX_ISSUE_BODY);
    assert.equal(truncateBody(exact), exact);
  });
  test("caps an oversized body and appends the truncation note", () => {
    const out = truncateBody("x".repeat(MAX_ISSUE_BODY + 5_000));
    assert.ok(out.length < MAX_ISSUE_BODY + 200, "trimmed near the cap");
    assert.match(out, /_Body truncated \(exceeded 65k characters\)\._$/);
  });
});

describe("createIssue", () => {
  test("returns the issue URL from stdout", () => {
    _setExecForTest((_file, args) => {
      assert.ok(args.includes("--repo") && args.includes("me/repo"));
      assert.ok(args.includes("--label") && args.includes("bug,documentation"));
      return "https://github.com/me/repo/issues/42\n";
    });
    const r = createIssue("me/repo", { title: "T", body: "B", labels: ["bug", "documentation"] });
    assert.deepEqual(r, { ok: true, data: "https://github.com/me/repo/issues/42" });
  });
  test("returns ok:false when gh exits non-zero", () => {
    _setExecForTest(() => { throw new Error("gh: 403"); });
    assert.equal(createIssue("me/repo", { title: "T", body: "B", labels: ["bug"] }).ok, false);
  });
});
