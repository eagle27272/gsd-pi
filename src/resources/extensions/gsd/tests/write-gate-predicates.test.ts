// gsd-pi — write-gate predicate coverage (#4950).
//
// Covers five predicates that had no dedicated tests:
//   shouldBlockQueueExecution, shouldBlockPendingGate,
//   shouldBlockPendingGateBash, shouldBlockContextWrite,
//   shouldBlockContextArtifactSave.

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  shouldBlockQueueExecution,
  shouldBlockPendingGate,
  shouldBlockPendingGateBash,
  shouldBlockContextWrite,
  shouldBlockContextArtifactSave,
  setQueuePhaseActive,
  setPendingGate,
  clearPendingGate,
  markDepthVerified,
  clearDiscussionFlowState,
} from '../bootstrap/write-gate.ts';

/**
 * Gate state persists to `<basePath>/.gsd/runtime/`, so tests keyed on
 * process.cwd() all share the repo's single state file. Process isolation
 * gives each test file its own process but not its own state: whichever file
 * clears first wipes another file's setup mid-test. Every test gets a private
 * base path instead.
 *
 * The pending-gate cases below assert setPendingGate's return value because a
 * shared base failed silently: the host adapter reconciles the disk snapshot
 * before arming and then refuses to arm a gate whose milestone another process
 * had already verified ("verified wins over pending"), so setPendingGate
 * returned false and the block assertion failed three lines later instead of
 * at the arm.
 */
function gateBase(t: TestContext): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-write-gate-predicates-'));
  t.after(() => {
    clearDiscussionFlowState(base);
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

// ─── shouldBlockQueueExecution ────────────────────────────────────────────

test('shouldBlockQueueExecution: queue inactive → allow write to user source', (t) => {
  setQueuePhaseActive(false, gateBase(t));
  const r = shouldBlockQueueExecution('write', 'src/main.ts', false);
  assert.strictEqual(r.block, false);
});

test('shouldBlockQueueExecution: queue active → block write to user source', (t) => {
  setQueuePhaseActive(true, gateBase(t));
  const r = shouldBlockQueueExecution('write', 'src/main.ts', true);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason);
});

test('shouldBlockQueueExecution: queue active → allow write to .gsd/ path', (t) => {
  setQueuePhaseActive(true, gateBase(t));
  const r = shouldBlockQueueExecution('write', '.gsd/milestones/M001/M001-CONTEXT.md', true);
  assert.strictEqual(r.block, false);
});

test('shouldBlockQueueExecution: queue active → block mutating bash', (t) => {
  setQueuePhaseActive(true, gateBase(t));
  const r = shouldBlockQueueExecution('bash', 'npm run build', true);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason);
});

test('shouldBlockQueueExecution: queue active → allow read-only bash', (t) => {
  setQueuePhaseActive(true, gateBase(t));
  const r = shouldBlockQueueExecution('bash', 'git log --oneline -5', true);
  assert.strictEqual(r.block, false);
});

// ─── shouldBlockPendingGate ───────────────────────────────────────────────

test('shouldBlockPendingGate: no pending gate → allow any tool', (t) => {
  const base = gateBase(t);
  clearPendingGate(base);
  const r = shouldBlockPendingGate('write', 'M001', undefined, base);
  assert.strictEqual(r.block, false);
});

test('shouldBlockPendingGate: pending gate → block write', (t) => {
  const base = gateBase(t);
  assert.ok(setPendingGate('depth_verification_M001', base), 'gate must arm');
  const r = shouldBlockPendingGate('write', 'M001', undefined, base);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason?.includes('depth_verification_M001'));
});

test('shouldBlockPendingGate: pending gate → allow ask_user_questions', (t) => {
  const base = gateBase(t);
  assert.ok(setPendingGate('depth_verification_M001', base), 'gate must arm');
  const r = shouldBlockPendingGate('ask_user_questions', 'M001', undefined, base);
  assert.strictEqual(r.block, false);
});

test('shouldBlockPendingGate: pending gate → block read so approval question stays visible', (t) => {
  const base = gateBase(t);
  assert.ok(setPendingGate('depth_verification_M001', base), 'gate must arm');
  const r = shouldBlockPendingGate('read', 'M001', undefined, base);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason?.includes('already asked for user confirmation'));
});

// ─── shouldBlockPendingGateBash ───────────────────────────────────────────

test('shouldBlockPendingGateBash: no pending gate → allow mutating bash', (t) => {
  const base = gateBase(t);
  clearPendingGate(base);
  const r = shouldBlockPendingGateBash('npm run build', 'M001', undefined, base);
  assert.strictEqual(r.block, false);
});

test('shouldBlockPendingGateBash: pending gate → block mutating bash', (t) => {
  const base = gateBase(t);
  assert.ok(setPendingGate('depth_verification_M001', base), 'gate must arm');
  const r = shouldBlockPendingGateBash('npm run build', 'M001', undefined, base);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason?.includes('depth_verification_M001'));
});

test('shouldBlockPendingGateBash: pending gate → block read-only bash (cat)', (t) => {
  const base = gateBase(t);
  assert.ok(setPendingGate('depth_verification_M001', base), 'gate must arm');
  const r = shouldBlockPendingGateBash('cat README.md', 'M001', undefined, base);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason?.includes('already asked for user confirmation'));
});

test('shouldBlockPendingGateBash: pending gate → block read-only bash (git log)', (t) => {
  const base = gateBase(t);
  assert.ok(setPendingGate('depth_verification_M001', base), 'gate must arm');
  const r = shouldBlockPendingGateBash('git log --oneline -10', 'M001', undefined, base);
  assert.strictEqual(r.block, true);
});

// ─── shouldBlockContextWrite ──────────────────────────────────────────────

test('shouldBlockContextWrite: non-write tool → allow', (t) => {
  const r = shouldBlockContextWrite('read', '.gsd/milestones/M001/M001-CONTEXT.md', 'M001', undefined, gateBase(t));
  assert.strictEqual(r.block, false);
});

test('shouldBlockContextWrite: write to non-CONTEXT file → allow', (t) => {
  const r = shouldBlockContextWrite('write', 'src/index.ts', 'M001', undefined, gateBase(t));
  assert.strictEqual(r.block, false);
});

test('shouldBlockContextWrite: write to CONTEXT.md without verification → block', (t) => {
  const r = shouldBlockContextWrite('write', '.gsd/milestones/M007/M007-CONTEXT.md', 'M007', undefined, gateBase(t));
  assert.strictEqual(r.block, true);
  assert.ok(r.reason);
});

test('shouldBlockContextWrite: write to CONTEXT.md after verification → allow', (t) => {
  const base = gateBase(t);
  markDepthVerified('M008', base);
  const r = shouldBlockContextWrite('write', '.gsd/milestones/M008/M008-CONTEXT.md', 'M008', undefined, base);
  assert.strictEqual(r.block, false);
});

test('shouldBlockContextWrite: flat-phase CONTEXT write without verification → block', (t) => {
  t.after(() => clearDiscussionFlowState(process.cwd()));
  const r = shouldBlockContextWrite('write', '.gsd/phases/11-m011/11-CONTEXT.md', 'M011');
  assert.strictEqual(r.block, true);
  assert.ok(r.reason?.includes('depth_verification_M011_confirm'));
});

test('shouldBlockContextWrite: absolute flat-phase CONTEXT write without verification → block', (t) => {
  t.after(() => clearDiscussionFlowState(process.cwd()));
  const r = shouldBlockContextWrite('write', '/srv/app/.gsd/phases/12-m012/12-CONTEXT.md', 'M012');
  assert.strictEqual(r.block, true);
  assert.ok(r.reason);
});

test('shouldBlockContextWrite: flat-phase CONTEXT write after verification → allow', (t) => {
  t.after(() => clearDiscussionFlowState(process.cwd()));
  markDepthVerified('M013');
  assert.strictEqual(
    shouldBlockContextWrite('write', '.gsd/phases/13-m013/13-CONTEXT.md', 'M013').block,
    false,
  );
  assert.strictEqual(
    shouldBlockContextWrite('write', '/srv/app/.gsd/phases/13-m013/13-CONTEXT.md', 'M013').block,
    false,
  );
});

test('shouldBlockContextWrite: flat-phase slice CONTEXT (NN-MM) → allow', (t) => {
  t.after(() => clearDiscussionFlowState(process.cwd()));
  const r = shouldBlockContextWrite('write', '.gsd/phases/14-m014/14-01-CONTEXT.md', 'M014');
  assert.strictEqual(r.block, false);
});

// ─── shouldBlockContextArtifactSave ───────────────────────────────────────

test('shouldBlockContextArtifactSave: non-CONTEXT artifact type → allow', (t) => {
  const r = shouldBlockContextArtifactSave('CONTEXT-DRAFT', 'M001', null, gateBase(t));
  assert.strictEqual(r.block, false);
});

test('shouldBlockContextArtifactSave: slice-level CONTEXT → allow', (t) => {
  const r = shouldBlockContextArtifactSave('CONTEXT', 'M001', 'S01', gateBase(t));
  assert.strictEqual(r.block, false);
});

test('shouldBlockContextArtifactSave: milestone CONTEXT without verification → block', (t) => {
  const r = shouldBlockContextArtifactSave('CONTEXT', 'M009', null, gateBase(t));
  assert.strictEqual(r.block, true);
  assert.ok(r.reason?.includes('M009'));
});

test('shouldBlockContextArtifactSave: milestone CONTEXT after verification → allow', (t) => {
  const base = gateBase(t);
  markDepthVerified('M010', base);
  const r = shouldBlockContextArtifactSave('CONTEXT', 'M010', null, base);
  assert.strictEqual(r.block, false);
});

test('shouldBlockContextArtifactSave: CONTEXT with no milestoneId → block', (t) => {
  const r = shouldBlockContextArtifactSave('CONTEXT', null, null, gateBase(t));
  assert.strictEqual(r.block, true);
  assert.ok(r.reason);
});
