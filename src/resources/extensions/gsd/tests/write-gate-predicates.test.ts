// gsd-pi — write-gate predicate coverage (#4950).
//
// Covers five predicates that had no dedicated tests:
//   shouldBlockQueueExecution, shouldBlockPendingGate,
//   shouldBlockPendingGateBash, shouldBlockContextWrite,
//   shouldBlockContextArtifactSave.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// The write-gate snapshot is a file under <basePath>/.gsd/runtime/. Every test
// file runs in its own process but shares one cwd (the repo root), so a
// cwd-based basePath would make all of them read and write the SAME snapshot:
// a peer's verified milestone makes hostWriteGateAdapter.setPending refuse to
// arm ("verified wins over pending"), and this file's gate assertions flake
// under concurrency. Own the basePath instead, and pass it to every predicate.
// realpathSync normalizes the macOS /var → /private/var symlink so the key
// matches the resolved snapshot root.
const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'gsd-write-gate-predicates-')));

after(() => {
  clearDiscussionFlowState(BASE);
  rmSync(BASE, { recursive: true, force: true });
});

// ─── shouldBlockQueueExecution ────────────────────────────────────────────
//
// shouldBlockQueueExecution takes queuePhaseActive explicitly (its snapshot is
// only the fallback for that argument), so these cases assert on the argument.
// setQueuePhaseActive still runs against BASE to exercise the persistence path
// without writing the shared repo-root snapshot.

test('shouldBlockQueueExecution: queue inactive → allow write to user source', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  setQueuePhaseActive(false, BASE);
  const r = shouldBlockQueueExecution('write', 'src/main.ts', false);
  assert.strictEqual(r.block, false);
});

test('shouldBlockQueueExecution: queue active → block write to user source', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  setQueuePhaseActive(true, BASE);
  const r = shouldBlockQueueExecution('write', 'src/main.ts', true);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason);
});

test('shouldBlockQueueExecution: queue active → allow write to .gsd/ path', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  setQueuePhaseActive(true, BASE);
  const r = shouldBlockQueueExecution('write', '.gsd/milestones/M001/M001-CONTEXT.md', true);
  assert.strictEqual(r.block, false);
});

test('shouldBlockQueueExecution: queue active → block mutating bash', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  setQueuePhaseActive(true, BASE);
  const r = shouldBlockQueueExecution('bash', 'npm run build', true);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason);
});

test('shouldBlockQueueExecution: queue active → allow read-only bash', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  setQueuePhaseActive(true, BASE);
  const r = shouldBlockQueueExecution('bash', 'git log --oneline -5', true);
  assert.strictEqual(r.block, false);
});

// ─── shouldBlockPendingGate ───────────────────────────────────────────────

test('shouldBlockPendingGate: no pending gate → allow any tool', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  clearPendingGate(BASE);
  const r = shouldBlockPendingGate('write', 'M001', undefined, BASE);
  assert.strictEqual(r.block, false);
});

test('shouldBlockPendingGate: pending gate → block write', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  assert.ok(setPendingGate('depth_verification_M001', BASE), 'gate must arm');
  const r = shouldBlockPendingGate('write', 'M001', undefined, BASE);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason?.includes('depth_verification_M001'));
});

test('shouldBlockPendingGate: pending gate → allow ask_user_questions', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  assert.ok(setPendingGate('depth_verification_M001', BASE), 'gate must arm');
  const r = shouldBlockPendingGate('ask_user_questions', 'M001', undefined, BASE);
  assert.strictEqual(r.block, false);
});

test('shouldBlockPendingGate: pending gate → block read so approval question stays visible', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  assert.ok(setPendingGate('depth_verification_M001', BASE), 'gate must arm');
  const r = shouldBlockPendingGate('read', 'M001', undefined, BASE);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason?.includes('already asked for user confirmation'));
});

// ─── shouldBlockPendingGateBash ───────────────────────────────────────────

test('shouldBlockPendingGateBash: no pending gate → allow mutating bash', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  clearPendingGate(BASE);
  const r = shouldBlockPendingGateBash('npm run build', 'M001', undefined, BASE);
  assert.strictEqual(r.block, false);
});

test('shouldBlockPendingGateBash: pending gate → block mutating bash', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  assert.ok(setPendingGate('depth_verification_M001', BASE), 'gate must arm');
  const r = shouldBlockPendingGateBash('npm run build', 'M001', undefined, BASE);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason?.includes('depth_verification_M001'));
});

test('shouldBlockPendingGateBash: pending gate → block read-only bash (cat)', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  assert.ok(setPendingGate('depth_verification_M001', BASE), 'gate must arm');
  const r = shouldBlockPendingGateBash('cat README.md', 'M001', undefined, BASE);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason?.includes('already asked for user confirmation'));
});

test('shouldBlockPendingGateBash: pending gate → block read-only bash (git log)', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  assert.ok(setPendingGate('depth_verification_M001', BASE), 'gate must arm');
  const r = shouldBlockPendingGateBash('git log --oneline -10', 'M001', undefined, BASE);
  assert.strictEqual(r.block, true);
});

// ─── shouldBlockContextWrite ──────────────────────────────────────────────

test('shouldBlockContextWrite: non-write tool → allow', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  const r = shouldBlockContextWrite('read', '.gsd/milestones/M001/M001-CONTEXT.md', 'M001', undefined, BASE);
  assert.strictEqual(r.block, false);
});

test('shouldBlockContextWrite: write to non-CONTEXT file → allow', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  const r = shouldBlockContextWrite('write', 'src/index.ts', 'M001', undefined, BASE);
  assert.strictEqual(r.block, false);
});

test('shouldBlockContextWrite: write to CONTEXT.md without verification → block', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  const r = shouldBlockContextWrite('write', '.gsd/milestones/M007/M007-CONTEXT.md', 'M007', undefined, BASE);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason);
});

test('shouldBlockContextWrite: write to CONTEXT.md after verification → allow', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  markDepthVerified('M008', BASE);
  const r = shouldBlockContextWrite('write', '.gsd/milestones/M008/M008-CONTEXT.md', 'M008', undefined, BASE);
  assert.strictEqual(r.block, false);
});

// ─── shouldBlockContextArtifactSave ───────────────────────────────────────

test('shouldBlockContextArtifactSave: non-CONTEXT artifact type → allow', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  const r = shouldBlockContextArtifactSave('CONTEXT-DRAFT', 'M001', null, BASE);
  assert.strictEqual(r.block, false);
});

test('shouldBlockContextArtifactSave: slice-level CONTEXT → allow', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  const r = shouldBlockContextArtifactSave('CONTEXT', 'M001', 'S01', BASE);
  assert.strictEqual(r.block, false);
});

test('shouldBlockContextArtifactSave: milestone CONTEXT without verification → block', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  const r = shouldBlockContextArtifactSave('CONTEXT', 'M009', null, BASE);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason?.includes('M009'));
});

test('shouldBlockContextArtifactSave: milestone CONTEXT after verification → allow', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  markDepthVerified('M010', BASE);
  const r = shouldBlockContextArtifactSave('CONTEXT', 'M010', null, BASE);
  assert.strictEqual(r.block, false);
});

test('shouldBlockContextArtifactSave: CONTEXT with no milestoneId → block', (t) => {
  t.after(() => clearDiscussionFlowState(BASE));
  const r = shouldBlockContextArtifactSave('CONTEXT', null, null, BASE);
  assert.strictEqual(r.block, true);
  assert.ok(r.reason);
});
