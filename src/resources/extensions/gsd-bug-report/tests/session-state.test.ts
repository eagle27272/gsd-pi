import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { filedThisSession, recordFiled, resetSession } from "../session-state.ts";

beforeEach(() => resetSession());

describe("session-state", () => {
  test("starts at zero", () => {
    assert.equal(filedThisSession(), 0);
  });
  test("recordFiled increments", () => {
    recordFiled();
    recordFiled();
    assert.equal(filedThisSession(), 2);
  });
  test("resetSession clears the count", () => {
    recordFiled();
    resetSession();
    assert.equal(filedThisSession(), 0);
  });
});
