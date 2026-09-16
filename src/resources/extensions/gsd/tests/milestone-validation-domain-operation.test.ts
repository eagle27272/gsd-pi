// Project/App: gsd-pi
// File Purpose: RED contracts for durable Milestone validation and DB-only completion readiness.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import { readMilestoneCloseoutReadiness } from "../db/milestone-closeout-readiness.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { clearPathCache } from "../paths.ts";
import { handleCompleteMilestone } from "../tools/complete-milestone.ts";
import {
  handleValidateMilestone,
  type ValidateMilestoneOptions,
  type ValidateMilestoneParams,
} from "../tools/validate-milestone.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";
import {
  answerMilestoneSubjectiveUat,
  hasPendingMilestoneSubjectiveUat,
  prepareMilestoneSubjectiveUat,
  prepareMilestoneSubjectiveUatRetirement,
  retireMilestoneSubjectiveUat,
} from "../milestone-subjective-uat-domain-operation.ts";

const tempDirs = new Set<string>();

type ValidationOptionsWithInvocation = ValidateMilestoneOptions & {
  invocation: ExecutionInvocation;
};

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "milestone-validation-test",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  };
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void = () => {},
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType, idempotencyKey },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: operationType,
        entityType: "milestone",
        entityId: "M001",
        payload: { idempotencyKey },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

// Task 1's stranding guard refuses a second unanswered required subjective
// chain through the public prepare API, so M003's legacy rows — written before
// that guard existed — can only be reproduced by inserting them directly, the
// same way a pre-guard `prepareMilestoneSubjectiveUatQuestion` call would have.
function injectStrandedSubjectiveUatChain(input: {
  lifecycleId: string;
  criterionKey: string;
  description: string;
  focusedPrompt: string;
}): { criterionId: string; questionId: string } {
  const criterionId = randomUUID();
  const questionId = randomUUID();
  const interactionId = randomUUID();
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.milestone.subjective-uat.legacy-prepare",
    idempotencyKey: `legacy-prepare/${input.criterionKey}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { criterionKey: input.criterionKey },
  }, (context) => {
    const createdAt = new Date().toISOString();
    db().prepare(`
      INSERT INTO workflow_acceptance_criteria (
        criterion_id, criterion_key, project_id, lifecycle_id, requirement_id,
        criterion_kind, evidence_class, required, description,
        supersedes_criterion_id, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES (
        :criterion_id, :criterion_key, :project_id, :lifecycle_id, NULL,
        'subjective_uat', 'human', 1, :description,
        NULL, :created_at,
        :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":criterion_id": criterionId,
      ":criterion_key": input.criterionKey,
      ":project_id": context.projectId,
      ":lifecycle_id": input.lifecycleId,
      ":description": input.description,
      ":created_at": createdAt,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    db().prepare(`
      INSERT INTO workflow_open_questions (
        question_id, project_id, lifecycle_id, question_text, question_status,
        state_version, accepted_answer_id, created_at, updated_at,
        created_operation_id, created_project_revision, created_authority_epoch,
        last_operation_id, last_project_revision, last_authority_epoch
      ) VALUES (
        :question_id, :project_id, :lifecycle_id, :question_text, 'open',
        0, NULL, :created_at, :created_at,
        :operation_id, :project_revision, :authority_epoch,
        :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":question_id": questionId,
      ":project_id": context.projectId,
      ":lifecycle_id": input.lifecycleId,
      ":question_text": input.focusedPrompt,
      ":created_at": createdAt,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    db().prepare(`
      INSERT INTO workflow_interactions (
        interaction_id, project_id, question_id, sequence, interaction_kind,
        presentation_state, focused_prompt, requires_answer, option_count,
        recommended_option_id, recommendation_text, recommendation_rationale,
        recommendation_evidence, recommendation_confidence,
        recommendation_uncertainty, revisit_condition, presented_at,
        operation_id, project_revision, authority_epoch
      ) VALUES (
        :interaction_id, :project_id, :question_id, 1, 'subjective-uat',
        'prepared', :focused_prompt, 1, 0,
        NULL, :recommendation_text, :recommendation_rationale,
        '', NULL, '', '', '', :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":interaction_id": interactionId,
      ":project_id": context.projectId,
      ":question_id": questionId,
      ":focused_prompt": input.focusedPrompt,
      ":recommendation_text": "Legacy recommendation predating the stranding guard.",
      ":recommendation_rationale": "Legacy rationale predating the stranding guard.",
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    return {
      events: [{
        eventType: "milestone.subjective-uat.prepared",
        entityType: "milestone",
        entityId: "M001",
        payload: { criterionId, questionId },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `subjective-uat/m001/${questionId}`.toLowerCase(),
        projectionKind: "milestone-subjective-uat",
        rendererVersion: "1",
      }],
    };
  });
  return { criterionId, questionId };
}

function makeBase(plannedUat = "", adopted = true, adoptDescendants = adopted): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-validation-domain-"));
  tempDirs.add(basePath);
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-CONTEXT.md"), "# M001\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'validated';\n");
  execFileSync("git", ["init"], { cwd: basePath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: basePath });
  execFileSync("git", ["add", "source.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: basePath, stdio: "ignore" });

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({
    id: "M001",
    title: "Milestone validation",
    status: "active",
    planning: { verificationUat: plannedUat },
  });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
  if (adopted) executeAtFence("test.milestone.fixture", "fixture/milestone/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    if (adoptDescendants) {
      adoptOrTransitionLifecycle(context, {
        itemKind: "slice",
        milestoneId: "M001",
        sliceId: "S01",
        lifecycleStatus: "completed",
      });
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
        lifecycleStatus: "completed",
      });
    }
  });
  return basePath;
}

const validValidation: ValidateMilestoneParams = {
  milestoneId: "M001",
  verdict: "pass",
  remediationRound: 0,
  successCriteriaChecklist: "- [x] Complete",
  sliceDeliveryAudit: "| S01 | delivered |",
  crossSliceIntegration: "Passed",
  requirementCoverage: "Covered",
  verificationClasses: "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| Contract | focused test | PASS |",
  verdictRationale: "All current database evidence passes.",
};

function validationOptions(idempotencyKey: string): ValidationOptionsWithInvocation {
  return {
    invocation: invocation(idempotencyKey),
    skipBrowserEvidenceGate: true,
  };
}

async function validate(
  basePath: string,
  idempotencyKey: string,
  overrides: Partial<ValidateMilestoneParams> = {},
) {
  return handleValidateMilestone(
    { ...validValidation, ...overrides },
    basePath,
    validationOptions(idempotencyKey),
  );
}

async function complete(basePath: string) {
  return handleCompleteMilestone({
    milestoneId: "M001",
    title: "Milestone validation",
    oneLiner: "Validated closeout",
    narrative: "The Milestone is ready to close.",
    verificationPassed: true,
  }, basePath, invocation("milestone-complete/public"));
}

function sourceRevision(basePath: string): string {
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  if (!source.ok) throw new Error(source.error);
  return source.snapshot.aggregateRevision;
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("Milestone validation commits one immutable receipt and exact replay adds no lineage", async () => {
  const basePath = makeBase();
  const key = "milestone-validate/public/replay";
  const operationsBefore = row("SELECT COUNT(*) AS count FROM workflow_operations").count;

  const committed = await handleValidateMilestone(
    validValidation,
    basePath,
    { ...validationOptions(key), uokGatesEnabled: true },
  );
  assert.ok(!("error" in committed), "initial validation should commit");
  const compatibilityCounts = {
    assessments: row("SELECT COUNT(*) AS count FROM assessments").count,
    gates: row("SELECT COUNT(*) AS count FROM quality_gates").count,
  };
  const compatibilityRows = {
    assessment: db().prepare(`
      SELECT status, full_content, created_at FROM assessments
      WHERE scope = 'milestone-validation'
    `).get(),
    gates: db().prepare(`
      SELECT gate_id, verdict, evaluated_at FROM quality_gates
      WHERE milestone_id = 'M001' ORDER BY gate_id
    `).all(),
    gateRuns: row("SELECT COUNT(*) AS count FROM gate_runs").count,
  };
  writeFileSync(committed.validationPath, "projection repair sentinel\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'drifted after validation';\n");
  const replayed = await handleValidateMilestone(
    validValidation,
    basePath,
    { ...validationOptions(key), uokGatesEnabled: true },
  );

  assert.ok(!("error" in replayed), "exact retry should replay");
  assert.match(
    readFileSync(committed.validationPath, "utf8"),
    /^---\nverdict: pass/m,
    "exact Domain Operation replay should repair the readable projection",
  );
  assert.equal(row("SELECT COUNT(*) AS count FROM assessments").count, compatibilityCounts.assessments);
  assert.equal(row("SELECT COUNT(*) AS count FROM quality_gates").count, compatibilityCounts.gates);
  assert.deepEqual(db().prepare(`
    SELECT status, full_content, created_at FROM assessments
    WHERE scope = 'milestone-validation'
  `).get(), compatibilityRows.assessment);
  assert.deepEqual(db().prepare(`
    SELECT gate_id, verdict, evaluated_at FROM quality_gates
    WHERE milestone_id = 'M001' ORDER BY gate_id
  `).all(), compatibilityRows.gates);
  assert.equal(
    row("SELECT COUNT(*) AS count FROM gate_runs").count,
    compatibilityRows.gateRuns,
    "exact replay must not append UOK gate lineage",
  );
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'milestone.validate' AND idempotency_key = '${key}'
  `).count, 1, "exact retry must retain one immutable operation receipt");
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_domain_events event
    JOIN workflow_operations operation ON operation.operation_id = event.operation_id
    WHERE operation.operation_type = 'milestone.validate'
      AND operation.idempotency_key = '${key}'
  `).count, 1, "exact retry must retain one validation event");
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_operations").count,
    Number(operationsBefore) + 1,
    "one accepted public command must create exactly one Domain Operation",
  );
});

test("unadopted validation keeps legacy compatibility even with transport identity", async () => {
  const basePath = makeBase("", false);
  const result = await handleValidateMilestone(
    validValidation,
    basePath,
    validationOptions("milestone-validate/public/unadopted"),
  );

  assert.ok(!("error" in result));
  assert.equal(result.operationId, undefined);
  assert.equal(row(`SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'milestone.validate'`).count, 0);
  assert.equal(row(`SELECT COUNT(*) AS count FROM assessments WHERE scope = 'milestone-validation'`).count, 1);
  assert.match(readFileSync(result.validationPath, "utf8"), /verdict: pass/);
});

test("historical validation replay cannot replace the current compatibility projection", async () => {
  const basePath = makeBase();
  const firstKey = "milestone-validate/public/historical-first";
  const first = await validate(basePath, firstKey);
  assert.ok(!("error" in first));
  const second = await validate(basePath, "milestone-validate/public/historical-second", {
    verdict: "needs-attention",
    verdictRationale: "The current validation needs more objective evidence.",
  });
  assert.ok(!("error" in second));
  const currentProjection = readFileSync(second.validationPath, "utf8");
  const currentAssessment = row(`
    SELECT status, full_content, created_at FROM assessments
    WHERE scope = 'milestone-validation'
  `);

  const replay = await validate(basePath, firstKey);

  assert.ok(!("error" in replay));
  assert.equal(replay.duplicate, true);
  assert.equal(replay.current, false);
  assert.equal(replay.superseded, true);
  assert.equal(replay.stale, true);
  assert.equal(readFileSync(second.validationPath, "utf8"), currentProjection);
  assert.deepEqual(row(`
    SELECT status, full_content, created_at FROM assessments
    WHERE scope = 'milestone-validation'
  `), currentAssessment);
});

test("Milestone validation binds current user acceptance and is immediately closeout-ready", async () => {
  const basePath = makeBase();
  const prepared = prepareMilestoneSubjectiveUat({
    invocation: invocation("milestone-validate/subjective/prepare"),
    milestoneId: "M001",
    criterionKey: "guided-flow",
    description: "The guided flow feels natural and clear.",
    focusedPrompt: "Does the guided flow feel natural and clear?",
    recommendedDisposition: "accepted",
    recommendationRationale: "Automated checks passed and the guided path is complete.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision: sourceRevision(basePath),
  });
  const accepted = prepared.options.find((option) => option.disposition === "accepted");
  assert.ok(accepted);
  const answer = answerMilestoneSubjectiveUat({
    invocation: {
      ...invocation("milestone-validate/subjective/answer"),
      actorType: "user",
      actorId: "developer",
    },
    criterionId: prepared.criterionId,
    questionId: prepared.questionId,
    interactionId: prepared.interactionId,
    selectedOptionId: accepted.optionId,
    verbatimResponse: accepted.label,
    rationale: "The user explicitly accepted the guided experience.",
    testedSourceRevision: sourceRevision(basePath),
  });

  const result = await validate(basePath, "milestone-validate/public/subjective");

  assert.ok(!("error" in result), "validation should include the current user acceptance");
  const payload = JSON.parse(String(row(`
    SELECT payload_json FROM workflow_domain_events
    WHERE event_type = 'milestone.validation.recorded'
    ORDER BY project_revision DESC LIMIT 1
  `).payload_json)) as Record<string, unknown>;
  assert.deepEqual(payload["humanAcceptanceIds"], [answer.humanAcceptanceId]);
  assert.ok((payload["criterionIds"] as string[]).includes(prepared.criterionId));
  assert.deepEqual(readMilestoneCloseoutReadiness({ milestoneId: "M001" }), {
    ready: true,
    validationEventId: result.operationId ? String(row(`
      SELECT event_id FROM workflow_domain_events
      WHERE operation_id = '${result.operationId}'
        AND event_type = 'milestone.validation.recorded'
    `).event_id) : "",
    validationRevision: result.resultingRevision,
  });
});

test("Milestone validation rejects an older acceptance while a newer UAT question is open", async () => {
  const basePath = makeBase();
  const testedSourceRevision = sourceRevision(basePath);
  const first = prepareMilestoneSubjectiveUat({
    invocation: invocation("milestone-validate/subjective/open/prepare-1"),
    milestoneId: "M001",
    criterionKey: "guided-flow",
    description: "The guided flow feels natural and clear.",
    focusedPrompt: "Does the guided flow feel natural and clear?",
    recommendedDisposition: "accepted",
    recommendationRationale: "Automated checks passed.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision,
  });
  const accepted = first.options.find((option) => option.disposition === "accepted")!;
  answerMilestoneSubjectiveUat({
    invocation: {
      ...invocation("milestone-validate/subjective/open/answer-1"),
      actorType: "user",
      actorId: "developer",
    },
    criterionId: first.criterionId,
    questionId: first.questionId,
    interactionId: first.interactionId,
    selectedOptionId: accepted.optionId,
    verbatimResponse: accepted.label,
    rationale: "The user accepted the first review.",
    testedSourceRevision,
  });
  prepareMilestoneSubjectiveUat({
    invocation: invocation("milestone-validate/subjective/open/prepare-2"),
    milestoneId: "M001",
    criterionKey: "guided-flow",
    description: "The guided flow feels natural and clear.",
    focusedPrompt: "Does the guided flow still feel natural and clear?",
    recommendedDisposition: "accepted",
    recommendationRationale: "A fresh review is required.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision,
  });

  await assert.rejects(
    () => validate(basePath, "milestone-validate/public/open-subjective"),
    /accepted subjective UAT criterion/i,
  );
});

test("Milestone validation rejects subjective acceptance from an older source", async () => {
  const basePath = makeBase();
  const testedSourceRevision = sourceRevision(basePath);
  const prepared = prepareMilestoneSubjectiveUat({
    invocation: invocation("milestone-validate/subjective/source/prepare"),
    milestoneId: "M001",
    criterionKey: "guided-flow",
    description: "The guided flow feels natural and clear.",
    focusedPrompt: "Does the guided flow feel natural and clear?",
    recommendedDisposition: "accepted",
    recommendationRationale: "Automated checks passed.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision,
  });
  const accepted = prepared.options.find((option) => option.disposition === "accepted")!;
  answerMilestoneSubjectiveUat({
    invocation: {
      ...invocation("milestone-validate/subjective/source/answer"),
      actorType: "user",
      actorId: "developer",
    },
    criterionId: prepared.criterionId,
    questionId: prepared.questionId,
    interactionId: prepared.interactionId,
    selectedOptionId: accepted.optionId,
    verbatimResponse: accepted.label,
    rationale: "The user accepted the reviewed source.",
    testedSourceRevision,
  });
  writeFileSync(join(basePath, "source.ts"), "export const source = 'changed before validation';\n");

  await assert.rejects(
    () => validate(basePath, "milestone-validate/public/stale-subjective"),
    /accepted subjective UAT criterion/i,
  );
});

test("Milestone validation rejects changed facts under the same execution identity", async () => {
  const basePath = makeBase();
  const key = "milestone-validate/public/conflict";
  await validate(basePath, key);

  await assert.rejects(
    () => validate(basePath, key, {
      verdict: "needs-attention",
      verdictRationale: "Conflicting facts under the same key.",
    }),
    /idempotency conflict/i,
  );
});

test("Milestone validation repairs evidence-backed legacy descendant authority before closeout", async () => {
  const basePath = makeBase("", true, false);
  executeAtFence("test.task.fixture", "fixture/task/adopt-ready", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
  });
  const completedAt = "2026-01-02T03:04:05.000Z";
  const adapter = _getAdapter();
  assert.ok(adapter);
  adapter.prepare(`
    UPDATE slices
    SET completed_at = :completed_at, full_summary_md = :summary
    WHERE milestone_id = 'M001' AND id = 'S01'
  `).run({
    ":completed_at": completedAt,
    ":summary": "# S01 Summary\n\nVerified legacy Slice completion.\n",
  });
  adapter.prepare(`
    UPDATE tasks
    SET completed_at = :completed_at,
        verification_result = 'passed',
        full_summary_md = :summary
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run({
    ":completed_at": completedAt,
    ":summary": "# T01 Summary\n\nVerified legacy Task completion.\n",
  });

  const validated = await validate(basePath, "milestone-validate/public/shadow-repair");
  assert.ok(!("error" in validated), "validation should repair durable legacy authority");
  assert.deepEqual(adapter.prepare(`
    SELECT item_kind, lifecycle_status
    FROM workflow_item_lifecycles
    WHERE milestone_id = 'M001' AND item_kind IN ('task', 'slice')
    ORDER BY item_kind
  `).all(), [
    { item_kind: "slice", lifecycle_status: "completed" },
    { item_kind: "task", lifecycle_status: "completed" },
  ]);
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count
    FROM workflow_operations
    WHERE operation_type = 'lifecycle.shadow.repair'
  `).count), 3);

  const completed = await complete(basePath);
  assert.ok(!("error" in completed), "the post-repair validation receipt should authorize closeout");
  assert.equal(completed.milestoneId, "M001");
  assert.equal(row("SELECT status FROM milestones WHERE id = 'M001'").status, "complete");
});

test("Milestone validation refuses legacy descendant repair without durable evidence", async () => {
  const basePath = makeBase("", true, false);

  const result = await validate(basePath, "milestone-validate/public/shadow-unresolved");

  assert.ok("error" in result, "unsupported legacy authority must block validation");
  assert.match(result.error, /unresolved canonical lifecycle shadows/i);
  assert.match(result.error, /M001\/S01\/T01/);
  assert.match(result.error, /M001\/S01/);
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count
    FROM workflow_operations
    WHERE operation_type IN ('lifecycle.shadow.repair', 'milestone.validate')
  `).count), 0);
});

test("Milestone completion rejects a file-only passing validation", async () => {
  const basePath = makeBase();
  writeFileSync(
    join(basePath, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    "---\nverdict: pass\n---\n# File-only validation\n",
  );

  const result = await complete(basePath);

  assert.ok("error" in result, "a projection must not authorize completion");
  assert.match(result.error, /validation|database|evidence/i);
});

test("adopted Milestone completion fails closed without canonical invocation identity", async () => {
  const basePath = makeBase();
  const result = await handleCompleteMilestone({
    milestoneId: "M001",
    title: "Milestone validation",
    oneLiner: "Validated closeout",
    narrative: "The Milestone is ready to close.",
    verificationPassed: true,
  }, basePath);

  assert.ok("error" in result);
  assert.match(result.error, /canonical invocation identity/i);
});

test("Milestone completion rejects passing validation made stale by a descendant lifecycle change", async () => {
  const basePath = makeBase();
  const validated = await validate(basePath, "milestone-validate/public/stale");
  assert.ok(!("error" in validated), "validation fixture should commit");
  executeAtFence("task.reopen", "fixture/task/newer-revision", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
  });

  const result = await complete(basePath);

  assert.ok("error" in result, "stale validation must not authorize completion");
  assert.match(result.error, /stale|revision|current|source/i);
});

test("Milestone completion rejects passing validation after source changes", async () => {
  const basePath = makeBase();
  const validated = await validate(basePath, "milestone-validate/public/source-stale");
  assert.ok(!("error" in validated), "validation fixture should commit");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'changed after validation';\n");

  const result = await complete(basePath);

  assert.ok("error" in result, "validation for an older source must not authorize completion");
  assert.match(result.error, /source|revision|current|stale/i);
});

test("Milestone completion rejects newer failed DB evidence despite a passing validation file", async () => {
  const basePath = makeBase();
  const passing = await validate(basePath, "milestone-validate/public/pass-before-failure");
  assert.ok(!("error" in passing), "passing validation fixture should commit");
  const failed = await validate(basePath, "milestone-validate/public/newer-failure", {
    verdict: "needs-attention",
    verdictRationale: "The latest database evidence does not pass.",
  });
  assert.ok(!("error" in failed), "newer failed validation fixture should commit");
  writeFileSync(
    join(basePath, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    "---\nverdict: pass\n---\n# Stale passing projection\n",
  );

  const result = await complete(basePath);

  assert.ok("error" in result, "newer failed database evidence must block completion");
  assert.match(result.error, /needs-attention|validation|evidence/i);
});

test("planned UAT cannot pass from prose without a current database UAT fact", async () => {
  const basePath = makeBase("Run the browser acceptance journey.");

  const result = await validate(basePath, "milestone-validate/public/missing-uat", {
    verificationClasses:
      "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | Not run | PASS |",
  });

  assert.ok("error" in result, "required UAT must be backed by current database evidence");
  assert.match(result.error, /UAT|evidence|database|current/i);
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'milestone.validate'
  `).count, 0, "rejected UAT must leave no validation operation");
});

test("adopted validation rejects file-only browser evidence inferred from Slice requirements", async () => {
  const basePath = makeBase();
  db().prepare(`
    UPDATE slices
    SET demo = 'Open the browser and verify the guided journey.'
    WHERE id = 'S01'
  `).run();
  const assessmentPath = join(
    basePath,
    ".gsd",
    "milestones",
    "M001",
    "slices",
    "S01",
    "S01-ASSESSMENT.md",
  );
  mkdirSync(dirname(assessmentPath), { recursive: true });
  writeFileSync(
    assessmentPath,
    "# Assessment\n\nBrowser journey clicked through successfully with assertions.\n",
  );

  const result = await validate(basePath, "milestone-validate/public/file-browser", {
    verificationClasses:
      "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | persisted assessment | PASS |",
  });

  assert.ok("error" in result, "file-only browser prose must not authorize canonical validation");
  assert.match(result.error, /UAT|structured|database|evidence/i);
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'milestone.validate'
  `).count, 0);
});

test("planned UAT passes only with source-bound structured browser evidence", async () => {
  const basePath = makeBase("Run the browser acceptance journey.");
  const params = {
    ...validValidation,
    verificationClasses:
      "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | Browser journey | PASS |",
    verificationEvidence: [{
      verificationClass: "UAT",
      evidenceClass: "browser",
      commandOrTool: "browser acceptance journey",
      workingDirectory: basePath,
      startedAt: "2026-07-14T10:00:00.000Z",
      endedAt: "2026-07-14T10:01:00.000Z",
      testedSourceRevision: sourceRevision(basePath),
      observation: "passed",
      durableOutputRef: "artifact://browser/acceptance-journey",
      environment: { runner: "browser", route: "/acceptance" },
      rationale: "The user-visible acceptance journey passed.",
    }],
  } as ValidateMilestoneParams & {
    verificationEvidence: Array<Record<string, unknown>>;
  };

  const result = await handleValidateMilestone(
    params,
    basePath,
    { invocation: invocation("milestone-validate/public/structured-uat") },
  );

  assert.ok(!("error" in result), `unexpected validation error: ${"error" in result ? result.error : ""}`);
  assert.equal(result.verdict, "pass", "current structured browser evidence must satisfy the browser gate");
  assert.equal(JSON.parse(String(row(`
    SELECT payload_json FROM workflow_domain_events
    WHERE event_type = 'milestone.validation.recorded'
  `).payload_json)).overallVerdict, "pass");
  assert.deepEqual(db().prepare(`
    SELECT criterion.criterion_key, criterion.evidence_class, verdict.verdict, evidence.observation
    FROM workflow_acceptance_criteria criterion
    JOIN workflow_technical_verdicts verdict ON verdict.criterion_id = criterion.criterion_id
    JOIN workflow_verification_evidence evidence ON evidence.verdict_id = verdict.verdict_id
    WHERE criterion.criterion_key = 'milestone-validation:uat'
  `).get(), {
    criterion_key: "milestone-validation:uat",
    evidence_class: "browser",
    verdict: "pass",
    observation: "passed",
  });
});

test("browser-required Slice rejects unscoped UAT evidence", async () => {
  const basePath = makeBase();
  db().prepare(`UPDATE slices SET demo = 'Open the browser and verify the guided journey.' WHERE id = 'S01'`).run();
  const evidence = {
    verificationClass: "UAT" as const,
    evidenceClass: "browser" as const,
    commandOrTool: "browser acceptance journey",
    workingDirectory: basePath,
    startedAt: "2026-07-14T10:00:00.000Z",
    endedAt: "2026-07-14T10:01:00.000Z",
    testedSourceRevision: sourceRevision(basePath),
    observation: "passed" as const,
    durableOutputRef: "artifact://browser/acceptance-journey",
    environment: { runner: "browser", route: "/acceptance" },
    rationale: "The user-visible acceptance journey passed.",
  };
  const verificationClasses =
    "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | Browser journey | PASS |";

  const unbound = await handleValidateMilestone({
    ...validValidation,
    verificationClasses,
    verificationEvidence: [evidence],
  }, basePath, { invocation: invocation("milestone-validate/public/unbound-browser") });
  assert.ok("error" in unbound);
  assert.match(unbound.error, /UAT|browser|required Slice|bound/i);
});

test("browser-required Slice accepts source-bound UAT evidence scoped to that Slice", async () => {
  const boundBasePath = makeBase();
  db().prepare(`UPDATE slices SET demo = 'Open the browser and verify the guided journey.' WHERE id = 'S01'`).run();
  const evidence = {
    verificationClass: "UAT" as const,
    evidenceClass: "browser" as const,
    commandOrTool: "browser acceptance journey",
    workingDirectory: boundBasePath,
    startedAt: "2026-07-14T10:00:00.000Z",
    endedAt: "2026-07-14T10:01:00.000Z",
    testedSourceRevision: sourceRevision(boundBasePath),
    observation: "passed" as const,
    durableOutputRef: "artifact://browser/acceptance-journey",
    environment: { runner: "browser", route: "/acceptance" },
    rationale: "The user-visible acceptance journey passed.",
    sliceId: "S01",
  };
  const bound = await handleValidateMilestone({
    ...validValidation,
    verificationClasses:
      "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | Browser journey | PASS |",
    verificationEvidence: [evidence],
  }, boundBasePath, { invocation: invocation("milestone-validate/public/bound-browser") });
  assert.ok(!("error" in bound));
  assert.equal(bound.verdict, "pass");
});

test("planned UAT rejects structured evidence from an older source revision", async () => {
  const basePath = makeBase("Run the browser acceptance journey.");

  const result = await handleValidateMilestone({
    ...validValidation,
    verificationClasses:
      "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | Browser journey | PASS |",
    verificationEvidence: [{
      verificationClass: "UAT",
      evidenceClass: "browser",
      commandOrTool: "browser acceptance journey",
      workingDirectory: basePath,
      startedAt: "2026-07-14T10:00:00.000Z",
      endedAt: "2026-07-14T10:01:00.000Z",
      testedSourceRevision: "sha256:stale-source",
      observation: "passed",
      durableOutputRef: "artifact://browser/acceptance-journey",
      environment: { runner: "browser", route: "/acceptance" },
      rationale: "The user-visible acceptance journey passed.",
    }],
  }, basePath, validationOptions("milestone-validate/public/stale-structured-uat"));

  assert.ok("error" in result, "evidence from another source revision must fail closed");
  assert.match(result.error, /source|revision|current/i);
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'milestone.validate'
  `).count, 0, "stale evidence must not create a canonical validation receipt");
});

test("needs-attention records passing per-class verdicts without authorizing closeout", async () => {
  const basePath = makeBase("Run the browser acceptance journey.");
  db().prepare(`
    UPDATE milestones
    SET verification_contract = 'Contract tests pass.',
        verification_integration = 'Integration tests pass.',
        verification_operational = 'Cold build is clean.'
    WHERE id = 'M001'
  `).run();
  const testedSourceRevision = sourceRevision(basePath);
  const commandEvidence = (name: string, minute: string) => ({
    evidenceClass: "command" as const,
    commandOrTool: name,
    workingDirectory: basePath,
    startedAt: `2026-07-14T10:0${minute}:00.000Z`,
    endedAt: `2026-07-14T10:0${minute}:30.000Z`,
    exitCode: 0,
    testedSourceRevision,
    observation: "passed" as const,
    durableOutputRef: `artifact://${name}`,
    environment: { runner: "node" },
    rationale: `${name} is green.`,
  });

  const result = await handleValidateMilestone({
    ...validValidation,
    verdict: "needs-attention",
    remediationRound: 1,
    verificationClasses:
      "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| Contract | unit | PASS |" +
      "\n| Integration | integration | PASS |\n| Operational | build | PASS |\n| UAT | browser | PASS |",
    verdictRationale: "Every planned class passed; follow-ups outside those classes remain.",
    verificationEvidence: [
      { verificationClass: "Contract", ...commandEvidence("contract", "0") },
      { verificationClass: "Integration", ...commandEvidence("integration", "2") },
      { verificationClass: "Operational", ...commandEvidence("operational", "4") },
      {
        verificationClass: "UAT",
        evidenceClass: "browser",
        commandOrTool: "browser acceptance journey",
        workingDirectory: basePath,
        startedAt: "2026-07-14T10:06:00.000Z",
        endedAt: "2026-07-14T10:07:00.000Z",
        testedSourceRevision,
        observation: "passed",
        durableOutputRef: "artifact://browser/acceptance-journey",
        environment: { runner: "browser", route: "/acceptance" },
        rationale: "The user-visible acceptance journey passed.",
      },
    ],
  } as ValidateMilestoneParams, basePath, validationOptions("milestone-validate/public/needs-attention-classes"));

  assert.ok(
    !("error" in result),
    `a non-passing Milestone verdict must still record passing class evidence: ${"error" in result ? result.error : ""}`,
  );
  assert.deepEqual(db().prepare(`
    SELECT criterion.criterion_key, verdict.verdict
    FROM workflow_technical_verdicts verdict
    JOIN workflow_acceptance_criteria criterion
      ON criterion.criterion_id = verdict.criterion_id
    ORDER BY criterion.criterion_key
  `).all(), [
    { criterion_key: "milestone-validation:aggregate", verdict: "inconclusive" },
    { criterion_key: "milestone-validation:contract", verdict: "pass" },
    { criterion_key: "milestone-validation:integration", verdict: "pass" },
    { criterion_key: "milestone-validation:operational", verdict: "pass" },
    { criterion_key: "milestone-validation:uat", verdict: "pass" },
  ]);
  assert.equal(row(`
    SELECT settle_outcome FROM workflow_execution_attempts
  `).settle_outcome, "interrupted");
  assert.equal(
    readMilestoneCloseoutReadiness({ milestoneId: "M001" }).ready,
    false,
    "the inconclusive aggregate criterion must still block closeout",
  );
});

test("Milestone validation passes once stranded subjective criteria are retired", async () => {
  const basePath = makeBase();
  const revision = sourceRevision(basePath);

  // Reproduces M003's actual shape: a survivor criterion accepted through the
  // real prepare/answer path, plus two required chains that predate Task 1's
  // stranding guard. Those two are injected directly rather than prepared
  // through the public API, because the guard now refuses to let a second
  // unanswered required chain arise that way — which is exactly why M003's
  // legacy rows could only have been produced before the guard existed, and
  // why recovering from them needs the retirement path under test here.
  const survivor = prepareMilestoneSubjectiveUat({
    invocation: invocation("m003/prepare/single-pr"),
    milestoneId: "M001",
    criterionKey: "developer-single-pr-domain-change",
    description: "A domain change is one PR.",
    focusedPrompt: "Is a domain change now a single PR?",
    recommendedDisposition: "accepted",
    recommendationRationale: "The domain model moved in-repo.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision: revision,
  });
  const survivorAccept = survivor.options.find((option) => option.disposition === "accepted")!;
  const survivorAnswer = answerMilestoneSubjectiveUat({
    invocation: {
      ...invocation("m003/answer/single-pr"),
      actorType: "user",
      actorId: "developer",
    },
    criterionId: survivor.criterionId,
    questionId: survivor.questionId,
    interactionId: survivor.interactionId,
    selectedOptionId: survivorAccept.optionId,
    verbatimResponse: survivorAccept.label,
    rationale: "The user accepted the single-PR domain change criterion.",
    testedSourceRevision: revision,
  });

  const chainB = injectStrandedSubjectiveUatChain({
    lifecycleId: survivor.lifecycleId,
    criterionKey: "developer-owns-domain-types-in-repo",
    description: "The developer owns the domain types in this repo.",
    focusedPrompt: "Does this service own its domain types in-repo?",
  });
  const chainC = injectStrandedSubjectiveUatChain({
    lifecycleId: survivor.lifecycleId,
    criterionKey: "m003-developer-owns-domain-types-single-pr",
    description: "A domain change touching owned types stays one PR.",
    focusedPrompt: "Does an owned-types domain change stay a single PR?",
  });

  await assert.rejects(
    () => validate(basePath, "m003/validate/blocked"),
    /requires an accepted subjective UAT criterion/i,
    "two unanswered required subjective criteria must block pass",
  );

  function retireChain(criterionId: string, label: string) {
    const retirement = prepareMilestoneSubjectiveUatRetirement({
      invocation: invocation(`m003/retire/prepare/${label}`),
      criterionId,
      rationale: "Stranded duplicate predating the stranding guard.",
    });
    return retireMilestoneSubjectiveUat({
      invocation: {
        ...invocation(`m003/retire/answer/${label}`),
        actorType: "user",
        actorId: "developer",
      },
      criterionId,
      questionId: retirement.questionId,
      interactionId: retirement.interactionId,
      selectedOptionId: retirement.retireOptionId,
      verbatimResponse: retirement.options[0]!.label,
      rationale: "The user confirmed this criterion is a stranded duplicate.",
    });
  }

  const retiredB = retireChain(chainB.criterionId, "owns-domain-types");
  const retiredC = retireChain(chainC.criterionId, "single-pr-owned-types");

  assert.equal(retiredB.choice, "retire");
  assert.equal(retiredC.choice, "retire");
  assert.deepEqual(
    retiredB.withdrawnQuestionIds,
    [chainB.questionId],
    "retiring chain B must not withdraw chain C's question",
  );
  assert.deepEqual(
    retiredC.withdrawnQuestionIds,
    [chainC.questionId],
    "retiring chain C must not withdraw chain B's question",
  );
  assert.equal(hasPendingMilestoneSubjectiveUat("M001"), false);

  const passed = await validate(basePath, "m003/validate/passed");
  assert.ok(!("error" in passed), "retiring both stranded criteria must unblock pass");
  const payload = JSON.parse(String(row(`
    SELECT payload_json FROM workflow_domain_events
    WHERE event_type = 'milestone.validation.recorded'
    ORDER BY project_revision DESC LIMIT 1
  `).payload_json)) as Record<string, unknown>;
  assert.deepEqual(payload["humanAcceptanceIds"], [survivorAnswer.humanAcceptanceId]);
  const criterionIds = payload["criterionIds"] as string[];
  assert.ok(criterionIds.includes(survivor.criterionId), "the surviving criterion must be bound");
  assert.ok(!criterionIds.includes(chainB.criterionId), "chain B must not be bound into the receipt");
  assert.ok(!criterionIds.includes(chainC.criterionId), "chain C must not be bound into the receipt");
});

// The bare-UUID form of this error cost eight validate-milestone sessions and
// five duplicate criterion rows (issue #242): every fact the agent needed was
// already on the row the query reads.
test("Milestone validation blocker names the criterion and its resolution path", async () => {
  const basePath = makeBase();
  const revision = sourceRevision(basePath);
  const blocking = prepareMilestoneSubjectiveUat({
    invocation: invocation("blocker/prepare"),
    milestoneId: "M001",
    criterionKey: "developer-owns-domain-types-in-repo",
    description: "This service owns its domain types in-repo.",
    focusedPrompt: "Does this service own its domain types in-repo?",
    recommendedDisposition: "accepted",
    recommendationRationale: "The domain model moved in-repo.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision: revision,
  });

  await assert.rejects(
    () => validate(basePath, "blocker/validate"),
    (error: Error) => {
      assert.match(error.message, new RegExp(blocking.criterionId));
      assert.match(error.message, /developer-owns-domain-types-in-repo/);
      assert.match(error.message, /Does this service own its domain types in-repo\?/);
      assert.match(error.message, /gsd_prepare_milestone_subjective_uat\b/);
      assert.match(error.message, /gsd_prepare_milestone_subjective_uat_retirement\b/);
      return true;
    },
  );
});

// A rejected answer closes the question but leaves the criterion required and
// unaccepted, so the blocker must still describe it from the criterion row.
test("Milestone validation blocker falls back to the criterion description with no open question", async () => {
  const basePath = makeBase();
  const revision = sourceRevision(basePath);
  const blocking = prepareMilestoneSubjectiveUat({
    invocation: invocation("rejected/prepare"),
    milestoneId: "M001",
    criterionKey: "guided-flow",
    description: "The guided flow feels natural and clear.",
    focusedPrompt: "Does the guided flow feel natural and clear?",
    recommendedDisposition: "accepted",
    recommendationRationale: "Automated checks passed.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision: revision,
  });
  const reject = blocking.options.find((option) => option.disposition === "rejected")!;
  answerMilestoneSubjectiveUat({
    invocation: { ...invocation("rejected/answer"), actorType: "user", actorId: "developer" },
    criterionId: blocking.criterionId,
    questionId: blocking.questionId,
    interactionId: blocking.interactionId,
    selectedOptionId: reject.optionId,
    verbatimResponse: reject.label,
    rationale: "The guided flow still reads as clunky.",
    testedSourceRevision: revision,
  });

  await assert.rejects(
    () => validate(basePath, "rejected/validate"),
    (error: Error) => {
      assert.match(error.message, /guided-flow/);
      assert.match(error.message, /The guided flow feels natural and clear\./);
      return true;
    },
  );
});

test("Milestone closeout readiness ignores a retired subjective criterion", async () => {
  const basePath = makeBase();
  const revision = sourceRevision(basePath);
  const stranded = prepareMilestoneSubjectiveUat({
    invocation: invocation("closeout/prepare"),
    milestoneId: "M001",
    criterionKey: "guided-flow",
    description: "The guided flow feels natural and clear.",
    focusedPrompt: "Does the guided flow feel natural and clear?",
    recommendedDisposition: "accepted",
    recommendationRationale: "Automated checks passed.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision: revision,
  });
  const retirement = prepareMilestoneSubjectiveUatRetirement({
    invocation: invocation("closeout/retire/prepare"),
    criterionId: stranded.criterionId,
    rationale: "Stranded duplicate.",
  });
  retireMilestoneSubjectiveUat({
    invocation: {
      ...invocation("closeout/retire/answer"),
      actorType: "user",
      actorId: "developer",
    },
    criterionId: stranded.criterionId,
    questionId: retirement.questionId,
    interactionId: retirement.interactionId,
    selectedOptionId: retirement.retireOptionId,
    verbatimResponse: retirement.options[0]!.label,
    rationale: "The user confirmed this criterion is a stranded duplicate.",
  });

  const result = await validate(basePath, "closeout/validate");

  assert.ok(!("error" in result));
  assert.equal(readMilestoneCloseoutReadiness({ milestoneId: "M001" }).ready, true);
});
