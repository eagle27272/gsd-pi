// Project/App: gsd-pi
// File Purpose: Subjective-UAT tool results must surface the binding IDs the answer tool requires.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import {
  executeAnswerMilestoneSubjectiveUat,
  executePrepareMilestoneSubjectiveUat,
} from "../tools/workflow-tool-executors.ts";

let basePath: string | undefined;

function setup(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-subjective-uat-executor-"));
  basePath = base;
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Subjective UAT", status: "active" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.milestone.adopt",
    idempotencyKey: "fixture/milestone/adopt",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId: "M001" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.milestone.adopted",
        entityType: "milestone",
        entityId: "M001",
        payload: { milestoneId: "M001" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/milestone/m001",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  return base;
}

function prepareParams() {
  return {
    milestoneId: "M001",
    criterionKey: "guided-flow",
    description: "The guided flow feels natural and clear.",
    focusedPrompt: "Does the guided flow feel natural and clear?",
    recommendedDisposition: "accepted" as const,
    recommendationRationale: "Automated checks passed and the guided path is complete.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision: "source-a",
  };
}

function resultText(result: { content: Array<{ type: "text"; text: string }> }): string {
  return result.content.map((block) => block.text).join("\n");
}

afterEach(() => {
  closeDatabase();
  if (basePath) rmSync(basePath, { recursive: true, force: true });
  basePath = undefined;
});

test("prepare surfaces the binding and option IDs the answer tool requires (#220)", async () => {
  const base = setup();

  const prepared = await executePrepareMilestoneSubjectiveUat(
    prepareParams(),
    base,
    internalExecutionInvocation("subjective/prepare/1"),
  );

  assert.notEqual(prepared.isError, true, resultText(prepared));
  const text = resultText(prepared);
  for (const field of ["criterionId", "questionId", "interactionId"] as const) {
    const id = prepared.details[field];
    assert.equal(typeof id, "string");
    assert.ok(
      text.includes(String(id)),
      `prepare result text must include ${field} (${String(id)}); got:\n${text}`,
    );
  }
  const options = prepared.details["options"] as Array<{ optionId: string; label: string }>;
  for (const option of options) {
    assert.ok(
      text.includes(option.optionId),
      `prepare result text must include selectable optionId ${option.optionId}; got:\n${text}`,
    );
    // The answer writer rejects any verbatimResponse that is not the exact
    // option label, so the label has to be reachable from the tool result too.
    assert.ok(
      text.includes(option.label),
      `prepare result text must include option label ${option.label}; got:\n${text}`,
    );
  }
});

test("IDs echoed by prepare settle the criterion through the answer tool (#220)", async () => {
  const base = setup();

  const prepared = await executePrepareMilestoneSubjectiveUat(
    prepareParams(),
    base,
    internalExecutionInvocation("subjective/prepare/1"),
  );
  assert.notEqual(prepared.isError, true, resultText(prepared));

  const acceptedOptionId = String(prepared.details["acceptedOptionId"]);
  const options = prepared.details["options"] as Array<{ optionId: string; label: string }>;
  const accepted = options.find((option) => option.optionId === acceptedOptionId);
  assert.ok(accepted);

  const answered = await executeAnswerMilestoneSubjectiveUat({
    criterionId: String(prepared.details["criterionId"]),
    questionId: String(prepared.details["questionId"]),
    interactionId: String(prepared.details["interactionId"]),
    selectedOptionId: acceptedOptionId,
    verbatimResponse: accepted.label,
    rationale: "User confirmed the flow reads naturally.",
    testedSourceRevision: "source-a",
  }, base, {
    ...internalExecutionInvocation("subjective/answer/1"),
    actorType: "user",
    actorId: "developer",
  });

  assert.notEqual(answered.isError, true, resultText(answered));
  assert.equal(answered.details["disposition"], "accepted");
  const text = resultText(answered);
  for (const field of ["criterionId", "questionId", "humanAcceptanceId"] as const) {
    const id = answered.details[field];
    assert.equal(typeof id, "string");
    assert.ok(
      text.includes(String(id)),
      `answer result text must include ${field} (${String(id)}); got:\n${text}`,
    );
  }
});
