import test from "node:test";
import assert from "node:assert/strict";
import { detectCapabilities, resetCapabilitiesCache } from "../../packages/pi-tui/src/terminal-image.ts";
import { isCmuxTerminal, isHerdrTerminal } from "../resources/extensions/shared/terminal.ts";

test("isCmuxTerminal detects cmux env vars", () => {
  assert.equal(isCmuxTerminal({ CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:2" } as NodeJS.ProcessEnv), true);
  assert.equal(isCmuxTerminal({ TERM_PROGRAM: "ghostty" } as NodeJS.ProcessEnv), false);
});

test("isHerdrTerminal detects herdr env vars", () => {
  assert.equal(isHerdrTerminal({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_BIN_PATH: "/usr/local/bin/herdr" } as NodeJS.ProcessEnv), true);
  assert.equal(isHerdrTerminal({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" } as NodeJS.ProcessEnv), false); // no bin path
  assert.equal(isHerdrTerminal({ HERDR_ENV: "0", HERDR_PANE_ID: "w1:p2", HERDR_BIN_PATH: "/x" } as NodeJS.ProcessEnv), false);
  assert.equal(isHerdrTerminal({ TERM_PROGRAM: "ghostty" } as NodeJS.ProcessEnv), false);
});

test("detectCapabilities treats cmux as kitty-capable", (t) => {
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    CMUX_WORKSPACE_ID: "workspace:1",
    CMUX_SURFACE_ID: "surface:2",
    TERM_PROGRAM: "ghostty",
  };
  t.after(() => {
    process.env = originalEnv;
    resetCapabilitiesCache();
  });

  resetCapabilitiesCache();
  assert.deepEqual(detectCapabilities(), {
    images: "kitty",
    trueColor: true,
    hyperlinks: true,
  });
});
