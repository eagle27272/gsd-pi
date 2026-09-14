// Project/App: gsd-pi
// File Purpose: The operational verification-class gate must reject failure text (#17).

import assert from "node:assert/strict";
import { test } from "node:test";

import { _operationalVerificationAddressed } from "../milestone-closeout.ts";

test("text asserting every verification class failed does not satisfy the gate", () => {
  // Both matchers used to pass this: "NOT MET" contains the substring "MET",
  // and the prose regex matched the same "met".
  assert.equal(
    _operationalVerificationAddressed("## Operational\nStatus: NOT MET. Every verification class FAILED."),
    false,
  );
  assert.equal(
    _operationalVerificationAddressed("## Operational: FAILED — no checks PASSED"),
    false,
  );
});

test("an unmet or unverified operational class does not satisfy the gate", () => {
  assert.equal(_operationalVerificationAddressed("## Operational\nUNMET"), false);
  assert.equal(_operationalVerificationAddressed("## Operational\nnot satisfied"), false);
  assert.equal(_operationalVerificationAddressed("## Operational\nnot covered by this milestone"), false);
  assert.equal(_operationalVerificationAddressed("## Operational\nhealth check PASSED, alerting FAILED"), false);
});

test("a positive operational verdict satisfies the gate", () => {
  assert.equal(_operationalVerificationAddressed("## Operational\nStatus: MET"), true);
  assert.equal(_operationalVerificationAddressed("## Operational\nStatus: SATISFIED"), true);
  assert.equal(_operationalVerificationAddressed("## Operational\nAll dashboards verified ✅"), true);
  assert.equal(_operationalVerificationAddressed("Operational verification deferred to M002"), true);
});

test("an explicit not-applicable verdict satisfies the gate", () => {
  assert.equal(_operationalVerificationAddressed("## Operational\nN/A — no runtime surface"), true);
  assert.equal(_operationalVerificationAddressed("## Operational\nNot applicable for a docs-only milestone"), true);
  assert.equal(_operationalVerificationAddressed("## Operational\nNot required"), true);
});

test("validation output that never mentions the operational class does not satisfy the gate", () => {
  assert.equal(_operationalVerificationAddressed("## Functional\nAll tests PASSED and MET."), false);
  assert.equal(_operationalVerificationAddressed(""), false);
});

test("a failure elsewhere in the document does not poison an addressed operational section", () => {
  const content = [
    "## Functional",
    "Three regression tests FAILED and were fixed.",
    "",
    "## Operational",
    "Status: MET — dashboards and alerting confirmed.",
  ].join("\n");
  assert.equal(_operationalVerificationAddressed(content), true);
});

test("skip markers still short-circuit the gate", () => {
  assert.equal(_operationalVerificationAddressed("skip_validation: true"), true);
  assert.equal(_operationalVerificationAddressed("Validation skipped due to budget"), true);
  assert.equal(_operationalVerificationAddressed("Ran the trivial-scope pipeline variant"), true);
});
