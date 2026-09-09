import test from "node:test";
import assert from "node:assert/strict";
import { HERDR_CHANNELS } from "../herdr-events.ts";

test("HERDR_CHANNELS has stable wire values", () => {
  assert.equal(HERDR_CHANNELS.SYNC, "herdr:sync");
  assert.equal(HERDR_CHANNELS.CLEAR, "herdr:clear");
  assert.deepEqual(Object.keys(HERDR_CHANNELS).sort(), ["CLEAR", "SYNC"]);
});
