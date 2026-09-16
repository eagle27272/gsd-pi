# Subjective UAT criterion retirement

Date: 2026-09-16

## Problem

`gsd_prepare_milestone_subjective_uat` strands required acceptance criteria on a
Milestone lifecycle, and nothing in the tool surface can clear them.

`ensureSubjectiveCriterion` identifies the criterion to supersede by
`(project_id, lifecycle_id, criterion_key, requirement_id)`. A prepare call with
a different `criterionKey` therefore supersedes nothing — it starts a second
chain, leaving two current `criterion_kind = 'subjective_uat'`, `required = 1`
heads on the same lifecycle. `criterionKey` is free-form agent input
(`Type.String({ minLength: 1 })`), so an agent that rephrases the key across
retries silently multiplies required criteria.

Two gates then block on every current required subjective criterion:

- `currentRequiredSubjectiveProofs` in
  `src/resources/extensions/gsd/milestone-validation-domain-operation.ts` makes
  `validateMilestone` throw `Milestone validation pass requires accepted
  subjective UAT criterion <id>` for `verdict: "pass"` unless every one of them
  carries an accepted `workflow_human_acceptances` row bound to the exact
  `testedSourceRevision`.
- `currentCriteria` in
  `src/resources/extensions/gsd/db/milestone-closeout-readiness.ts` applies the
  same `required = 1` + current-head filter to closeout readiness.

There is a second symptom the original report did not cover.
`reconcileOpenQuestions` also scopes its withdrawal to the matching
`criterion_key`, so the abandoned chains keep their `workflow_open_questions`
rows at `question_status = 'open'` forever. `hasPendingMilestoneSubjectiveUat`
is therefore permanently true, which parks auto-verification at
`src/resources/extensions/gsd/auto-verification.ts:580` with "subjective UAT
requires an authenticated user response" — a block independent of the `pass`
verdict.

This is a separate defect from issue #223 (fixed in PR
https://github.com/eagle27272/gsd-pi/pull/226).

### Confirmed live state

`~/.gsd/projects/73f412255a8f/gsd.db` (project `entity-services-entity-service`),
Milestone M003, lifecycle `1447a6e2-7555-4658-b853-c17247e9e30f`, inspected via a
copy at `/tmp/m003.db`. All five subjective criteria share one
`testedSourceRevision`, `sha256:520ada175bb8c98d3b7d2fed2c5afe5b59939219bb7265fc3008b16af2eedac7`:

| rev | criterion | key | superseded by | acceptances |
|---|---|---|---|---|
| 261 | `51b841f0` | `developer-owns-domain-types-in-repo` | `c2fd564e` | 0 |
| 262 | `c2fd564e` | `developer-owns-domain-types-in-repo` | `3dee6b2e` | 0 |
| 263 | `3dee6b2e` | `developer-owns-domain-types-in-repo` | — **head** | 0 |
| 264 | `b31bcce4` | `m003-developer-owns-domain-types-single-pr` | — **head** | 0 |
| 265 | `892bd13b` | `developer-single-pr-domain-change` | — **head** | 2 (head accepted) |

The first key superseded itself correctly three times. The agent then rephrased
the key twice, opening two more independent chains. Questions `23c639d1` (on
`3dee6b2e`) and `a5aa9049` (on `b31bcce4`) remain open.

### Scope correction

M003 is recoverable today without new code: re-`prepare` each stranded key with a
changed description — a changed description is needed to dodge the
`Subjective UAT criterion already has an open question` guard — and have the user
answer all three. So the accurate characterisation is not "permanent deadlock"
but "forces redundant human answers to degenerate questions". Question
`a5aa9049` literally asks the user to judge an end-user-facing surface that the
same text says planning recorded as nonexistent. The defect is real; this
framing is what makes retirement worth building rather than merely convenient.

## Constraints

`workflow_acceptance_criteria` is append-only:
`trg_workflow_criterion_immutable_update` and
`trg_workflow_criterion_immutable_delete` both `RAISE(ABORT)`. Supersession is
the only mutation path, and `trg_workflow_criterion_supersession`
(`src/resources/extensions/gsd/db-recovery-evidence-foundation-schema.ts:360`)
requires a successor to carry the same `criterion_key`, `requirement_id`, and
`criterion_kind` as its predecessor, with a strictly greater `project_revision`.

Two consequences bound the design:

- Cross-key supersession — modelling "this rephrase replaces that criterion" —
  requires a schema migration to relax that trigger.
- Supersession chains cannot merge. No amount of prevention retro-fixes a
  lifecycle that already carries several heads, so recovery needs a capability
  that makes a head non-required.

The tool surface is registered in three places. `packages/mcp-server/src/workflow-tools.test.ts:384`
asserts the MCP server's tool count equals the `packages/contracts` registry
length, so a new tool that lands in only one or two of them fails that test.

## Decisions

1. **Retirement is human-authorized**, not agent-callable. The integrity
   property subjective UAT exists to protect is that an agent cannot decide
   subjective acceptance on the user's behalf; a freely agent-callable retire
   verb would punch a hole in exactly that.
2. **Prevention rejects the stranding prepare**, with no migration. A prepare
   that would start a new required chain while an unanswered required chain
   already exists throws and names the key to reuse.
3. **Eligibility excludes rejected criteria.** A rejection is the user saying
   the work is not good enough; the sanctioned response is fix-and-re-ask under
   the same `criterionKey`. Without this guard an agent could route around a
   rejection by asking the user to retire it instead.
4. **The user-authority check is TypeScript-only.** Acceptance is backed by
   `trg_workflow_human_acceptance_scope`, which checks
   `operation.actor_type = 'user'` at the DB layer. The equivalent for
   retirement would have to live on `workflow_acceptance_criteria` — DDL, and so
   a migration. Accepted as one layer thinner than acceptance in exchange for
   staying migration-free.

## Design

### Data model

A retirement inserts one `workflow_acceptance_criteria` row carrying the same
`criterion_key`, `requirement_id`, `criterion_kind`, `evidence_class`, and
`description` as its predecessor, with `required = 0` and
`supersedes_criterion_id` set to the retired head. That satisfies
`trg_workflow_criterion_supersession` unchanged.

Because both gates already filter `required = 1 AND NOT EXISTS successor`, the
retired chain drops out of `currentRequiredSubjectiveProofs` and
`currentCriteria` with no query changes. Existing acceptances, answers, and
events are untouched; the audit trail stays append-only.

Retirement also withdraws every open question in the retired chain, using the
same event-joined query shape as `reconcileOpenQuestions`. This is what clears
the auto-verification block.

Retirement carries no `testedSourceRevision`. A duplicate criterion is a
modelling error, not a judgment about a build, so a later build must not
resurrect it.

### Operations

| step | tool | operation type | event type | actor |
|---|---|---|---|---|
| 1 | `gsd_prepare_milestone_subjective_uat_retirement` | `milestone.subjective-uat.prepare-retirement` | `milestone.subjective-uat.retirement-prepared` | agent |
| 2 | `gsd_retire_milestone_subjective_uat` | `milestone.subjective-uat.retire` | `milestone.subjective-uat.retired` or `milestone.subjective-uat.retirement-declined` | user |

Both follow the existing `executeDomainOperation` shape in
`milestone-subjective-uat-domain-operation.ts`: a `readDomainOperationFence`
fence, a writer call inside the operation callback, a stored-receipt reader for
replay, and a `milestone-subjective-uat` projection keyed
`subjective-uat/<milestoneId>/<questionId>`.

**Step 1** takes `criterionId` and `rationale`. It validates eligibility, then
creates a `workflow_open_questions` row plus a `workflow_interactions` row with
`interaction_kind = 'consent'` — already permitted by the CHECK at
`src/resources/extensions/gsd/db-conversation-foundation-schema.ts:178`, so no
migration — `requires_answer = 1`, `option_count = 2`, and two
`workflow_interaction_options` rows:

- **Retire** — always the recommended option, since the agent only asks because
  it believes the criterion is obsolete. There is no `recommendedDisposition`
  parameter.
- **Keep**

`recommendation_text` and `recommendation_rationale` must be non-blank when
`requires_answer = 1`, per the table CHECK; the writer supplies both.

Using `consent` rather than `subjective-uat` is deliberate:
`hasPendingMilestoneSubjectiveUat` filters on
`interaction_kind = 'subjective-uat'`, so a pending retirement does not invent a
new auto-mode pause class. The stranded criterion's own open question already
parks auto mode, so nothing is lost.

**Step 2** takes `criterionId`, `questionId`, `interactionId`,
`selectedOptionId`, `verbatimResponse`, and `rationale`. It reuses the answer
path's guards: the binding must match the `retirement-prepared` event, the
question must still be `open`, the interaction must be `presented`, and
`verbatimResponse` must equal the selected option's label character for
character. It rejects `invocation.actorType !== "user"`.

Selecting **Retire** inserts the `required = 0` successor, withdraws the chain's
open questions, writes the `workflow_answers` row with
`answer_disposition = 'accepted'` (the table's CHECK permits only `'accepted'`
and `'revision-conflict'`; this records that the answer was accepted as an
answer, exactly as the subjective-UAT path uses it), sets the question to
`answered`, and emits `…retired`.

Selecting **Keep** records the answer and closes the question without retiring,
and emits `…retirement-declined`. The user can decline.

### Eligibility

Checked at step 1 and re-checked at step 2, since revisions can interleave:

- the criterion is the current head, `criterion_kind = 'subjective_uat'`, and
  `required = 1`
- the Milestone lifecycle is `ready` or `in_progress`
- the head `workflow_human_acceptances` row, if any, is not `rejected` —
  otherwise throw `Retire cannot clear a rejected subjective UAT criterion;
  re-prepare it under the same criterionKey after remediation.`

There is no last-criterion guard. Under human authority, dropping the only gate
is the user's call.

### Prevention

In `ensureSubjectiveCriterion`, before inserting: when the prepare would start a
new chain — no current criterion for this `criterionKey` plus `requirementId` —
and `input.required` is true, and the lifecycle already has a current
`subjective_uat` criterion with `required = 1` and zero `workflow_human_acceptances`
rows ever, throw:

```
Milestone lifecycle already has an unanswered required subjective UAT criterion
<id> with key '<key>'. Reuse that criterionKey to rephrase it, or retire it first.
```

Scoping the check to new chains is what keeps rephrasing under the same key
working: that path is supersession, and its head has zero acceptances by
definition in the stranded case. `required: false` is exempt, since a
non-required criterion cannot strand a pass verdict.

The "zero acceptances ever" test is deliberately revision-agnostic. A criterion
answered against an older source revision has an acceptance and so does not
block a new chain; only the never-answered state does.

Replayed against M003's history, the guard fires exactly where it should:

| rev | key | outcome |
|---|---|---|
| 261 | `developer-owns-domain-types-in-repo` | new chain, no other required criterion — allowed |
| 262, 263 | same key | supersession — allowed |
| 264 | `m003-developer-owns-domain-types-single-pr` | new chain while `3dee6b2e` is unanswered — **blocked** |
| 265 | `developer-single-pr-domain-change` | new chain while `3dee6b2e` is unanswered — **blocked** |

## Recovery for M003

The new capability is the recovery path; no script and no migration. Live gsd
runs the main checkout's dist, so this applies once the branch merges and main
is rebuilt. In the live session, for each of `3dee6b2e-870c-4a77-a427-70e4ceaa4294`
and `b31bcce4-bf19-4826-b5fd-76b01b69e4e5`:

1. `gsd_prepare_milestone_subjective_uat_retirement` with rationale
   "duplicate of the criterion accepted as `892bd13b-d228-47cd-8993-5d12c3768884`"
2. present the two options, and on the user choosing Retire, call
   `gsd_retire_milestone_subjective_uat`

M003 is then left with one current required subjective criterion, `892bd13b`,
accepted at `sha256:520ada17…`; questions `23c639d1` and `a5aa9049` withdrawn;
`hasPendingMilestoneSubjectiveUat("M003")` false; and
`validateMilestone(verdict: "pass", testedSourceRevision: "sha256:520ada17…")`
succeeding.

Step 2 requires an authenticated user session identity, so the live recovery is
run by the user, not by the implementing agent. Verification before that is a
dry run against the `/tmp/m003.db` copy plus a regression test reproducing the
same criterion shape. Live state is not written to during implementation.

## Files

| file | change |
|---|---|
| `src/resources/extensions/gsd/db/writers/milestone-subjective-uat.ts` | prevention guard in `ensureSubjectiveCriterion`; two retirement writers |
| `src/resources/extensions/gsd/milestone-subjective-uat-domain-operation.ts` | two domain operations, receipts, stored-receipt replay readers |
| `src/resources/extensions/gsd/tools/workflow-tool-executors.ts` | two executors and a retirement result formatter |
| `src/resources/extensions/gsd/bootstrap/db-tools.ts` | two Pi tool registrations; the retire tool reads `actorId` from the session as `gsd_answer_milestone_subjective_uat` does |
| `packages/contracts/src/workflow.ts` | two registry entries |
| `packages/mcp-server/src/workflow-tools.ts` | two MCP tools, zod schemas, handlers; retire uses `mcpUserResponseInvocation` |
| `packages/mcp-server/README.md` | tool list and the idempotency-key paragraph |
| `docs/db-map.md`, `docs/prompt-db-combined-map.md` | tool rows |

## Testing

Test-driven, red first. Unit tests extend
`src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts`
and `src/resources/extensions/gsd/tests/milestone-validation-domain-operation.test.ts`.

- prepare throws when it would start a second unanswered required chain
- prepare still allows rephrasing under the same `criterionKey`
- prepare with `required: false` is exempt from the guard
- prepare is allowed when the existing required criterion has an acceptance
- retirement happy path: `required = 0` successor, chain questions withdrawn
- Keep declines: question answered, no successor inserted
- rejected-criterion guard throws with the remediation message
- non-head criterion is refused
- `validateMilestone(verdict: "pass")` succeeds after retirement
- closeout readiness ignores the retired criterion
- replay idempotency for both new operations
- regression reproducing M003's three-key shape: pass blocked, retire two
  criteria, pass succeeds

Build before running tests: contracts, pi, rpc-client, mcp-server, then
`node native/scripts/build.js --dev --test-fault-injection`, then `build:core`.
The full unit suite is green at 14378 passed with `--test-concurrency=8`.

## Out of scope

`prepare` with `required: false` still creates an open question that nothing
answers, leaving `hasPendingMilestoneSubjectiveUat` true and auto mode parked.
That is a pre-existing hole on a path this change does not touch, and it is
noted here rather than fixed.
