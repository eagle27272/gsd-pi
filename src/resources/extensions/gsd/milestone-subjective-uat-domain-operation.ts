// Project/App: gsd-pi
// File Purpose: Durable Milestone subjective-UAT question and answer operations.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import {
  answerMilestoneSubjectiveUatQuestion,
  prepareMilestoneSubjectiveUatQuestion,
  prepareMilestoneSubjectiveUatRetirementQuestion,
  retireMilestoneSubjectiveUatCriterion,
  type AnsweredMilestoneSubjectiveUat,
  type PreparedMilestoneSubjectiveUat,
  type PreparedSubjectiveUatRetirement,
  type RetiredMilestoneSubjectiveUat,
  type SubjectiveUatRetirementOption,
} from "./db/writers/milestone-subjective-uat.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

export interface PrepareMilestoneSubjectiveUatInput {
  invocation: ExecutionInvocation;
  milestoneId: string;
  criterionKey: string;
  description: string;
  focusedPrompt: string;
  recommendedDisposition: "accepted" | "rejected";
  recommendationRationale: string;
  recommendationEvidence: string;
  testedSourceRevision: string;
  recommendationConfidence?: number;
  requirementId?: string;
  required?: boolean;
}

export interface AnswerMilestoneSubjectiveUatInput {
  invocation: ExecutionInvocation;
  criterionId: string;
  questionId: string;
  interactionId: string;
  selectedOptionId: string;
  verbatimResponse: string;
  rationale: string;
  testedSourceRevision: string;
}

interface OperationReceipt {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
}

export interface PrepareMilestoneSubjectiveUatReceipt
  extends OperationReceipt, PreparedMilestoneSubjectiveUat {}

export interface AnswerMilestoneSubjectiveUatReceipt
  extends OperationReceipt, AnsweredMilestoneSubjectiveUat {}

export function hasPendingMilestoneSubjectiveUat(milestoneId: string): boolean {
  const row = getDb().prepare(`
    SELECT 1
    FROM workflow_open_questions question
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = question.lifecycle_id
     AND lifecycle.project_id = question.project_id
    JOIN workflow_interactions interaction
      ON interaction.question_id = question.question_id
     AND interaction.project_id = question.project_id
     AND interaction.interaction_kind = 'subjective-uat'
    WHERE lifecycle.item_kind = 'milestone'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id IS NULL
      AND lifecycle.task_id IS NULL
      AND question.question_status = 'open'
    LIMIT 1
  `).get({ ":milestone_id": milestoneId });
  return row !== undefined;
}

function requireNonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be blank`);
  return normalized;
}

function operationReceipt(operation: DomainOperationResult): OperationReceipt {
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
  };
}

function storedPayload(operationId: string, eventType: string): Record<string, unknown> {
  const row = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = :event_type
  `).get({
    ":operation_id": operationId,
    ":event_type": eventType,
  }) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Subjective UAT receipt is missing ${eventType}`);
  const payload = JSON.parse(String(row["payload_json"])) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Subjective UAT receipt ${eventType} payload is invalid`);
  }
  return payload as Record<string, unknown>;
}

function receiptString(
  payload: Record<string, unknown>,
  field: string,
  eventType: string,
): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Subjective UAT receipt ${eventType} ${field} is invalid`);
  }
  return value;
}

function receiptStringArray(
  payload: Record<string, unknown>,
  field: string,
  eventType: string,
): string[] {
  const value = payload[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`Subjective UAT receipt ${eventType} ${field} is invalid`);
  }
  return value;
}

function storedPreparation(operationId: string): PreparedMilestoneSubjectiveUat {
  const eventType = "milestone.subjective-uat.prepared";
  const payload = storedPayload(operationId, eventType);
  const options = payload["options"];
  if (!Array.isArray(options) || options.length !== 2 || options.some((option) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) return true;
    const entry = option as Record<string, unknown>;
    return typeof entry["optionId"] !== "string" || !entry["optionId"] ||
      (entry["disposition"] !== "accepted" && entry["disposition"] !== "rejected") ||
      typeof entry["label"] !== "string" || !entry["label"] ||
      typeof entry["description"] !== "string" || !entry["description"] ||
      typeof entry["recommended"] !== "boolean";
  })) {
    throw new Error(`Subjective UAT receipt ${eventType} options is invalid`);
  }
  const preparedOptions = options as PreparedMilestoneSubjectiveUat["options"];
  const acceptedOptionId = receiptString(payload, "acceptedOptionId", eventType);
  const rejectedOptionId = receiptString(payload, "rejectedOptionId", eventType);
  const optionIds = new Set(preparedOptions.map((option) => option.optionId));
  const acceptedOptions = preparedOptions.filter((option) => option.disposition === "accepted");
  const rejectedOptions = preparedOptions.filter((option) => option.disposition === "rejected");
  if (optionIds.size !== preparedOptions.length || acceptedOptions.length !== 1 ||
      rejectedOptions.length !== 1 || acceptedOptions[0]!.optionId !== acceptedOptionId ||
      rejectedOptions[0]!.optionId !== rejectedOptionId ||
      preparedOptions.filter((option) => option.recommended).length !== 1) {
    throw new Error(`Subjective UAT receipt ${eventType} options is invalid`);
  }
  return {
    milestoneId: receiptString(payload, "milestoneId", eventType),
    lifecycleId: receiptString(payload, "lifecycleId", eventType),
    criterionId: receiptString(payload, "criterionId", eventType),
    questionId: receiptString(payload, "questionId", eventType),
    interactionId: receiptString(payload, "interactionId", eventType),
    acceptedOptionId,
    rejectedOptionId,
    testedSourceRevision: receiptString(payload, "testedSourceRevision", eventType),
    withdrawnQuestionIds: receiptStringArray(payload, "withdrawnQuestionIds", eventType),
    options: preparedOptions,
  };
}

function storedAnswer(operationId: string): AnsweredMilestoneSubjectiveUat {
  const eventType = "milestone.subjective-uat.answered";
  const payload = storedPayload(operationId, eventType);
  const disposition = payload["disposition"];
  if (disposition !== "accepted" && disposition !== "rejected") {
    throw new Error(`Subjective UAT receipt ${eventType} disposition is invalid`);
  }
  const supersedes = payload["supersedesHumanAcceptanceId"];
  if (supersedes !== null && (typeof supersedes !== "string" || !supersedes)) {
    throw new Error(`Subjective UAT receipt ${eventType} supersedesHumanAcceptanceId is invalid`);
  }
  return {
    milestoneId: receiptString(payload, "milestoneId", eventType),
    lifecycleId: receiptString(payload, "lifecycleId", eventType),
    criterionId: receiptString(payload, "criterionId", eventType),
    questionId: receiptString(payload, "questionId", eventType),
    interactionId: receiptString(payload, "interactionId", eventType),
    answerId: receiptString(payload, "answerId", eventType),
    humanAcceptanceId: receiptString(payload, "humanAcceptanceId", eventType),
    disposition,
    testedSourceRevision: receiptString(payload, "testedSourceRevision", eventType),
    supersedesHumanAcceptanceId: supersedes,
  };
}

export function prepareMilestoneSubjectiveUat(
  input: PrepareMilestoneSubjectiveUatInput,
): PrepareMilestoneSubjectiveUatReceipt {
  const milestoneId = requireNonBlank(input.milestoneId, "milestoneId");
  const criterionKey = requireNonBlank(input.criterionKey, "criterionKey").toLowerCase();
  const description = requireNonBlank(input.description, "description");
  const focusedPrompt = requireNonBlank(input.focusedPrompt, "focusedPrompt");
  const recommendationRationale = requireNonBlank(
    input.recommendationRationale,
    "recommendationRationale",
  );
  const recommendationEvidence = requireNonBlank(
    input.recommendationEvidence,
    "recommendationEvidence",
  );
  const testedSourceRevision = requireNonBlank(
    input.testedSourceRevision,
    "testedSourceRevision",
  );
  const recommendationConfidence = input.recommendationConfidence ?? 0.5;
  if (recommendationConfidence < 0 || recommendationConfidence > 1) {
    throw new Error("recommendationConfidence must be between 0 and 1");
  }
  const requirementId = input.requirementId === undefined
    ? undefined
    : requireNonBlank(input.requirementId, "requirementId");
  const preparedInput = {
    milestoneId,
    criterionKey,
    description,
    focusedPrompt,
    recommendedDisposition: input.recommendedDisposition,
    recommendationRationale,
    recommendationEvidence,
    testedSourceRevision,
    recommendationConfidence,
    required: input.required ?? true,
    ...(requirementId ? { requirementId } : {}),
  };
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let prepared: PreparedMilestoneSubjectiveUat | undefined;
  const operation = executeDomainOperation({
    operationType: "milestone.subjective-uat.prepare",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: preparedInput,
  }, (context) => {
    prepared = prepareMilestoneSubjectiveUatQuestion(context, preparedInput);
    const eventPayload: DomainJsonValue = {
      milestoneId: prepared.milestoneId,
      lifecycleId: prepared.lifecycleId,
      criterionId: prepared.criterionId,
      questionId: prepared.questionId,
      interactionId: prepared.interactionId,
      acceptedOptionId: prepared.acceptedOptionId,
      rejectedOptionId: prepared.rejectedOptionId,
      testedSourceRevision: prepared.testedSourceRevision,
      withdrawnQuestionIds: prepared.withdrawnQuestionIds,
      options: prepared.options.map((option) => ({
        optionId: option.optionId,
        disposition: option.disposition,
        label: option.label,
        description: option.description,
        recommended: option.recommended,
      })),
    };
    return {
      events: [{
        eventType: "milestone.subjective-uat.prepared",
        entityType: "milestone",
        entityId: prepared.milestoneId,
        payload: eventPayload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `subjective-uat/${prepared.milestoneId}/${prepared.questionId}`.toLowerCase(),
        projectionKind: "milestone-subjective-uat",
        rendererVersion: "1",
      }],
    };
  });
  return { ...operationReceipt(operation), ...(prepared ?? storedPreparation(operation.operationId)) };
}

export function answerMilestoneSubjectiveUat(
  input: AnswerMilestoneSubjectiveUatInput,
): AnswerMilestoneSubjectiveUatReceipt {
  if (input.invocation.actorType !== "user" || !input.invocation.actorId?.trim()) {
    throw new Error("Subjective UAT acceptance requires a user actor identity");
  }
  const answerInput = {
    criterionId: requireNonBlank(input.criterionId, "criterionId"),
    questionId: requireNonBlank(input.questionId, "questionId"),
    interactionId: requireNonBlank(input.interactionId, "interactionId"),
    selectedOptionId: requireNonBlank(input.selectedOptionId, "selectedOptionId"),
    verbatimResponse: requireNonBlank(input.verbatimResponse, "verbatimResponse"),
    rationale: requireNonBlank(input.rationale, "rationale"),
    testedSourceRevision: requireNonBlank(
      input.testedSourceRevision,
      "testedSourceRevision",
    ),
    actorId: input.invocation.actorId.trim(),
  };
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let answered: AnsweredMilestoneSubjectiveUat | undefined;
  const operation = executeDomainOperation({
    operationType: "milestone.subjective-uat.answer",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "user",
    actorId: answerInput.actorId,
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: answerInput,
  }, (context) => {
    answered = answerMilestoneSubjectiveUatQuestion(context, answerInput);
    const eventPayload: DomainJsonValue = {
      milestoneId: answered.milestoneId,
      lifecycleId: answered.lifecycleId,
      criterionId: answered.criterionId,
      questionId: answered.questionId,
      interactionId: answered.interactionId,
      answerId: answered.answerId,
      humanAcceptanceId: answered.humanAcceptanceId,
      disposition: answered.disposition,
      testedSourceRevision: answered.testedSourceRevision,
      supersedesHumanAcceptanceId: answered.supersedesHumanAcceptanceId,
    };
    return {
      events: [{
        eventType: "milestone.subjective-uat.answered",
        entityType: "milestone",
        entityId: answered.milestoneId,
        payload: eventPayload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `subjective-uat/${answered.milestoneId}/${answered.questionId}`.toLowerCase(),
        projectionKind: "milestone-subjective-uat",
        rendererVersion: "1",
      }],
    };
  });
  return { ...operationReceipt(operation), ...(answered ?? storedAnswer(operation.operationId)) };
}

export interface PrepareMilestoneSubjectiveUatRetirementInput {
  invocation: ExecutionInvocation;
  criterionId: string;
  rationale: string;
}

export interface PrepareMilestoneSubjectiveUatRetirementReceipt
  extends OperationReceipt, PreparedSubjectiveUatRetirement {}

function storedRetirementPreparation(operationId: string): PreparedSubjectiveUatRetirement {
  const eventType = "milestone.subjective-uat.retirement-prepared";
  const payload = storedPayload(operationId, eventType);
  const options = payload["options"];
  if (!Array.isArray(options) || options.length !== 2) {
    throw new Error(`Subjective UAT receipt ${eventType} options are invalid`);
  }
  const parsedOptions = options.map((option): SubjectiveUatRetirementOption => {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      throw new Error(`Subjective UAT receipt ${eventType} options are invalid`);
    }
    const entry = option as Record<string, unknown>;
    const choice = entry["choice"];
    if (choice !== "retire" && choice !== "keep") {
      throw new Error(`Subjective UAT receipt ${eventType} options are invalid`);
    }
    if (
      typeof entry["optionId"] !== "string" || !entry["optionId"].trim() ||
      typeof entry["label"] !== "string" || !entry["label"].trim() ||
      typeof entry["description"] !== "string" || !entry["description"].trim() ||
      typeof entry["recommended"] !== "boolean"
    ) {
      throw new Error(`Subjective UAT receipt ${eventType} options are invalid`);
    }
    return {
      optionId: entry["optionId"],
      choice,
      label: entry["label"],
      description: entry["description"],
      recommended: entry["recommended"],
    };
  });
  return {
    milestoneId: receiptString(payload, "milestoneId", eventType),
    lifecycleId: receiptString(payload, "lifecycleId", eventType),
    criterionId: receiptString(payload, "criterionId", eventType),
    criterionKey: receiptString(payload, "criterionKey", eventType),
    questionId: receiptString(payload, "questionId", eventType),
    interactionId: receiptString(payload, "interactionId", eventType),
    retireOptionId: receiptString(payload, "retireOptionId", eventType),
    keepOptionId: receiptString(payload, "keepOptionId", eventType),
    withdrawnQuestionIds: receiptStringArray(payload, "withdrawnQuestionIds", eventType),
    options: parsedOptions,
  };
}

export function prepareMilestoneSubjectiveUatRetirement(
  input: PrepareMilestoneSubjectiveUatRetirementInput,
): PrepareMilestoneSubjectiveUatRetirementReceipt {
  const retirementInput = {
    criterionId: requireNonBlank(input.criterionId, "criterionId"),
    rationale: requireNonBlank(input.rationale, "rationale"),
  };
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let prepared: PreparedSubjectiveUatRetirement | undefined;
  const operation = executeDomainOperation({
    operationType: "milestone.subjective-uat.prepare-retirement",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: retirementInput,
  }, (context) => {
    prepared = prepareMilestoneSubjectiveUatRetirementQuestion(context, retirementInput);
    const eventPayload: DomainJsonValue = {
      milestoneId: prepared.milestoneId,
      lifecycleId: prepared.lifecycleId,
      criterionId: prepared.criterionId,
      criterionKey: prepared.criterionKey,
      questionId: prepared.questionId,
      interactionId: prepared.interactionId,
      retireOptionId: prepared.retireOptionId,
      keepOptionId: prepared.keepOptionId,
      withdrawnQuestionIds: prepared.withdrawnQuestionIds,
      options: prepared.options.map((option) => ({
        optionId: option.optionId,
        choice: option.choice,
        label: option.label,
        description: option.description,
        recommended: option.recommended,
      })),
    };
    return {
      events: [{
        eventType: "milestone.subjective-uat.retirement-prepared",
        entityType: "milestone",
        entityId: prepared.milestoneId,
        payload: eventPayload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `subjective-uat/${prepared.milestoneId}/${prepared.questionId}`.toLowerCase(),
        projectionKind: "milestone-subjective-uat",
        rendererVersion: "1",
      }],
    };
  });
  return {
    ...operationReceipt(operation),
    ...(prepared ?? storedRetirementPreparation(operation.operationId)),
  };
}

export interface RetireMilestoneSubjectiveUatInput {
  invocation: ExecutionInvocation;
  criterionId: string;
  questionId: string;
  interactionId: string;
  selectedOptionId: string;
  verbatimResponse: string;
  rationale: string;
}

interface RetireMilestoneSubjectiveUatReceipt
  extends OperationReceipt, RetiredMilestoneSubjectiveUat {}

function storedRetirement(operationId: string): RetiredMilestoneSubjectiveUat {
  const retiredType = "milestone.subjective-uat.retired";
  const declinedType = "milestone.subjective-uat.retirement-declined";
  const row = getDb().prepare(`
    SELECT event_type FROM workflow_domain_events
    WHERE operation_id = :operation_id
      AND event_type IN (:retired_type, :declined_type)
  `).get({
    ":operation_id": operationId,
    ":retired_type": retiredType,
    ":declined_type": declinedType,
  }) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Subjective UAT receipt is missing ${retiredType} or ${declinedType}`);
  const eventType = String(row["event_type"]);
  const payload = storedPayload(operationId, eventType);
  const retiredCriterionId = payload["retiredCriterionId"];
  if (retiredCriterionId !== null && typeof retiredCriterionId !== "string") {
    throw new Error(`Subjective UAT receipt ${eventType} retiredCriterionId is invalid`);
  }
  const choice = payload["choice"];
  if (choice !== "retire" && choice !== "keep") {
    throw new Error(`Subjective UAT receipt ${eventType} choice is invalid`);
  }
  return {
    milestoneId: receiptString(payload, "milestoneId", eventType),
    lifecycleId: receiptString(payload, "lifecycleId", eventType),
    criterionId: receiptString(payload, "criterionId", eventType),
    criterionKey: receiptString(payload, "criterionKey", eventType),
    questionId: receiptString(payload, "questionId", eventType),
    interactionId: receiptString(payload, "interactionId", eventType),
    answerId: receiptString(payload, "answerId", eventType),
    choice,
    retiredCriterionId,
    withdrawnQuestionIds: receiptStringArray(payload, "withdrawnQuestionIds", eventType),
  };
}

export function retireMilestoneSubjectiveUat(
  input: RetireMilestoneSubjectiveUatInput,
): RetireMilestoneSubjectiveUatReceipt {
  if (input.invocation.actorType !== "user" || !input.invocation.actorId?.trim()) {
    throw new Error("Subjective UAT retirement requires a user actor identity");
  }
  const retireInput = {
    criterionId: requireNonBlank(input.criterionId, "criterionId"),
    questionId: requireNonBlank(input.questionId, "questionId"),
    interactionId: requireNonBlank(input.interactionId, "interactionId"),
    selectedOptionId: requireNonBlank(input.selectedOptionId, "selectedOptionId"),
    verbatimResponse: requireNonBlank(input.verbatimResponse, "verbatimResponse"),
    rationale: requireNonBlank(input.rationale, "rationale"),
    actorId: input.invocation.actorId.trim(),
  };
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let retired: RetiredMilestoneSubjectiveUat | undefined;
  const operation = executeDomainOperation({
    operationType: "milestone.subjective-uat.retire",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "user",
    actorId: retireInput.actorId,
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: retireInput,
  }, (context) => {
    retired = retireMilestoneSubjectiveUatCriterion(context, retireInput);
    const eventPayload: DomainJsonValue = {
      milestoneId: retired.milestoneId,
      lifecycleId: retired.lifecycleId,
      criterionId: retired.criterionId,
      criterionKey: retired.criterionKey,
      questionId: retired.questionId,
      interactionId: retired.interactionId,
      answerId: retired.answerId,
      choice: retired.choice,
      retiredCriterionId: retired.retiredCriterionId,
      withdrawnQuestionIds: retired.withdrawnQuestionIds,
    };
    return {
      events: [{
        eventType: retired.choice === "retire"
          ? "milestone.subjective-uat.retired"
          : "milestone.subjective-uat.retirement-declined",
        entityType: "milestone",
        entityId: retired.milestoneId,
        payload: eventPayload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `subjective-uat/${retired.milestoneId}/${retired.questionId}`.toLowerCase(),
        projectionKind: "milestone-subjective-uat",
        rendererVersion: "1",
      }],
    };
  });
  return {
    ...operationReceipt(operation),
    ...(retired ?? storedRetirement(operation.operationId)),
  };
}
