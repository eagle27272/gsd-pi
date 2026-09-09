import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isEnabled, targetRepo, DEFAULT_REPO, SOFT_CAP } from "../config.ts";

describe("gsd-bug-report config", () => {
  test("isEnabled defaults to true when unset", () => {
    assert.equal(isEnabled({}), true);
  });

  test("isEnabled is false for off/0/false, case-insensitively", () => {
    for (const v of ["off", "OFF", "0", "false", "False", " off "]) {
      assert.equal(isEnabled({ GSD_BUG_REPORT: v }), false, `value: ${JSON.stringify(v)}`);
    }
  });

  test("isEnabled is true for other values", () => {
    for (const v of ["on", "1", "true", "yes"]) {
      assert.equal(isEnabled({ GSD_BUG_REPORT: v }), true, `value: ${JSON.stringify(v)}`);
    }
  });

  test("targetRepo defaults to DEFAULT_REPO", () => {
    assert.equal(targetRepo({}), DEFAULT_REPO);
    assert.equal(DEFAULT_REPO, "eagle27272/gsd-pi");
  });

  test("targetRepo honors GSD_BUG_REPORT_REPO when it looks like owner/repo", () => {
    assert.equal(targetRepo({ GSD_BUG_REPORT_REPO: "me/fork" }), "me/fork");
  });

  test("targetRepo ignores a malformed override", () => {
    assert.equal(targetRepo({ GSD_BUG_REPORT_REPO: "not-a-repo" }), DEFAULT_REPO);
  });

  test("SOFT_CAP is 3", () => {
    assert.equal(SOFT_CAP, 3);
  });
});
