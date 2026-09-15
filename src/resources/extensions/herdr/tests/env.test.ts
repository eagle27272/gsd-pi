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

test("detectHerdrEnv falls back to `herdr` on PATH when HERDR_BIN_PATH is absent", () => {
  // Herdr exports HERDR_ENV / HERDR_PANE_ID / HERDR_SOCKET_PATH into every pane
  // but only sets HERDR_BIN_PATH as an override, so requiring it no-ops the
  // whole extension in a normal pane.
  const { HERDR_BIN_PATH, ...noBin } = base as Record<string, string>;
  assert.deepEqual(detectHerdrEnv(noBin), {
    paneId: "w1:p2",
    binPath: "herdr",
    socketPath: "/tmp/herdr.sock",
  });
  assert.equal(detectHerdrEnv({ ...base, HERDR_BIN_PATH: "   " })?.binPath, "herdr");
});

test("detectHerdrEnv returns null when HERDR_ENV is not exactly '1'", () => {
  assert.equal(detectHerdrEnv({ ...base, HERDR_ENV: "0" }), null);
  assert.equal(detectHerdrEnv({ ...base, HERDR_ENV: "" }), null);
  assert.equal(detectHerdrEnv({ ...base, HERDR_ENV: "true" }), null);
});

test("detectHerdrEnv returns null when pane id or socket path is missing/empty", () => {
  assert.equal(detectHerdrEnv({ ...base, HERDR_PANE_ID: "" }), null);
  assert.equal(detectHerdrEnv({ ...base, HERDR_PANE_ID: "   " }), null);
  assert.equal(detectHerdrEnv({ ...base, HERDR_SOCKET_PATH: "" }), null);
  const { HERDR_SOCKET_PATH, ...noSocket } = base as Record<string, string>;
  assert.equal(detectHerdrEnv(noSocket), null);
});

test("detectHerdrEnv returns null on an empty environment", () => {
  assert.equal(detectHerdrEnv({}), null);
});

test("isHerdrTerminal mirrors detectHerdrEnv truthiness", () => {
  assert.equal(isHerdrTerminal(base), true);
  assert.equal(isHerdrTerminal({}), false);
});
