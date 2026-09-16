# Subjective UAT Criterion Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `gsd_prepare_milestone_subjective_uat` from stranding required subjective acceptance criteria, and give the user a way to retire the ones already stranded.

**Architecture:** Retirement is modelled as supersession with `required = 0` — a new `workflow_acceptance_criteria` row carrying the predecessor's `criterion_key`, `requirement_id`, `criterion_kind`, `evidence_class`, and `description`. Both existing gates already filter `required = 1 AND NOT EXISTS successor`, so the retired chain drops out of `validateMilestone` and closeout readiness with no query changes. Retiring is authorized by the user through a two-step prepare/answer pair mirroring the existing subjective-UAT flow. A guard in `ensureSubjectiveCriterion` rejects a prepare that would open a second unanswered required chain.

**Tech Stack:** TypeScript, SQLite via the GSD domain-operation layer (`executeDomainOperation`), `node:test` with `--experimental-strip-types`, Zod for MCP parameter schemas, TypeBox for Pi tool schemas.

**Spec:** [docs/superpowers/specs/2026-09-16-subjective-uat-criterion-retirement-design.md](../specs/2026-09-16-subjective-uat-criterion-retirement-design.md)

## Global Constraints

- **No schema migration.** `workflow_acceptance_criteria` is append-only; `trg_workflow_criterion_supersession` requires a successor to carry the same `criterion_key`, `requirement_id`, and `criterion_kind`. Every write in this plan satisfies the trigger as written. Do not add, alter, or drop any table, trigger, index, or CHECK.
- `interaction_kind` must be `'consent'` for retirement interactions. It is already permitted by the CHECK at `src/resources/extensions/gsd/db-conversation-foundation-schema.ts:178`. Do **not** use `'subjective-uat'` — `hasPendingMilestoneSubjectiveUat` filters on that value and a pending retirement must not create a new auto-mode pause class.
- `operation_type` and `event_type` are free-form `TEXT NOT NULL` columns with no CHECK and no registry. New values need no registration.
- `workflow_answers.answer_disposition` accepts only `'accepted'` and `'revision-conflict'`. Retirement answers always use `'accepted'`, which records that the answer was accepted as an answer — the Retire/Keep choice is carried by `selected_option_id`, exactly as the subjective-UAT path does it.
- `workflow_interactions` CHECK requires non-blank `recommendation_text` **and** `recommendation_rationale` whenever `requires_answer = 1`. `recommendation_evidence` may stay `''` and `recommendation_confidence` may stay `NULL`.
- Retirement carries **no** `testedSourceRevision`. A duplicate criterion is a modelling error, not a judgment about a build.
- New operation type strings, verbatim: `milestone.subjective-uat.prepare-retirement` and `milestone.subjective-uat.retire`.
- New event type strings, verbatim: `milestone.subjective-uat.retirement-prepared`, `milestone.subjective-uat.retired`, `milestone.subjective-uat.retirement-declined`.
- New tool names, verbatim: `gsd_prepare_milestone_subjective_uat_retirement` and `gsd_retire_milestone_subjective_uat`.
- Comments: no comments that restate what the code does, no comments narrating changes. Only non-obvious *why*.
- Never read, write, or open `~/.gsd/projects/73f412255a8f/gsd.db`. Task 8 works on the `/tmp/m003.db` copy only.

### Fast test loop

Tasks 1–4 run against TypeScript source directly — no build needed, ~1s per file:

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts
```

Add `--test-name-pattern 'some text'` to run one test. Tasks 5–7 touch built packages and need `pnpm run build:contracts` / `pnpm run build:mcp-server` first.

---

## File Structure

| file | responsibility | tasks |
|---|---|---|
| `src/resources/extensions/gsd/db/writers/milestone-subjective-uat.ts` | all SQL for subjective-UAT criteria, questions, interactions, acceptances, and now retirement | 1, 2, 3 |
| `src/resources/extensions/gsd/milestone-subjective-uat-domain-operation.ts` | the `executeDomainOperation` wrappers, event payloads, and replay receipt readers | 2, 3 |
| `src/resources/extensions/gsd/tools/workflow-tool-executors.ts` | transport-agnostic executors returning `ToolExecutionResult` | 5 |
| `src/resources/extensions/gsd/bootstrap/db-tools.ts` | Pi tool registration and session identity | 5 |
| `packages/contracts/src/workflow.ts` | canonical tool name registry | 6 |
| `packages/mcp-server/src/workflow-tools.ts` | MCP Zod schemas, handlers, tool registration | 6 |
| `packages/mcp-server/README.md`, `docs/db-map.md` | tool documentation | 7 |
| `src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts` | writer and domain-operation contracts | 1, 2, 3 |
| `src/resources/extensions/gsd/tests/milestone-validation-domain-operation.test.ts` | gate integration and the M003 regression | 4 |

---

### Task 1: Reject a prepare that would strand a criterion

**Files:**
- Modify: `src/resources/extensions/gsd/db/writers/milestone-subjective-uat.ts`
- Test: `src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. Behaviour change only — `prepareMilestoneSubjectiveUatQuestion` now throws when it would open a second unanswered required chain on one lifecycle.

- [ ] **Step 1: Write the failing tests**

Append to `src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts`:

```ts
test("subjective UAT refuses a second required criterion while the first is unanswered", () => {
  setup();
  const first = prepareMilestoneSubjectiveUat(prepareInput("subjective/strand/first"));

  assert.throws(() => prepareMilestoneSubjectiveUat({
    ...prepareInput("subjective/strand/second"),
    criterionKey: "m001-guided-flow-rephrased",
    description: "The same judgment under a rephrased key.",
    focusedPrompt: "Does the guided flow feel natural and clear?",
  }), (error: Error) => {
    assert.match(error.message, /already has an unanswered required subjective UAT criterion/i);
    assert.match(error.message, new RegExp(first.criterionId));
    assert.match(error.message, /guided-flow/);
    assert.match(error.message, /Reuse that criterionKey to rephrase it, or retire it first/i);
    return true;
  });

  assert.equal(count("workflow_acceptance_criteria"), 1, "the rejected prepare must not insert a criterion");
  assert.equal(count("workflow_open_questions"), 1);
});

test("subjective UAT still allows rephrasing under the same criterionKey", () => {
  setup();
  const first = prepareMilestoneSubjectiveUat(prepareInput("subjective/rephrase/first"));
  const second = prepareMilestoneSubjectiveUat({
    ...prepareInput("subjective/rephrase/second"),
    description: "The guided flow reads clearly end to end.",
    focusedPrompt: "Reading it end to end, does the guided flow stay clear?",
  });

  assert.notEqual(second.criterionId, first.criterionId);
  assert.deepEqual(second.withdrawnQuestionIds, [first.questionId]);
  assert.equal(db().prepare(`
    SELECT supersedes_criterion_id FROM workflow_acceptance_criteria
    WHERE criterion_id = :criterion_id
  `).get({ ":criterion_id": second.criterionId })?.["supersedes_criterion_id"], first.criterionId);
});

test("subjective UAT allows a second required criterion once the first is answered", () => {
  setup();
  const first = prepareMilestoneSubjectiveUat(prepareInput("subjective/second-after-answer/prepare"));
  const accepted = first.options.find((option) => option.disposition === "accepted")!;
  answerMilestoneSubjectiveUat({
    invocation: userInvocation("subjective/second-after-answer/answer"),
    criterionId: first.criterionId,
    questionId: first.questionId,
    interactionId: first.interactionId,
    selectedOptionId: accepted.optionId,
    verbatimResponse: accepted.label,
    rationale: "The user accepted the guided experience.",
    testedSourceRevision: "source-a",
  });

  const second = prepareMilestoneSubjectiveUat({
    ...prepareInput("subjective/second-after-answer/second"),
    criterionKey: "error-copy",
    description: "The error copy reads plainly.",
    focusedPrompt: "Does the error copy read plainly?",
  });

  assert.notEqual(second.criterionId, first.criterionId);
  assert.equal(count("workflow_acceptance_criteria"), 2);
});

test("subjective UAT exempts a non-required criterion from the stranding guard", () => {
  setup();
  prepareMilestoneSubjectiveUat(prepareInput("subjective/optional/first"));
  const optional = prepareMilestoneSubjectiveUat({
    ...prepareInput("subjective/optional/second"),
    criterionKey: "nice-to-have",
    description: "An optional impression worth capturing.",
    focusedPrompt: "Anything else worth noting?",
    required: false,
  });

  assert.equal(db().prepare(`
    SELECT required FROM workflow_acceptance_criteria WHERE criterion_id = :criterion_id
  `).get({ ":criterion_id": optional.criterionId })?.["required"], 0);
  assert.equal(count("workflow_acceptance_criteria"), 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts --test-name-pattern 'stranding guard|unanswered required|rephrasing under the same|once the first is answered'
```

Expected: the "refuses a second required criterion" test FAILS (no error thrown — `assert.throws` reports "Missing expected exception"). The other three PASS already; they are regression locks that must keep passing after Step 3.

- [ ] **Step 3: Implement the guard**

In `src/resources/extensions/gsd/db/writers/milestone-subjective-uat.ts`, add the row type beside the other row interfaces (near `CriterionRow`, around line 82):

```ts
interface UnansweredRequiredCriterionRow {
  criterion_id: string;
  criterion_key: string;
}
```

Add this function immediately after `currentCriterion` (which ends at line 168):

```ts
// Identity is (lifecycle, criterion_key, requirement_id), so a prepare under a
// rephrased key opens a second required chain instead of superseding the first.
// Chains cannot merge, so the stranded chain would block every later `pass`
// verdict with no way to clear it. Refuse at the point of the mistake.
function unansweredRequiredSubjectiveCriterion(
  context: Readonly<DomainOperationContext>,
  lifecycleId: string,
): UnansweredRequiredCriterionRow | undefined {
  return getDb().prepare(`
    SELECT criterion.criterion_id, criterion.criterion_key
    FROM workflow_acceptance_criteria criterion
    WHERE criterion.project_id = :project_id
      AND criterion.lifecycle_id = :lifecycle_id
      AND criterion.criterion_kind = 'subjective_uat'
      AND criterion.required = 1
      AND NOT EXISTS (
        SELECT 1 FROM workflow_acceptance_criteria successor
        WHERE successor.supersedes_criterion_id = criterion.criterion_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_human_acceptances acceptance
        WHERE acceptance.project_id = criterion.project_id
          AND acceptance.criterion_id = criterion.criterion_id
      )
    ORDER BY criterion.criterion_id
    LIMIT 1
  `).get({
    ":project_id": context.projectId,
    ":lifecycle_id": lifecycleId,
  }) as unknown as UnansweredRequiredCriterionRow | undefined;
}
```

In `ensureSubjectiveCriterion`, insert this block immediately before `const criterionId = randomUUID();` (currently line 194):

```ts
  if (!current && input.required) {
    const unanswered = unansweredRequiredSubjectiveCriterion(context, lifecycleId);
    if (unanswered) {
      throw new Error(
        `Milestone lifecycle already has an unanswered required subjective UAT criterion ` +
        `${unanswered.criterion_id} with key '${unanswered.criterion_key}'. ` +
        `Reuse that criterionKey to rephrase it, or retire it first.`,
      );
    }
  }
```

The `!current` condition is what keeps rephrasing under the same key working: that path is supersession, and its head has zero acceptances by definition in the stranded case.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts
```

Expected: PASS, 17 tests. If any of the 13 pre-existing tests now fail, the guard is too broad — check that the failing test genuinely starts a second chain rather than superseding one.

- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/gsd/db/writers/milestone-subjective-uat.ts src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts
git commit -m "fix(gsd): reject a subjective UAT prepare that would strand a required criterion"
```

---

### Task 2: Prepare a retirement question

**Files:**
- Modify: `src/resources/extensions/gsd/db/writers/milestone-subjective-uat.ts`
- Modify: `src/resources/extensions/gsd/milestone-subjective-uat-domain-operation.ts`
- Test: `src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts`

**Interfaces:**
- Consumes: Task 1's guard (unchanged behaviour), and the existing `requireActiveMilestoneLifecycle`, `requireNonBlank`, `distinctTimestamp` helpers in the writer file.
- Produces:
  - `export type SubjectiveUatRetirementChoice = "retire" | "keep"`
  - `export interface SubjectiveUatRetirementOption { optionId: string; choice: SubjectiveUatRetirementChoice; label: string; description: string; recommended: boolean }`
  - `export interface PrepareSubjectiveUatRetirementWriteInput { criterionId: string; rationale: string }`
  - `export interface PreparedSubjectiveUatRetirement { milestoneId: string; lifecycleId: string; criterionId: string; criterionKey: string; questionId: string; interactionId: string; retireOptionId: string; keepOptionId: string; options: SubjectiveUatRetirementOption[] }`
  - `export function prepareMilestoneSubjectiveUatRetirementQuestion(context, input): PreparedSubjectiveUatRetirement`
  - `export function requireRetirableCriterion(context, criterionId): RetirableCriterionRow` (used again by Task 3)
  - `export interface PrepareMilestoneSubjectiveUatRetirementInput { invocation: ExecutionInvocation; criterionId: string; rationale: string }`
  - `export interface PrepareMilestoneSubjectiveUatRetirementReceipt extends OperationReceipt, PreparedSubjectiveUatRetirement {}`
  - `export function prepareMilestoneSubjectiveUatRetirement(input): PrepareMilestoneSubjectiveUatRetirementReceipt`

- [ ] **Step 1: Write the failing tests**

Append to `src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts`, and add `prepareMilestoneSubjectiveUatRetirement` to the import from `../milestone-subjective-uat-domain-operation.ts`:

```ts
function retirementInput(criterionId: string, idempotencyKey = "subjective/retire/prepare/1") {
  return {
    invocation: agentInvocation(idempotencyKey),
    criterionId,
    rationale: "Superseded by a differently-keyed criterion covering the same judgment.",
  };
}

test("subjective UAT retirement prepares a consent question and replays its exact receipt", () => {
  setup();
  const prepared = prepareMilestoneSubjectiveUat(prepareInput("subjective/retire/target"));
  const retirement = prepareMilestoneSubjectiveUatRetirement(retirementInput(prepared.criterionId));
  const replayed = prepareMilestoneSubjectiveUatRetirement(retirementInput(prepared.criterionId));

  assert.equal(retirement.status, "committed");
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.questionId, retirement.questionId);
  assert.equal(replayed.interactionId, retirement.interactionId);
  assert.deepEqual(replayed.options, retirement.options);

  assert.equal(retirement.milestoneId, "M001");
  assert.equal(retirement.criterionKey, "guided-flow");
  assert.deepEqual(retirement.options.map((option) => [option.choice, option.recommended]), [
    ["retire", true],
    ["keep", false],
  ]);
  assert.equal(retirement.options[0]!.label, "Retire (Recommended)");
  assert.equal(retirement.options[1]!.label, "Keep");
  assert.equal(retirement.retireOptionId, retirement.options[0]!.optionId);
  assert.equal(retirement.keepOptionId, retirement.options[1]!.optionId);

  assert.deepEqual(db().prepare(`
    SELECT interaction_kind, presentation_state, requires_answer, option_count, recommended_option_id
    FROM workflow_interactions WHERE interaction_id = :interaction_id
  `).get({ ":interaction_id": retirement.interactionId }), {
    interaction_kind: "consent",
    presentation_state: "presented",
    requires_answer: 1,
    option_count: 2,
    recommended_option_id: retirement.retireOptionId,
  });
  assert.equal(db().prepare(`
    SELECT question_status FROM workflow_open_questions WHERE question_id = :question_id
  `).get({ ":question_id": retirement.questionId })?.["question_status"], "open");

  assert.equal(count("workflow_acceptance_criteria"), 1, "preparing must not retire anything");
  assert.equal(count("workflow_human_acceptances"), 0);
});

test("subjective UAT retirement refuses a superseded criterion", () => {
  setup();
  const first = prepareMilestoneSubjectiveUat(prepareInput("subjective/retire/stale/first"));
  prepareMilestoneSubjectiveUat({
    ...prepareInput("subjective/retire/stale/second"),
    description: "A rephrased description under the same key.",
  });

  assert.throws(
    () => prepareMilestoneSubjectiveUatRetirement(
      retirementInput(first.criterionId, "subjective/retire/stale/prepare"),
    ),
    /requires a current required subjective criterion/i,
  );
});

test("subjective UAT retirement refuses a rejected criterion", () => {
  setup();
  const prepared = prepareMilestoneSubjectiveUat(prepareInput("subjective/retire/rejected/target"));
  const rejected = prepared.options.find((option) => option.disposition === "rejected")!;
  answerMilestoneSubjectiveUat({
    invocation: userInvocation("subjective/retire/rejected/answer"),
    criterionId: prepared.criterionId,
    questionId: prepared.questionId,
    interactionId: prepared.interactionId,
    selectedOptionId: rejected.optionId,
    verbatimResponse: rejected.label,
    rationale: "The user rejected the guided experience.",
    testedSourceRevision: "source-a",
  });

  assert.throws(
    () => prepareMilestoneSubjectiveUatRetirement(
      retirementInput(prepared.criterionId, "subjective/retire/rejected/prepare"),
    ),
    /Retire cannot clear a rejected subjective UAT criterion/i,
  );
});

test("subjective UAT retirement refuses a second open retirement question", () => {
  setup();
  const prepared = prepareMilestoneSubjectiveUat(prepareInput("subjective/retire/dup/target"));
  prepareMilestoneSubjectiveUatRetirement(
    retirementInput(prepared.criterionId, "subjective/retire/dup/first"),
  );

  assert.throws(
    () => prepareMilestoneSubjectiveUatRetirement(
      retirementInput(prepared.criterionId, "subjective/retire/dup/second"),
    ),
    /already has an open retirement question/i,
  );
});

test("subjective UAT retirement requires an open Milestone lifecycle", () => {
  setup();
  const prepared = prepareMilestoneSubjectiveUat(prepareInput("subjective/retire/paused/target"));
  transitionMilestone("paused", "subjective/retire/paused/transition");

  assert.throws(
    () => prepareMilestoneSubjectiveUatRetirement(
      retirementInput(prepared.criterionId, "subjective/retire/paused/prepare"),
    ),
    /ready or in_progress lifecycle/i,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts --test-name-pattern 'retirement'
```

Expected: FAIL at import — `SyntaxError: The requested module '../milestone-subjective-uat-domain-operation.ts' does not provide an export named 'prepareMilestoneSubjectiveUatRetirement'`.

- [ ] **Step 3: Implement the writer**

In `src/resources/extensions/gsd/db/writers/milestone-subjective-uat.ts`, add after the existing `SubjectiveUatOption` interface (line 18):

```ts
export type SubjectiveUatRetirementChoice = "retire" | "keep";

export interface SubjectiveUatRetirementOption {
  optionId: string;
  choice: SubjectiveUatRetirementChoice;
  label: string;
  description: string;
  recommended: boolean;
}

export interface PrepareSubjectiveUatRetirementWriteInput {
  criterionId: string;
  rationale: string;
}

export interface PreparedSubjectiveUatRetirement {
  milestoneId: string;
  lifecycleId: string;
  criterionId: string;
  criterionKey: string;
  questionId: string;
  interactionId: string;
  retireOptionId: string;
  keepOptionId: string;
  options: SubjectiveUatRetirementOption[];
}

export interface RetirableCriterionRow {
  milestone_id: string;
  lifecycle_id: string;
  lifecycle_status: string;
  criterion_key: string;
  requirement_id: string | null;
  description: string;
  head_disposition: string | null;
}
```

Add these functions at the end of the file:

```ts
export function requireRetirableCriterion(
  context: Readonly<DomainOperationContext>,
  criterionId: string,
): RetirableCriterionRow {
  const criterion = getDb().prepare(`
    SELECT lifecycle.milestone_id, criterion.lifecycle_id, lifecycle.lifecycle_status,
           criterion.criterion_key, criterion.requirement_id, criterion.description,
           (
             SELECT acceptance.disposition
             FROM workflow_human_acceptances acceptance
             WHERE acceptance.project_id = criterion.project_id
               AND acceptance.criterion_id = criterion.criterion_id
               AND NOT EXISTS (
                 SELECT 1 FROM workflow_human_acceptances successor
                 WHERE successor.supersedes_human_acceptance_id = acceptance.human_acceptance_id
               )
           ) AS head_disposition
    FROM workflow_acceptance_criteria criterion
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = criterion.lifecycle_id
     AND lifecycle.project_id = criterion.project_id
    WHERE criterion.criterion_id = :criterion_id
      AND criterion.project_id = :project_id
      AND criterion.criterion_kind = 'subjective_uat'
      AND criterion.required = 1
      AND lifecycle.item_kind = 'milestone'
      AND lifecycle.slice_id IS NULL
      AND lifecycle.task_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM workflow_acceptance_criteria successor
        WHERE successor.supersedes_criterion_id = criterion.criterion_id
      )
  `).get({
    ":criterion_id": criterionId,
    ":project_id": context.projectId,
  }) as unknown as RetirableCriterionRow | undefined;
  if (!criterion) {
    throw new Error(
      "Subjective UAT retirement requires a current required subjective criterion on a Milestone lifecycle",
    );
  }
  requireActiveMilestoneLifecycle(criterion.lifecycle_status);
  // A rejection is the user saying the work is not good enough. Retiring it
  // would launder that rejection into a pass; remediation must re-ask instead.
  if (criterion.head_disposition === "rejected") {
    throw new Error(
      "Retire cannot clear a rejected subjective UAT criterion; " +
      "re-prepare it under the same criterionKey after remediation.",
    );
  }
  return criterion;
}

function requireNoOpenRetirementQuestion(
  context: Readonly<DomainOperationContext>,
  criterionId: string,
): void {
  const open = getDb().prepare(`
    SELECT question.question_id
    FROM workflow_domain_events event
    JOIN workflow_open_questions question
      ON question.question_id = json_extract(event.payload_json, '$.questionId')
     AND question.project_id = event.project_id
    WHERE event.project_id = :project_id
      AND event.event_type = 'milestone.subjective-uat.retirement-prepared'
      AND json_extract(event.payload_json, '$.criterionId') = :criterion_id
      AND question.question_status = 'open'
    LIMIT 1
  `).get({
    ":project_id": context.projectId,
    ":criterion_id": criterionId,
  });
  if (open) throw new Error("Subjective UAT criterion already has an open retirement question");
}

function buildRetirementOptions(): SubjectiveUatRetirementOption[] {
  return [
    {
      optionId: randomUUID(),
      choice: "retire",
      label: "Retire (Recommended)",
      description: "Drop this acceptance criterion; it no longer needs a judgment.",
      recommended: true,
    },
    {
      optionId: randomUUID(),
      choice: "keep",
      label: "Keep",
      description: "Keep this acceptance criterion; it still needs a judgment.",
      recommended: false,
    },
  ];
}

export function prepareMilestoneSubjectiveUatRetirementQuestion(
  context: Readonly<DomainOperationContext>,
  input: PrepareSubjectiveUatRetirementWriteInput,
): PreparedSubjectiveUatRetirement {
  if (
    requireActiveDomainOperationContext(context) !==
      "milestone.subjective-uat.prepare-retirement"
  ) {
    throw new Error("Subjective UAT retirement preparation requires its Domain Operation");
  }
  const criterionId = requireNonBlank(input.criterionId, "criterionId");
  const rationale = requireNonBlank(input.rationale, "rationale");
  const criterion = requireRetirableCriterion(context, criterionId);
  requireNoOpenRetirementQuestion(context, criterionId);

  const createdAt = new Date().toISOString();
  const questionId = randomUUID();
  const interactionId = randomUUID();
  const options = buildRetirementOptions();
  const focusedPrompt =
    `Retire the subjective UAT criterion '${criterion.criterion_key}' from Milestone ` +
    `${criterion.milestone_id} without answering it? ${rationale}`;

  getDb().prepare(`
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
    ":lifecycle_id": criterion.lifecycle_id,
    ":question_text": focusedPrompt,
    ":created_at": createdAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  getDb().prepare(`
    INSERT INTO workflow_interactions (
      interaction_id, project_id, question_id, sequence, interaction_kind,
      presentation_state, focused_prompt, requires_answer, option_count,
      recommended_option_id, recommendation_text, recommendation_rationale,
      recommendation_evidence, recommendation_confidence,
      recommendation_uncertainty, revisit_condition, presented_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :interaction_id, :project_id, :question_id, 1, 'consent',
      'prepared', :focused_prompt, 1, 2,
      :recommended_option_id, :recommendation_text, :recommendation_rationale,
      '', NULL, '', '', '', :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":interaction_id": interactionId,
    ":project_id": context.projectId,
    ":question_id": questionId,
    ":focused_prompt": focusedPrompt,
    ":recommended_option_id": options[0]!.optionId,
    ":recommendation_text": "I recommend retiring this criterion.",
    ":recommendation_rationale": rationale,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  const insertOption = getDb().prepare(`
    INSERT INTO workflow_interaction_options (
      interaction_id, option_id, project_id, ordinal, label, description,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :interaction_id, :option_id, :project_id, :ordinal, :label, :description,
      :operation_id, :project_revision, :authority_epoch
    )
  `);
  options.forEach((option, index) => insertOption.run({
    ":interaction_id": interactionId,
    ":option_id": option.optionId,
    ":project_id": context.projectId,
    ":ordinal": index + 1,
    ":label": option.label,
    ":description": option.description,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  }));
  getDb().prepare(`
    UPDATE workflow_interactions
    SET presentation_state = 'presented', presented_at = :presented_at
    WHERE interaction_id = :interaction_id
  `).run({
    ":presented_at": createdAt,
    ":interaction_id": interactionId,
  });

  return {
    milestoneId: criterion.milestone_id,
    lifecycleId: criterion.lifecycle_id,
    criterionId,
    criterionKey: criterion.criterion_key,
    questionId,
    interactionId,
    retireOptionId: options[0]!.optionId,
    keepOptionId: options[1]!.optionId,
    options,
  };
}
```

- [ ] **Step 4: Implement the domain operation**

In `src/resources/extensions/gsd/milestone-subjective-uat-domain-operation.ts`, extend the writer import to add `prepareMilestoneSubjectiveUatRetirementQuestion` and `type PreparedSubjectiveUatRetirement`, then add:

```ts
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
  const parsedOptions = options.map((option) => {
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
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts
```

Expected: PASS, 22 tests.

- [ ] **Step 6: Commit**

```bash
git add src/resources/extensions/gsd/db/writers/milestone-subjective-uat.ts src/resources/extensions/gsd/milestone-subjective-uat-domain-operation.ts src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts
git commit -m "feat(gsd): prepare a user consent question to retire a subjective UAT criterion"
```

---

### Task 3: Retire on the user's answer

**Files:**
- Modify: `src/resources/extensions/gsd/db/writers/milestone-subjective-uat.ts`
- Modify: `src/resources/extensions/gsd/milestone-subjective-uat-domain-operation.ts`
- Test: `src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts`

**Interfaces:**
- Consumes: Task 2's `requireRetirableCriterion`, `SubjectiveUatRetirementChoice`, and the `milestone.subjective-uat.retirement-prepared` event payload shape.
- Produces:
  - `export interface RetireSubjectiveUatWriteInput { criterionId: string; questionId: string; interactionId: string; selectedOptionId: string; verbatimResponse: string; rationale: string; actorId: string }`
  - `export interface RetiredMilestoneSubjectiveUat { milestoneId: string; lifecycleId: string; criterionId: string; criterionKey: string; questionId: string; interactionId: string; answerId: string; choice: SubjectiveUatRetirementChoice; retiredCriterionId: string | null; withdrawnQuestionIds: string[] }`
  - `export function retireMilestoneSubjectiveUatCriterion(context, input): RetiredMilestoneSubjectiveUat`
  - `export interface RetireMilestoneSubjectiveUatInput { invocation: ExecutionInvocation; criterionId: string; questionId: string; interactionId: string; selectedOptionId: string; verbatimResponse: string; rationale: string }`
  - `export interface RetireMilestoneSubjectiveUatReceipt extends OperationReceipt, RetiredMilestoneSubjectiveUat {}`
  - `export function retireMilestoneSubjectiveUat(input): RetireMilestoneSubjectiveUatReceipt`

- [ ] **Step 1: Write the failing tests**

Append to `src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts`, adding `retireMilestoneSubjectiveUat` to the domain-operation import:

```ts
function retireCall(
  retirement: { criterionId: string; questionId: string; interactionId: string },
  optionId: string,
  label: string,
  idempotencyKey: string,
) {
  return {
    invocation: userInvocation(idempotencyKey),
    criterionId: retirement.criterionId,
    questionId: retirement.questionId,
    interactionId: retirement.interactionId,
    selectedOptionId: optionId,
    verbatimResponse: label,
    rationale: "The user confirmed this criterion is a stranded duplicate.",
  };
}

test("subjective UAT retirement supersedes the criterion as not required and withdraws its question", () => {
  setup();
  const prepared = prepareMilestoneSubjectiveUat(prepareInput("subjective/retire/apply/target"));
  const retirement = prepareMilestoneSubjectiveUatRetirement(
    retirementInput(prepared.criterionId, "subjective/retire/apply/prepare"),
  );
  const retired = retireMilestoneSubjectiveUat(retireCall(
    retirement,
    retirement.retireOptionId,
    retirement.options[0]!.label,
    "subjective/retire/apply/answer",
  ));
  const replayed = retireMilestoneSubjectiveUat(retireCall(
    retirement,
    retirement.retireOptionId,
    retirement.options[0]!.label,
    "subjective/retire/apply/answer",
  ));

  assert.equal(retired.choice, "retire");
  assert.ok(retired.retiredCriterionId);
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.retiredCriterionId, retired.retiredCriterionId);
  assert.equal(replayed.answerId, retired.answerId);

  assert.deepEqual(db().prepare(`
    SELECT criterion_key, criterion_kind, evidence_class, required,
           description, supersedes_criterion_id
    FROM workflow_acceptance_criteria WHERE criterion_id = :criterion_id
  `).get({ ":criterion_id": retired.retiredCriterionId }), {
    criterion_key: "guided-flow",
    criterion_kind: "subjective_uat",
    evidence_class: "human",
    required: 0,
    description: "The guided flow feels natural and clear.",
    supersedes_criterion_id: prepared.criterionId,
  });

  assert.deepEqual(retired.withdrawnQuestionIds, [prepared.questionId]);
  assert.equal(db().prepare(`
    SELECT question_status FROM workflow_open_questions WHERE question_id = :question_id
  `).get({ ":question_id": prepared.questionId })?.["question_status"], "withdrawn");
  assert.equal(db().prepare(`
    SELECT question_status FROM workflow_open_questions WHERE question_id = :question_id
  `).get({ ":question_id": retirement.questionId })?.["question_status"], "answered");
  assert.equal(count("workflow_human_acceptances"), 0, "retirement must never synthesize acceptance");
});

test("subjective UAT retirement declined by the user changes nothing", () => {
  setup();
  const prepared = prepareMilestoneSubjectiveUat(prepareInput("subjective/retire/keep/target"));
  const retirement = prepareMilestoneSubjectiveUatRetirement(
    retirementInput(prepared.criterionId, "subjective/retire/keep/prepare"),
  );
  const kept = retireMilestoneSubjectiveUat(retireCall(
    retirement,
    retirement.keepOptionId,
    retirement.options[1]!.label,
    "subjective/retire/keep/answer",
  ));

  assert.equal(kept.choice, "keep");
  assert.equal(kept.retiredCriterionId, null);
  assert.deepEqual(kept.withdrawnQuestionIds, []);
  assert.equal(count("workflow_acceptance_criteria"), 1);
  assert.equal(db().prepare(`
    SELECT required FROM workflow_acceptance_criteria WHERE criterion_id = :criterion_id
  `).get({ ":criterion_id": prepared.criterionId })?.["required"], 1);
  assert.equal(db().prepare(`
    SELECT question_status FROM workflow_open_questions WHERE question_id = :question_id
  `).get({ ":question_id": prepared.questionId })?.["question_status"], "open");
  assert.equal(
    db().prepare(`
      SELECT COUNT(*) AS count FROM workflow_domain_events
      WHERE event_type = 'milestone.subjective-uat.retirement-declined'
    `).get()?.["count"],
    1,
  );
});

test("subjective UAT retirement requires a user actor identity", () => {
  setup();
  const prepared = prepareMilestoneSubjectiveUat(prepareInput("subjective/retire/actor/target"));
  const retirement = prepareMilestoneSubjectiveUatRetirement(
    retirementInput(prepared.criterionId, "subjective/retire/actor/prepare"),
  );

  assert.throws(() => retireMilestoneSubjectiveUat({
    ...retireCall(
      retirement,
      retirement.retireOptionId,
      retirement.options[0]!.label,
      "subjective/retire/actor/answer",
    ),
    invocation: agentInvocation("subjective/retire/actor/answer"),
  }), /requires a user actor identity/i);
  assert.equal(count("workflow_acceptance_criteria"), 1);
});

test("subjective UAT retirement rejects a paraphrased response", () => {
  setup();
  const prepared = prepareMilestoneSubjectiveUat(prepareInput("subjective/retire/verbatim/target"));
  const retirement = prepareMilestoneSubjectiveUatRetirement(
    retirementInput(prepared.criterionId, "subjective/retire/verbatim/prepare"),
  );

  assert.throws(() => retireMilestoneSubjectiveUat(retireCall(
    retirement,
    retirement.retireOptionId,
    "yes retire it",
    "subjective/retire/verbatim/answer",
  )), /actual selected option response/i);
  assert.equal(count("workflow_acceptance_criteria"), 1);
});

test("subjective UAT retirement rejects an option outside the prepared pair", () => {
  setup();
  const prepared = prepareMilestoneSubjectiveUat(prepareInput("subjective/retire/option/target"));
  const retirement = prepareMilestoneSubjectiveUatRetirement(
    retirementInput(prepared.criterionId, "subjective/retire/option/prepare"),
  );

  assert.throws(() => retireMilestoneSubjectiveUat(retireCall(
    retirement,
    prepared.options[0]!.optionId,
    retirement.options[0]!.label,
    "subjective/retire/option/answer",
  )), /must select the prepared Retire or Keep option/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts --test-name-pattern 'retirement supersedes|retirement declined|retirement requires a user|paraphrased|outside the prepared pair'
```

Expected: FAIL at import — no export named `retireMilestoneSubjectiveUat`.

- [ ] **Step 3: Implement the writer**

In `src/resources/extensions/gsd/db/writers/milestone-subjective-uat.ts`, add the types after `PreparedSubjectiveUatRetirement`:

```ts
export interface RetireSubjectiveUatWriteInput {
  criterionId: string;
  questionId: string;
  interactionId: string;
  selectedOptionId: string;
  verbatimResponse: string;
  rationale: string;
  actorId: string;
}

export interface RetiredMilestoneSubjectiveUat {
  milestoneId: string;
  lifecycleId: string;
  criterionId: string;
  criterionKey: string;
  questionId: string;
  interactionId: string;
  answerId: string;
  choice: SubjectiveUatRetirementChoice;
  retiredCriterionId: string | null;
  withdrawnQuestionIds: string[];
}

interface RetirementBindingRow {
  interaction_project_revision: number;
  question_updated_at: string;
  retire_option_id: string;
  keep_option_id: string;
}
```

Add these functions at the end of the file:

```ts
function preparedRetirementBinding(
  context: Readonly<DomainOperationContext>,
  input: RetireSubjectiveUatWriteInput,
): RetirementBindingRow {
  const binding = getDb().prepare(`
    SELECT interaction.project_revision AS interaction_project_revision,
           question.updated_at AS question_updated_at,
           json_extract(event.payload_json, '$.retireOptionId') AS retire_option_id,
           json_extract(event.payload_json, '$.keepOptionId') AS keep_option_id
    FROM workflow_domain_events event
    JOIN workflow_open_questions question
      ON question.question_id = :question_id
     AND question.project_id = event.project_id
    JOIN workflow_interactions interaction
      ON interaction.interaction_id = :interaction_id
     AND interaction.project_id = event.project_id
     AND interaction.question_id = question.question_id
    WHERE event.project_id = :project_id
      AND event.event_type = 'milestone.subjective-uat.retirement-prepared'
      AND json_extract(event.payload_json, '$.criterionId') = :criterion_id
      AND json_extract(event.payload_json, '$.questionId') = :question_id
      AND json_extract(event.payload_json, '$.interactionId') = :interaction_id
      AND question.question_status = 'open'
      AND interaction.interaction_kind = 'consent'
      AND interaction.presentation_state = 'presented'
  `).get({
    ":project_id": context.projectId,
    ":criterion_id": input.criterionId,
    ":question_id": input.questionId,
    ":interaction_id": input.interactionId,
  }) as unknown as RetirementBindingRow | undefined;
  if (!binding) {
    throw new Error("Retirement must match a current prepared subjective-UAT retirement binding");
  }
  return binding;
}

function withdrawRetiredChainQuestions(
  context: Readonly<DomainOperationContext>,
  lifecycleId: string,
  criterionKey: string,
  requirementId: string | null,
): string[] {
  const openQuestions = getDb().prepare(`
    SELECT DISTINCT question.question_id, question.updated_at
    FROM workflow_domain_events event
    JOIN workflow_open_questions question
      ON question.question_id = json_extract(event.payload_json, '$.questionId')
     AND question.project_id = event.project_id
    JOIN workflow_acceptance_criteria criterion
      ON criterion.criterion_id = json_extract(event.payload_json, '$.criterionId')
     AND criterion.project_id = event.project_id
    WHERE event.project_id = :project_id
      AND event.event_type = 'milestone.subjective-uat.prepared'
      AND criterion.lifecycle_id = :lifecycle_id
      AND criterion.criterion_key = :criterion_key
      AND criterion.requirement_id IS :requirement_id
      AND question.question_status = 'open'
    ORDER BY question.question_id
  `).all({
    ":project_id": context.projectId,
    ":lifecycle_id": lifecycleId,
    ":criterion_key": criterionKey,
    ":requirement_id": requirementId,
  }) as unknown as Array<{ question_id: string; updated_at: string }>;

  const withdrawQuestion = getDb().prepare(`
    UPDATE workflow_open_questions
    SET question_status = 'withdrawn', state_version = state_version + 1,
        updated_at = :updated_at, last_operation_id = :operation_id,
        last_project_revision = :project_revision,
        last_authority_epoch = :authority_epoch
    WHERE question_id = :question_id
  `);
  for (const question of openQuestions) {
    withdrawQuestion.run({
      ":updated_at": distinctTimestamp(question.updated_at),
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
      ":question_id": question.question_id,
    });
  }
  return openQuestions.map((question) => question.question_id);
}

export function retireMilestoneSubjectiveUatCriterion(
  context: Readonly<DomainOperationContext>,
  input: RetireSubjectiveUatWriteInput,
): RetiredMilestoneSubjectiveUat {
  if (requireActiveDomainOperationContext(context) !== "milestone.subjective-uat.retire") {
    throw new Error("Subjective UAT retirement requires its Domain Operation");
  }
  const criterion = requireRetirableCriterion(context, input.criterionId);
  const binding = preparedRetirementBinding(context, input);

  let choice: SubjectiveUatRetirementChoice;
  if (input.selectedOptionId === binding.retire_option_id) {
    choice = "retire";
  } else if (input.selectedOptionId === binding.keep_option_id) {
    choice = "keep";
  } else {
    throw new Error("Retirement must select the prepared Retire or Keep option");
  }
  const option = getDb().prepare(`
    SELECT label FROM workflow_interaction_options
    WHERE interaction_id = :interaction_id AND option_id = :option_id
  `).get({
    ":interaction_id": input.interactionId,
    ":option_id": input.selectedOptionId,
  }) as unknown as OptionRow | undefined;
  if (!option || input.verbatimResponse !== option.label) {
    throw new Error("Subjective UAT retirement requires the actual selected option response");
  }

  const answerId = randomUUID();
  const createdAt = distinctTimestamp(binding.question_updated_at);
  getDb().prepare(`
    INSERT INTO workflow_answers (
      answer_id, project_id, question_id, interaction_id, response_kind,
      verbatim_response, selected_option_id, normalized_interpretation,
      interpretation_confidence, answer_disposition, observed_project_revision,
      created_at, operation_id, project_revision, authority_epoch
    ) VALUES (
      :answer_id, :project_id, :question_id, :interaction_id, 'answer',
      :verbatim_response, :selected_option_id, :normalized_interpretation,
      1, 'accepted', :observed_project_revision,
      :created_at, :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":answer_id": answerId,
    ":project_id": context.projectId,
    ":question_id": input.questionId,
    ":interaction_id": input.interactionId,
    ":verbatim_response": input.verbatimResponse,
    ":selected_option_id": input.selectedOptionId,
    ":normalized_interpretation": `${choice}_subjective_criterion`,
    ":observed_project_revision": binding.interaction_project_revision,
    ":created_at": createdAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  getDb().prepare(`
    UPDATE workflow_open_questions
    SET question_status = 'answered', accepted_answer_id = :answer_id,
        state_version = state_version + 1, updated_at = :updated_at,
        last_operation_id = :operation_id,
        last_project_revision = :project_revision,
        last_authority_epoch = :authority_epoch
    WHERE question_id = :question_id
  `).run({
    ":answer_id": answerId,
    ":updated_at": createdAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
    ":question_id": input.questionId,
  });

  let retiredCriterionId: string | null = null;
  let withdrawnQuestionIds: string[] = [];
  if (choice === "retire") {
    retiredCriterionId = randomUUID();
    getDb().prepare(`
      INSERT INTO workflow_acceptance_criteria (
        criterion_id, criterion_key, project_id, lifecycle_id, requirement_id,
        criterion_kind, evidence_class, required, description,
        supersedes_criterion_id, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES (
        :criterion_id, :criterion_key, :project_id, :lifecycle_id, :requirement_id,
        'subjective_uat', 'human', 0, :description,
        :supersedes_criterion_id, :created_at,
        :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":criterion_id": retiredCriterionId,
      ":criterion_key": criterion.criterion_key,
      ":project_id": context.projectId,
      ":lifecycle_id": criterion.lifecycle_id,
      ":requirement_id": criterion.requirement_id,
      ":description": criterion.description,
      ":supersedes_criterion_id": input.criterionId,
      ":created_at": createdAt,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    withdrawnQuestionIds = withdrawRetiredChainQuestions(
      context,
      criterion.lifecycle_id,
      criterion.criterion_key,
      criterion.requirement_id,
    );
  }

  return {
    milestoneId: criterion.milestone_id,
    lifecycleId: criterion.lifecycle_id,
    criterionId: input.criterionId,
    criterionKey: criterion.criterion_key,
    questionId: input.questionId,
    interactionId: input.interactionId,
    answerId,
    choice,
    retiredCriterionId,
    withdrawnQuestionIds,
  };
}
```

- [ ] **Step 4: Implement the domain operation**

In `src/resources/extensions/gsd/milestone-subjective-uat-domain-operation.ts`, extend the writer import with `retireMilestoneSubjectiveUatCriterion` and `type RetiredMilestoneSubjectiveUat`, then add:

```ts
export interface RetireMilestoneSubjectiveUatInput {
  invocation: ExecutionInvocation;
  criterionId: string;
  questionId: string;
  interactionId: string;
  selectedOptionId: string;
  verbatimResponse: string;
  rationale: string;
}

export interface RetireMilestoneSubjectiveUatReceipt
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
  if (!row) throw new Error(`Subjective UAT receipt is missing ${retiredType}`);
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
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts
```

Expected: PASS, 27 tests.

- [ ] **Step 6: Commit**

```bash
git add src/resources/extensions/gsd/db/writers/milestone-subjective-uat.ts src/resources/extensions/gsd/milestone-subjective-uat-domain-operation.ts src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts
git commit -m "feat(gsd): retire a subjective UAT criterion on the user's recorded consent"
```

---

### Task 4: Gate integration and the M003 regression

**Files:**
- Test: `src/resources/extensions/gsd/tests/milestone-validation-domain-operation.test.ts`

**Interfaces:**
- Consumes: `prepareMilestoneSubjectiveUatRetirement` and `retireMilestoneSubjectiveUat` from Task 2 and Task 3; the file's existing `makeBase`, `invocation`, `sourceRevision`, `validate`, `row`, and `readMilestoneCloseoutReadiness` helpers.
- Produces: no new source. This task proves the change reaches both gates and fixes M003's shape.

No production code should be needed. If a test here fails, the defect is in Task 1–3 code; fix it there and re-run those tasks' suites too.

- [ ] **Step 1: Write the failing tests**

Append to `src/resources/extensions/gsd/tests/milestone-validation-domain-operation.test.ts`, adding `prepareMilestoneSubjectiveUatRetirement` and `retireMilestoneSubjectiveUat` to the existing import from `../milestone-subjective-uat-domain-operation.ts`:

```ts
test("Milestone validation passes once a stranded subjective criterion is retired", async () => {
  const basePath = makeBase();
  const revision = sourceRevision(basePath);

  // Reproduces M003: one key superseded in place, then two rephrased keys open
  // independent required chains, only the last of which the user ever answered.
  const stranded = prepareMilestoneSubjectiveUat({
    invocation: invocation("m003/prepare/owns-domain-types"),
    milestoneId: "M001",
    criterionKey: "developer-owns-domain-types-in-repo",
    description: "The developer owns the domain types in this repo.",
    focusedPrompt: "Does this service own its domain types in-repo?",
    recommendedDisposition: "accepted",
    recommendationRationale: "The domain model moved in-repo.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision: revision,
  });

  assert.throws(() => prepareMilestoneSubjectiveUat({
    invocation: invocation("m003/prepare/single-pr"),
    milestoneId: "M001",
    criterionKey: "developer-single-pr-domain-change",
    description: "A domain change is one PR.",
    focusedPrompt: "Is a domain change now a single PR?",
    recommendedDisposition: "accepted",
    recommendationRationale: "The domain model moved in-repo.",
    recommendationEvidence: "Current technical validation receipt.",
    testedSourceRevision: revision,
  }), /already has an unanswered required subjective UAT criterion/i);

  const blocked = await validate(basePath, "m003/validate/blocked");
  assert.ok("error" in blocked, "an unanswered required subjective criterion must block pass");
  assert.match(String(blocked.error), /requires accepted subjective UAT criterion/i);

  const retirement = prepareMilestoneSubjectiveUatRetirement({
    invocation: invocation("m003/retire/prepare"),
    criterionId: stranded.criterionId,
    rationale: "Stranded duplicate; the same judgment is covered elsewhere.",
  });
  const retired = retireMilestoneSubjectiveUat({
    invocation: {
      ...invocation("m003/retire/answer"),
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

  assert.equal(retired.choice, "retire");
  assert.deepEqual(retired.withdrawnQuestionIds, [stranded.questionId]);
  assert.equal(hasPendingMilestoneSubjectiveUat("M001"), false);

  const passed = await validate(basePath, "m003/validate/passed");
  assert.ok(!("error" in passed), "retiring the stranded criterion must unblock pass");
  const payload = JSON.parse(String(row(`
    SELECT payload_json FROM workflow_domain_events
    WHERE event_type = 'milestone.validation.recorded'
    ORDER BY project_revision DESC LIMIT 1
  `).payload_json)) as Record<string, unknown>;
  assert.deepEqual(payload["humanAcceptanceIds"], []);
  assert.ok(
    !(payload["criterionIds"] as string[]).includes(stranded.criterionId),
    "the retired criterion must not be bound into the validation receipt",
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
```

Add `hasPendingMilestoneSubjectiveUat` to the same import if it is not already there.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-validation-domain-operation.test.ts --test-name-pattern 'stranded subjective criterion is retired|closeout readiness ignores a retired'
```

Expected: FAIL. Before Tasks 1–3 are wired through, either the import fails or the `validate` call after retirement still errors.

- [ ] **Step 3: Make the tests pass**

No new production code is expected. If a test fails, diagnose against these likely causes and fix in the file named:

- `validate` still errors after retirement → the `required = 0` successor is not being inserted, or `supersedes_criterion_id` is not the retired head. Check `retireMilestoneSubjectiveUatCriterion` in `db/writers/milestone-subjective-uat.ts`.
- `hasPendingMilestoneSubjectiveUat` still true → `withdrawRetiredChainQuestions` is not matching. Confirm it joins `milestone.subjective-uat.prepared` events (not `retirement-prepared`) and filters on `criterion.requirement_id IS :requirement_id`.
- `criterionIds` still contains the retired criterion → `currentRequiredSubjectiveProofs` is returning it, which means `required` was not written as `0`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-validation-domain-operation.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/gsd/tests/milestone-validation-domain-operation.test.ts
git commit -m "test(gsd): cover subjective UAT retirement across validation and closeout gates"
```

---

### Task 5: Pi tool surface

**Files:**
- Modify: `src/resources/extensions/gsd/tools/workflow-tool-executors.ts`
- Modify: `src/resources/extensions/gsd/bootstrap/db-tools.ts`

**Interfaces:**
- Consumes: `prepareMilestoneSubjectiveUatRetirement`, `retireMilestoneSubjectiveUat`, `PrepareMilestoneSubjectiveUatRetirementInput`, `RetireMilestoneSubjectiveUatInput`, `PrepareMilestoneSubjectiveUatRetirementReceipt` from Task 2 and Task 3.
- Produces:
  - `export type PrepareMilestoneSubjectiveUatRetirementExecutorParams = Omit<PrepareMilestoneSubjectiveUatRetirementInput, "invocation">`
  - `export type RetireMilestoneSubjectiveUatExecutorParams = Omit<RetireMilestoneSubjectiveUatInput, "invocation">`
  - `export async function executePrepareMilestoneSubjectiveUatRetirement(params, basePath, invocation): Promise<ToolExecutionResult>`
  - `export async function executeRetireMilestoneSubjectiveUat(params, basePath, invocation): Promise<ToolExecutionResult>`
  - Pi tools `gsd_prepare_milestone_subjective_uat_retirement` and `gsd_retire_milestone_subjective_uat`

- [ ] **Step 1: Add the executors**

In `src/resources/extensions/gsd/tools/workflow-tool-executors.ts`, extend the import from `../milestone-subjective-uat-domain-operation.js` with `prepareMilestoneSubjectiveUatRetirement`, `retireMilestoneSubjectiveUat`, `type PrepareMilestoneSubjectiveUatRetirementInput`, `type PrepareMilestoneSubjectiveUatRetirementReceipt`, and `type RetireMilestoneSubjectiveUatInput`.

Add the param types beside the existing ones (near line 865):

```ts
export type PrepareMilestoneSubjectiveUatRetirementExecutorParams = Omit<
  PrepareMilestoneSubjectiveUatRetirementInput,
  "invocation"
>;
export type RetireMilestoneSubjectiveUatExecutorParams = Omit<
  RetireMilestoneSubjectiveUatInput,
  "invocation"
>;
```

Append at the end of the file:

```ts
// Same constraint as formatPreparedSubjectiveUat: `details` becomes
// `structuredContent`, which no orchestrating agent reads, so the binding IDs
// and the exact option labels have to appear in the text block too.
function formatPreparedSubjectiveUatRetirement(
  result: PrepareMilestoneSubjectiveUatRetirementReceipt,
): string {
  const options = result.options.map((option) =>
    [
      `- optionId: ${option.optionId}`,
      `  choice: ${option.choice}${option.recommended ? " (recommended)" : ""}`,
      `  verbatimResponse: ${option.label}`,
      `  ${option.description}`,
    ].join("\n")
  );
  return [
    `Prepared a retirement decision for subjective UAT criterion '${result.criterionKey}' on ${result.milestoneId}.`,
    "",
    "Ask the user this question, then call gsd_retire_milestone_subjective_uat with:",
    `  criterionId: ${result.criterionId}`,
    `  questionId: ${result.questionId}`,
    `  interactionId: ${result.interactionId}`,
    "",
    "Pick exactly one option. `verbatimResponse` must be that option's label, character for character:",
    ...options,
  ].join("\n");
}

export async function executePrepareMilestoneSubjectiveUatRetirement(
  params: PrepareMilestoneSubjectiveUatRetirementExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  if (!await ensureDbOpen(basePath)) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot prepare subjective UAT retirement." }],
      details: { operation: "prepare_milestone_subjective_uat_retirement", error: "db_unavailable" },
      isError: true,
    };
  }
  try {
    const result = prepareMilestoneSubjectiveUatRetirement({ ...params, invocation });
    return {
      content: [{ type: "text", text: formatPreparedSubjectiveUatRetirement(result) }],
      details: {
        operation: "prepare_milestone_subjective_uat_retirement",
        ...result,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error preparing subjective UAT retirement: ${message}` }],
      details: { operation: "prepare_milestone_subjective_uat_retirement", error: message },
      isError: true,
    };
  }
}

export async function executeRetireMilestoneSubjectiveUat(
  params: RetireMilestoneSubjectiveUatExecutorParams,
  basePath: string,
  invocation: ExecutionInvocation,
): Promise<ToolExecutionResult> {
  if (!await ensureDbOpen(basePath)) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot retire subjective UAT criterion." }],
      details: { operation: "retire_milestone_subjective_uat", error: "db_unavailable" },
      isError: true,
    };
  }
  try {
    const result = retireMilestoneSubjectiveUat({ ...params, invocation });
    const summary = result.choice === "retire"
      ? `Retired subjective UAT criterion '${result.criterionKey}' on the user's recorded consent.`
      : `The user kept subjective UAT criterion '${result.criterionKey}'; it still requires an answer.`;
    return {
      content: [{
        type: "text",
        text: [
          summary,
          `  criterionId: ${result.criterionId}`,
          `  retiredCriterionId: ${result.retiredCriterionId ?? "none"}`,
          `  withdrawnQuestionIds: ${result.withdrawnQuestionIds.join(", ") || "none"}`,
        ].join("\n"),
      }],
      details: {
        operation: "retire_milestone_subjective_uat",
        ...result,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error retiring subjective UAT criterion: ${message}` }],
      details: { operation: "retire_milestone_subjective_uat", error: message },
      isError: true,
    };
  }
}
```

- [ ] **Step 2: Register the Pi tools**

In `src/resources/extensions/gsd/bootstrap/db-tools.ts`, insert immediately after the `gsd_answer_milestone_subjective_uat` registration (which closes at line 2124):

```ts
	registerWorkflowTool(pi, {
		name: "gsd_prepare_milestone_subjective_uat_retirement",
		label: "Prepare Milestone Subjective UAT Retirement",
		description:
			"Prepare a user decision to retire a stranded or obsolete required subjective Milestone UAT criterion.",
		promptSnippet: "Ask the user whether to retire a subjective UAT criterion",
		promptGuidelines: [
			"Use only when a required subjective criterion can no longer be answered meaningfully — typically a duplicate left behind by an earlier rephrased criterionKey.",
			"Retiring drops a human-judgment gate, so the user decides; never infer their answer.",
			"The result text carries the criterionId, questionId, interactionId, and option IDs that gsd_retire_milestone_subjective_uat requires; keep them for that call.",
		],
		parameters: Type.Object({
			criterionId: Type.String({ minLength: 1 }),
			rationale: Type.String({ minLength: 1 }),
		}),
		execute: async (
			toolCallId: string,
			params: any,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) => {
			const { executePrepareMilestoneSubjectiveUatRetirement } =
				await loadWorkflowExecutors();
			return executePrepareMilestoneSubjectiveUatRetirement(
				params,
				resolveWorkflowToolBasePath(_ctx, params),
				piExecutionInvocation(
					"gsd_prepare_milestone_subjective_uat_retirement",
					toolCallId,
				),
			);
		},
	});

	registerWorkflowTool(pi, {
		name: "gsd_retire_milestone_subjective_uat",
		label: "Retire Milestone Subjective UAT Criterion",
		description:
			"Record the user's decision to retire or keep a required subjective Milestone UAT criterion using the authenticated Pi session identity.",
		promptSnippet: "Record the user's subjective UAT retirement decision",
		promptGuidelines: [
			"Call only after the user explicitly chooses Retire or Keep.",
			"Copy criterionId, questionId, interactionId, and selectedOptionId from the gsd_prepare_milestone_subjective_uat_retirement result.",
			"verbatimResponse must be the selected option's label character for character, not a paraphrase of what the user said.",
			"Actor identity is derived from the active session and is not a tool argument.",
		],
		parameters: Type.Object({
			criterionId: Type.String({ minLength: 1 }),
			questionId: Type.String({ minLength: 1 }),
			interactionId: Type.String({ minLength: 1 }),
			selectedOptionId: Type.String({ minLength: 1 }),
			verbatimResponse: Type.String({ minLength: 1 }),
			rationale: Type.String({ minLength: 1 }),
		}),
		execute: async (
			toolCallId: string,
			params: any,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: any,
		) => {
			const actorId = _ctx?.sessionManager?.getSessionId?.();
			if (typeof actorId !== "string" || !actorId.trim()) {
				return {
					content: [
						{
							type: "text",
							text: "Error retiring subjective UAT criterion: authenticated Pi session identity is unavailable",
						},
					],
					details: {
						operation: "retire_milestone_subjective_uat",
						error: "user_identity_unavailable",
					},
					isError: true,
				};
			}
			const { executeRetireMilestoneSubjectiveUat } =
				await loadWorkflowExecutors();
			return executeRetireMilestoneSubjectiveUat(
				params,
				resolveWorkflowToolBasePath(_ctx, params),
				{
					...piExecutionInvocation(
						"gsd_retire_milestone_subjective_uat",
						toolCallId,
					),
					actorType: "user",
					actorId: actorId.trim(),
				},
			);
		},
	});
```

- [ ] **Step 3: Typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors. Pre-existing errors unrelated to these files, if any, are not yours to fix — confirm by checking the reported paths.

- [ ] **Step 4: Run the affected suites**

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts src/resources/extensions/gsd/tests/milestone-validation-domain-operation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/gsd/tools/workflow-tool-executors.ts src/resources/extensions/gsd/bootstrap/db-tools.ts
git commit -m "feat(gsd): expose subjective UAT retirement as Pi workflow tools"
```

---

### Task 6: MCP tool surface

**Files:**
- Modify: `packages/contracts/src/workflow.ts`
- Modify: `packages/mcp-server/src/workflow-tools.ts`

**Interfaces:**
- Consumes: `executePrepareMilestoneSubjectiveUatRetirement` and `executeRetireMilestoneSubjectiveUat` from Task 5, resolved lazily through `getWorkflowToolExecutors()`.
- Produces: MCP tools `gsd_prepare_milestone_subjective_uat_retirement` and `gsd_retire_milestone_subjective_uat`, plus their contract registry entries.

`packages/mcp-server/src/workflow-tools.test.ts:384` asserts the registered tool count equals `WORKFLOW_TOOL_NAMES.length`. Both halves of this task must land together or that test fails.

- [ ] **Step 1: Run the parity test to see it pass before the change**

```bash
pnpm run build:contracts && pnpm --filter @opengsd/mcp-server run test 2>&1 | tail -20
```

Expected: PASS. This is the baseline; note the tool count so you can confirm it grows by exactly 2.

- [ ] **Step 2: Add the contract registry entries**

In `packages/contracts/src/workflow.ts`, insert immediately after the `gsd_answer_milestone_subjective_uat` entry (line 146):

```ts
	{
		canonicalName: "gsd_prepare_milestone_subjective_uat_retirement",
		aliases: [],
		schemaId: "workflow.milestone.subjective_uat.prepare_retirement",
		executorId: "executePrepareMilestoneSubjectiveUatRetirement",
		writePolicy: "write",
		auditEvent: "workflow.milestone.subjective_uat.prepare_retirement",
	},
	{
		canonicalName: "gsd_retire_milestone_subjective_uat",
		aliases: [],
		schemaId: "workflow.milestone.subjective_uat.retire",
		executorId: "executeRetireMilestoneSubjectiveUat",
		writePolicy: "write",
		auditEvent: "workflow.milestone.subjective_uat.retire",
	},
```

- [ ] **Step 3: Add the MCP schemas, handlers, and registrations**

In `packages/mcp-server/src/workflow-tools.ts`, add after `answerMilestoneSubjectiveUatSchema` (line 2162):

```ts
const prepareMilestoneSubjectiveUatRetirementParams = {
  projectDir: projectDirParam,
  criterionId: nonEmptyString("criterionId"),
  rationale: nonEmptyString("rationale"),
};
const prepareMilestoneSubjectiveUatRetirementSchema = z.object(
  prepareMilestoneSubjectiveUatRetirementParams,
);

const retireMilestoneSubjectiveUatParams = {
  projectDir: projectDirParam,
  criterionId: nonEmptyString("criterionId"),
  questionId: nonEmptyString("questionId"),
  interactionId: nonEmptyString("interactionId"),
  selectedOptionId: nonEmptyString("selectedOptionId"),
  verbatimResponse: nonEmptyString("verbatimResponse"),
  rationale: nonEmptyString("rationale"),
};
const retireMilestoneSubjectiveUatSchema = z.object(retireMilestoneSubjectiveUatParams);
```

Add after `handleAnswerMilestoneSubjectiveUat` (line 1656). Neither handler calls `enforceWorkflowWriteGate`, matching `handleAnswerMilestoneSubjectiveUat`: the gate keys on a `milestoneId` argument, and these tools take a `criterionId` instead.

```ts
async function handlePrepareMilestoneSubjectiveUatRetirement(
  projectDir: string,
  args: z.infer<typeof prepareMilestoneSubjectiveUatRetirementSchema>,
  invocation: ExecutionInvocation,
): Promise<unknown> {
  const { executePrepareMilestoneSubjectiveUatRetirement } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(await runSerializedWorkflowOperation(() =>
    executePrepareMilestoneSubjectiveUatRetirement(params, projectDir, invocation)
  ));
}

async function handleRetireMilestoneSubjectiveUat(
  projectDir: string,
  args: z.infer<typeof retireMilestoneSubjectiveUatSchema>,
  invocation: ExecutionInvocation,
): Promise<unknown> {
  const { executeRetireMilestoneSubjectiveUat } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(await runSerializedWorkflowOperation(() =>
    executeRetireMilestoneSubjectiveUat(params, projectDir, invocation)
  ));
}
```

Add after the `gsd_answer_milestone_subjective_uat` `server.tool(...)` block (which closes at line 3448):

```ts
  server.tool(
    "gsd_prepare_milestone_subjective_uat_retirement",
    "Prepare a user decision to retire a stranded or obsolete required subjective Milestone UAT criterion. " +
      "Use only when the criterion can no longer be answered meaningfully, typically a duplicate left behind by an " +
      "earlier rephrased criterionKey. The result carries the criterionId, questionId, interactionId, and option IDs " +
      "that gsd_retire_milestone_subjective_uat requires.",
    prepareMilestoneSubjectiveUatRetirementParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(prepareMilestoneSubjectiveUatRetirementSchema, args);
      return handlePrepareMilestoneSubjectiveUatRetirement(
        parsed.projectDir,
        parsed,
        mcpWorkflowExecutionInvocation("gsd_prepare_milestone_subjective_uat_retirement", extra),
      );
    },
  );

  server.tool(
    "gsd_retire_milestone_subjective_uat",
    "Record the user's decision to retire or keep a required subjective Milestone UAT criterion using authenticated " +
      "MCP session identity. criterionId, questionId, interactionId, and selectedOptionId must be copied from the " +
      "gsd_prepare_milestone_subjective_uat_retirement result; verbatimResponse must be the selected option's label " +
      "character for character.",
    retireMilestoneSubjectiveUatParams,
    async (args: Record<string, unknown>, extra?: WorkflowMcpRequestExtra) => {
      const parsed = parseWorkflowArgs(retireMilestoneSubjectiveUatSchema, args);
      return handleRetireMilestoneSubjectiveUat(
        parsed.projectDir,
        parsed,
        mcpUserResponseInvocation("gsd_retire_milestone_subjective_uat", extra),
      );
    },
  );
```

- [ ] **Step 4: Rebuild and run the package tests**

```bash
pnpm run build:contracts && pnpm --filter @opengsd/mcp-server run test 2>&1 | tail -20
```

Expected: PASS, with the tool count 2 higher than the Step 1 baseline. If the count assertion fails, one of the two halves is missing.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/workflow.ts packages/mcp-server/src/workflow-tools.ts
git commit -m "feat(mcp-server): expose subjective UAT retirement tools"
```

---

### Task 7: Documentation

**Files:**
- Modify: `packages/mcp-server/README.md`
- Modify: `docs/db-map.md`

**Interfaces:**
- Consumes: the tool names and behaviour from Tasks 5 and 6.
- Produces: no code.

These are hand-maintained files, not generated.

- [ ] **Step 1: Update the mcp-server README tool list**

In `packages/mcp-server/README.md`, add after the `gsd_answer_milestone_subjective_uat` bullet (line 100):

```markdown
- `gsd_prepare_milestone_subjective_uat_retirement`
- `gsd_retire_milestone_subjective_uat`
```

- [ ] **Step 2: Update the README idempotency paragraph**

In the same file at line 123, make two exact string replacements.

Find:

```
(`gsd_validate_milestone`, `gsd_prepare_milestone_subjective_uat`, `gsd_answer_milestone_subjective_uat`, `gsd_complete_milestone`, and `gsd_milestone_reopen`) prefer a nonblank private
```

Replace with:

```
(`gsd_validate_milestone`, `gsd_prepare_milestone_subjective_uat`, `gsd_answer_milestone_subjective_uat`, `gsd_prepare_milestone_subjective_uat_retirement`, `gsd_retire_milestone_subjective_uat`, `gsd_complete_milestone`, and `gsd_milestone_reopen`) prefer a nonblank private
```

Find:

```
Subjective UAT answers additionally require an authenticated MCP session identity.
```

Replace with:

```
Subjective UAT answers and criterion retirements additionally require an authenticated MCP session identity.
```

- [ ] **Step 3: Update the db-map tool table**

In `docs/db-map.md`, add after the `gsd_answer_milestone_subjective_uat` row (line 1997):

```markdown
| `gsd_prepare_milestone_subjective_uat_retirement` | project_authority, Milestone lifecycle, the current required subjective criterion and its head Human Acceptance, and prior retirement events | project_authority, workflow operations/events/outbox/Projection Work, open questions, interactions, and interaction options | — |
| `gsd_retire_milestone_subjective_uat` | project_authority, Milestone lifecycle, the current required subjective criterion, the prepared retirement question/interaction/options | project_authority, workflow operations/events/outbox/Projection Work, Answers, open-question status, and on Retire a `required = 0` superseding acceptance criterion plus withdrawal of the retired chain's open questions | — |
```

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/README.md docs/db-map.md
git commit -m "docs(gsd): document the subjective UAT retirement tools"
```

`docs/prompt-db-combined-map.md` is deliberately **not** touched. It is organised by pipeline phase, not by tool — it mentions `gsd_` tools only 12 times and has no per-tool table. Adding a retirement row would invent structure the file does not have.

---

### Task 8: Full verification and the M003 dry run

**Files:** none modified.

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: the evidence that the change is complete and that M003's recovery will work.

- [ ] **Step 1: Build everything**

```bash
pnpm run build:contracts && pnpm run build:pi && pnpm run build:rpc-client && pnpm run build:mcp-server && node native/scripts/build.js --dev --test-fault-injection && pnpm run build:core
```

Expected: all succeed. A fresh worktree needs these before the unit suite can pass — missing build artifacts look like unrelated test failures.

- [ ] **Step 2: Run the full unit suite**

```bash
pnpm run test:unit --test-concurrency=8
```

Expected: PASS. The baseline before this change is 14378 passed; this change adds tests, so the count should be higher and the failure count must be 0. The `--test-concurrency=8` flag is required — without it the large suite is silently skipped.

- [ ] **Step 3: Run the package suite**

```bash
pnpm run test:packages
```

Expected: 6 pre-existing failures (5 mcp-server artifact-file assertions and 1 pi-tui spinner test). Confirm the failures are exactly those and that none is in `workflow-tools.test.ts`. Do not fix the pre-existing ones.

- [ ] **Step 4: Refresh the M003 copy**

```bash
cp ~/.gsd/projects/73f412255a8f/gsd.db /tmp/m003.db && cp ~/.gsd/projects/73f412255a8f/gsd.db-wal /tmp/m003.db-wal && cp ~/.gsd/projects/73f412255a8f/gsd.db-shm /tmp/m003.db-shm
```

This copies only. Never open the original with a writer.

- [ ] **Step 5: Confirm the pre-state on the copy**

```bash
sqlite3 /tmp/m003.db "SELECT c.criterion_id, c.criterion_key, c.required, (SELECT COUNT(*) FROM workflow_human_acceptances a WHERE a.criterion_id = c.criterion_id) AS acceptances FROM workflow_acceptance_criteria c WHERE c.lifecycle_id = '1447a6e2-7555-4658-b853-c17247e9e30f' AND c.criterion_kind = 'subjective_uat' AND NOT EXISTS (SELECT 1 FROM workflow_acceptance_criteria s WHERE s.supersedes_criterion_id = c.criterion_id);"
```

Expected exactly three rows, all `required = 1`:

```
3dee6b2e-870c-4a77-a427-70e4ceaa4294|developer-owns-domain-types-in-repo|1|0
892bd13b-d228-47cd-8993-5d12c3768884|developer-single-pr-domain-change|1|2
b31bcce4-bf19-4826-b5fd-76b01b69e4e5|m003-developer-owns-domain-types-single-pr|1|0
```

- [ ] **Step 6: Dry-run the retirement against the copy**

Create `/tmp/m003-dry-run.ts` with exactly this content:

```ts
import assert from "node:assert/strict";

import {
  prepareMilestoneSubjectiveUatRetirement,
  retireMilestoneSubjectiveUat,
} from "/Users/MiRogers/.claude/worktrees/gsd-pi/admiring-hugle-57a86c/src/resources/extensions/gsd/milestone-subjective-uat-domain-operation.ts";
import {
  closeDatabase,
  openDatabase,
} from "/Users/MiRogers/.claude/worktrees/gsd-pi/admiring-hugle-57a86c/src/resources/extensions/gsd/gsd-db.ts";

const STRANDED = [
  "3dee6b2e-870c-4a77-a427-70e4ceaa4294",
  "b31bcce4-bf19-4826-b5fd-76b01b69e4e5",
];

assert.equal(openDatabase("/tmp/m003.db"), true);
try {
  for (const criterionId of STRANDED) {
    const retirement = prepareMilestoneSubjectiveUatRetirement({
      invocation: {
        idempotencyKey: `dry-run/retire/prepare/${criterionId}`,
        sourceTransport: "internal",
        actorType: "agent",
        actorId: "dry-run",
      },
      criterionId,
      rationale:
        "Stranded duplicate of the criterion accepted as 892bd13b-d228-47cd-8993-5d12c3768884.",
    });
    const retireOption = retirement.options.find((option) => option.choice === "retire");
    assert.ok(retireOption);
    const retired = retireMilestoneSubjectiveUat({
      invocation: {
        idempotencyKey: `dry-run/retire/answer/${criterionId}`,
        sourceTransport: "internal",
        actorType: "user",
        actorId: "dry-run-user",
      },
      criterionId,
      questionId: retirement.questionId,
      interactionId: retirement.interactionId,
      selectedOptionId: retireOption.optionId,
      verbatimResponse: retireOption.label,
      rationale: "Dry run confirming the recovery path.",
    });
    assert.equal(retired.choice, "retire");
    console.log(
      `${criterionId} -> retired as ${retired.retiredCriterionId}, ` +
      `withdrew [${retired.withdrawnQuestionIds.join(", ")}]`,
    );
  }
} finally {
  closeDatabase();
}
```

If the worktree path differs from the one above, replace both import paths with absolute paths into the worktree you are working in — `resolve-ts.mjs` resolves relative to the importing file, and this file lives in `/tmp`.

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types /tmp/m003-dry-run.ts
```

Expected: two lines of output, one per criterion, each naming a new `retiredCriterionId` and one withdrawn question, and no thrown error.

- [ ] **Step 7: Confirm the post-state on the copy**

```bash
sqlite3 /tmp/m003.db "SELECT c.criterion_id, c.criterion_key, c.required FROM workflow_acceptance_criteria c WHERE c.lifecycle_id = '1447a6e2-7555-4658-b853-c17247e9e30f' AND c.criterion_kind = 'subjective_uat' AND NOT EXISTS (SELECT 1 FROM workflow_acceptance_criteria s WHERE s.supersedes_criterion_id = c.criterion_id) AND c.required = 1; SELECT question_id, question_status FROM workflow_open_questions WHERE question_id IN ('23c639d1-4c18-4f44-806f-b5c61f5cd483','a5aa9049-aa3d-4135-a4ba-b6e1fa8ca61a');"
```

Expected: exactly one required criterion remains — `892bd13b-d228-47cd-8993-5d12c3768884|developer-single-pr-domain-change|1` — and both questions read `withdrawn`.

- [ ] **Step 8: Clean up the scratch files**

```bash
rm -f /tmp/m003-dry-run.ts /tmp/m003.db /tmp/m003.db-wal /tmp/m003.db-shm
```

- [ ] **Step 9: Report**

Report to the user: the unit suite result with its pass count, the package suite result naming the pre-existing failures, the dry-run pre- and post-state output, and the two `gsd_prepare_milestone_subjective_uat_retirement` / `gsd_retire_milestone_subjective_uat` calls they need to make in their live session once main is rebuilt. Do not run those against live state — step 2 of each needs their authenticated session identity.

---

## Notes for the reviewer

- Task 1 changes behaviour for any existing caller that prepares two subjective criteria before answering either. That is the accepted cost recorded in the spec's decision 2.
- Retirement deliberately never writes a `workflow_human_acceptances` row. Several tests assert `count("workflow_human_acceptances") === 0` after a retirement; that assertion is the guard against a future change making retirement synthesize acceptance.
- The spec records one hole this plan does not close: `prepare` with `required: false` still leaves an open question that nothing answers, which parks auto mode. Do not fix it here.
