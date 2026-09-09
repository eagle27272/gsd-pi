import test from "node:test";
import assert from "node:assert/strict";
import { detectHerdrEnv, isHerdrTerminal } from "../env.ts";

const base = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p2",
  HERDR_BIN_PATH: "/usr/local/bin/herdr",
  HERDR_SOCKET_PATH: "/tmp/herdr.sock",
} as NodeJS.ProcessEnv;

test("detectHerdrEnv returns the env when all required vars are present", () => {
  assert.deepEqual(detectHerdrEnv(base), {
    paneId: "w1:p2",
    binPath: "/usr/local/bin/herdr",
    socketPath: "/tmp/herdr.sock",
  });
});

test("detectHerdrEnv omits socketPath when unset", () => {
  const { HERDR_SOCKET_PATH, ...rest } = base as Record<string, string>;
  assert.deepEqual(detectHerdrEnv(rest), {
    paneId: "w1:p2",
    binPath: "/usr/local/bin/herdr",
    socketPath: undefined,
  });
});

test("detectHerdrEnv returns null when HERDR_ENV is not exactly '1'", () => {
  assert.equal(detectHerdrEnv({ ...base, HERDR_ENV: "0" }), null);
  assert.equal(detectHerdrEnv({ ...base, HERDR_ENV: "" }), null);
  assert.equal(detectHerdrEnv({ ...base, HERDR_ENV: "true" }), null);
});

test("detectHerdrEnv returns null when pane id or bin path is missing/empty", () => {
  assert.equal(detectHerdrEnv({ ...base, HERDR_PANE_ID: "" }), null);
  assert.equal(detectHerdrEnv({ ...base, HERDR_PANE_ID: "   " }), null);
  const { HERDR_BIN_PATH, ...noBin } = base as Record<string, string>;
  assert.equal(detectHerdrEnv(noBin), null);
});

test("detectHerdrEnv returns null on an empty environment", () => {
  assert.equal(detectHerdrEnv({}), null);
});

test("isHerdrTerminal mirrors detectHerdrEnv truthiness", () => {
  assert.equal(isHerdrTerminal(base), true);
  assert.equal(isHerdrTerminal({}), false);
});
