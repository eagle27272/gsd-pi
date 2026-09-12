/**
 * worktree-sync-milestones.test.ts — Regression tests for #1311 and #1678.
 *
 * Verifies that syncProjectRootToWorktree copies milestone artifacts
 * from the main repo's .gsd/ into the worktree's .gsd/ for the
 * specified milestone, and deletes gsd.db so it rebuilds from fresh state.
 *
 * Also verifies that syncWorktreeStateBack does not import worktree markdown
 * projections back into the project root.
 *
 * Covers:
 *   - Milestone directory synced from main to worktree
 *   - Missing slices within a milestone are synced
 *   - gsd.db deleted in worktree after sync
 *   - No-op when paths are equal
 *   - No-op when milestoneId is null
 *   - Non-existent directories handled gracefully
 *   - syncWorktreeStateBack skips milestone markdown projections
 *   - syncWorktreeStateBack does not import root-level .gsd/ state projections
 *   - syncWorktreeStateBack does not copy worktree milestone projections back
 *   - syncWorktreeStateBack leaves next-milestone projections DB/project-root authoritative
 *   - syncGsdStateToWorktree syncs non-standard milestone dir names (#1547)
 *   - syncWorktreeStateBack skips non-standard milestone projection dir names
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  syncGsdStateToWorktree,
  syncProjectRootToWorktree,
  syncWorktreeStateBack,
} from '../auto-worktree-sync.ts';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';


function createBase(name: string): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-wt-sync-${name}-`));
  mkdirSync(join(base, '.gsd', 'phases'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

describe('worktree-sync-milestones', async () => {

  // ─── 1. Milestone directory synced from main to worktree ──────────────
  console.log('\n=== 1. milestone directory synced from main to worktree ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'phases', '01-m001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, '01-CONTEXT.md'), '# M001\nContext.');
      writeFileSync(join(m001Dir, '01-ROADMAP.md'), '# Roadmap');

      // Worktree has no M001
      assert.ok(!existsSync(join(wtBase, '.gsd', 'phases', '01-m001')), 'M001 missing before sync');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assert.ok(existsSync(join(wtBase, '.gsd', 'phases', '01-m001')), '#1311: M001 synced to worktree');
      assert.ok(existsSync(join(wtBase, '.gsd', 'phases', '01-m001', '01-CONTEXT.md')), 'M001 CONTEXT synced');
      assert.ok(existsSync(join(wtBase, '.gsd', 'phases', '01-m001', '01-ROADMAP.md')), 'M001 ROADMAP synced');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 2. Missing slices synced ──────────────────────────────────────────
  console.log('\n=== 2. missing slices within milestone are synced ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'phases', '01-m001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, '01-ROADMAP.md'), '# Roadmap');
      writeFileSync(join(m001Dir, '01-01-PLAN.md'), '# S01 Plan');
      writeFileSync(join(m001Dir, '01-02-PLAN.md'), '# S02 Plan');

      // Worktree only has S01
      const wtM001Dir = join(wtBase, '.gsd', 'phases', '01-m001');
      mkdirSync(wtM001Dir, { recursive: true });
      writeFileSync(join(wtM001Dir, '01-01-PLAN.md'), '# S01 Plan');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assert.ok(existsSync(join(wtBase, '.gsd', 'phases', '01-m001')), '#1311: S02 synced');
      assert.ok(existsSync(join(wtBase, '.gsd', 'phases', '01-m001', '01-02-PLAN.md')), 'S02 PLAN synced');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 3. empty gsd.db deleted in worktree after sync ────────────────────
  console.log('\n=== 3. empty gsd.db deleted in worktree after sync ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'phases', '01-m001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, '01-ROADMAP.md'), '# Roadmap');

      // Worktree has an empty (0-byte) gsd.db — stale/corrupt
      writeFileSync(join(wtBase, '.gsd', 'gsd.db'), '');
      assert.ok(existsSync(join(wtBase, '.gsd', 'gsd.db')), 'gsd.db exists before sync');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assert.ok(!existsSync(join(wtBase, '.gsd', 'gsd.db')), '#853: empty gsd.db deleted after sync');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 3b. non-empty gsd.db preserved in worktree after sync (#2815) ───
  console.log('\n=== 3b. non-empty gsd.db preserved in worktree after sync (#2815) ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const m001Dir = join(mainBase, '.gsd', 'phases', '01-m001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, '01-ROADMAP.md'), '# Roadmap');

      // Worktree has a populated gsd.db (e.g. from gsd-migrate on respawn)
      writeFileSync(join(wtBase, '.gsd', 'gsd.db'), 'migrated-db-content');
      assert.ok(existsSync(join(wtBase, '.gsd', 'gsd.db')), 'gsd.db exists before sync');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      assert.ok(existsSync(join(wtBase, '.gsd', 'gsd.db')), '#2815: non-empty gsd.db preserved after sync');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 3c. artifact file/dir collisions preserve existing worktree files ─
  console.log('\n=== 3c. artifact file/dir collisions preserve existing worktree files (#1157) ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      const mainSliceDir = join(mainBase, '.gsd', 'phases', '01-m001');
      mkdirSync(join(mainSliceDir, '01-01-SUMMARY.md'), { recursive: true });
      mkdirSync(join(mainSliceDir, '01-01-ASSESSMENT.md'), { recursive: true });

      const wtSliceDir = join(wtBase, '.gsd', 'phases', '01-m001');
      mkdirSync(wtSliceDir, { recursive: true });
      writeFileSync(join(wtSliceDir, '01-01-SUMMARY.md'), '# Valid summary\n');
      writeFileSync(join(wtSliceDir, '01-01-ASSESSMENT.md'), '---\nverdict: pass\n---\n# Valid assessment\n');

      syncProjectRootToWorktree(mainBase, wtBase, 'M001');

      const summaryPath = join(wtSliceDir, '01-01-SUMMARY.md');
      const assessmentPath = join(wtSliceDir, '01-01-ASSESSMENT.md');
      assert.ok(statSync(summaryPath).isFile(), 'existing SUMMARY.md stays a file');
      assert.ok(statSync(assessmentPath).isFile(), 'existing ASSESSMENT.md stays a file');
      assert.equal(readFileSync(summaryPath, 'utf-8'), '# Valid summary\n');
      assert.equal(readFileSync(assessmentPath, 'utf-8'), '---\nverdict: pass\n---\n# Valid assessment\n');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 4. No-op when paths are equal ────────────────────────────────────
  console.log('\n=== 4. no-op when paths are equal ===');
  {
    const base = createBase('same');
    try {
      // Should not throw
      syncProjectRootToWorktree(base, base, 'M001');
      assert.ok(true, 'no crash when paths are equal');
    } finally {
      cleanup(base);
    }
  }

  // ─── 5. No-op when milestoneId is null ────────────────────────────────
  console.log('\n=== 5. no-op when milestoneId is null ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');
    try {
      syncProjectRootToWorktree(mainBase, wtBase, null);
      assert.ok(true, 'no crash when milestoneId is null');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 6. Non-existent directories handled gracefully ───────────────────
  console.log('\n=== 6. non-existent directories → no-op ===');
  {
    syncProjectRootToWorktree('/tmp/does-not-exist-main', '/tmp/does-not-exist-wt', 'M001');
    assert.ok(true, 'no crash on missing directories');
  }

  // ─── 7. milestones/ directory created in worktree when missing ────────
  console.log('\n=== 7. milestones/ directory created in worktree when missing ===');
  {
    const mainBase = createBase('main');
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-sync-wt-'));

    try {
      // Worktree has .gsd/ but NO milestones/ subdirectory
      mkdirSync(join(wtBase, '.gsd'), { recursive: true });

      // Main repo has M001
      const m001Dir = join(mainBase, '.gsd', 'phases', '01-m001');
      mkdirSync(m001Dir, { recursive: true });
      writeFileSync(join(m001Dir, '01-CONTEXT.md'), '# M001 Context');
      writeFileSync(join(m001Dir, '01-ROADMAP.md'), '# M001 Roadmap');

      assert.ok(!existsSync(join(wtBase, '.gsd', 'phases')), 'milestones/ missing before sync');

      const result = syncGsdStateToWorktree(mainBase, wtBase);

      assert.ok(existsSync(join(wtBase, '.gsd', 'phases')), 'milestones/ created in worktree');
      assert.ok(existsSync(join(wtBase, '.gsd', 'phases', '01-m001')), 'M001 synced to worktree');
      assert.ok(existsSync(join(wtBase, '.gsd', 'phases', '01-m001', '01-CONTEXT.md')), 'M001 CONTEXT synced');
      assert.ok(existsSync(join(wtBase, '.gsd', 'phases', '01-m001', '01-ROADMAP.md')), 'M001 ROADMAP synced');
      assert.ok(result.synced.length > 0, 'sync reported files');
    } finally {
      cleanup(mainBase);
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 7b. flat-phase sync skips empty legacy milestones root ───────────
  console.log('\n=== 7b. flat-phase sync skips empty legacy milestones root ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-sync-flat-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-sync-flat-wt-'));

    try {
      const phaseDir = join(mainBase, '.gsd', 'phases', '01-foundation');
      mkdirSync(phaseDir, { recursive: true });
      mkdirSync(join(mainBase, '.gsd', 'milestones'), { recursive: true });
      mkdirSync(join(wtBase, '.gsd'), { recursive: true });
      writeFileSync(join(phaseDir, '01-CONTEXT.md'), '# Foundation\n');

      syncGsdStateToWorktree(mainBase, wtBase);

      assert.ok(
        existsSync(join(wtBase, '.gsd', 'phases', '01-foundation', '01-CONTEXT.md')),
        'flat-phase artifact is synced to worktree',
      );
      assert.ok(
        !existsSync(join(wtBase, '.gsd', 'milestones')),
        'empty legacy milestones/ root is not recreated in worktree',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 7c. flat-phase sync skips metadata-only legacy milestone dirs ────
  console.log('\n=== 7c. flat-phase sync skips metadata-only legacy milestone dirs ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-sync-flat-meta-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-sync-flat-meta-wt-'));

    try {
      const phaseDir = join(mainBase, '.gsd', 'phases', '01-foundation');
      const metaDir = join(mainBase, '.gsd', 'milestones', 'M001');
      mkdirSync(phaseDir, { recursive: true });
      mkdirSync(metaDir, { recursive: true });
      mkdirSync(join(wtBase, '.gsd'), { recursive: true });
      writeFileSync(join(phaseDir, '01-CONTEXT.md'), '# Foundation\n');
      writeFileSync(join(metaDir, 'M001-META.json'), '{"integrationBranch":"main"}\n');

      syncGsdStateToWorktree(mainBase, wtBase);

      assert.ok(
        existsSync(join(wtBase, '.gsd', 'phases', '01-foundation', '01-CONTEXT.md')),
        'flat-phase artifact is synced to worktree',
      );
      assert.ok(
        !existsSync(join(wtBase, '.gsd', 'milestones')),
        'metadata-only legacy milestones/ scaffold is not recreated in worktree',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 8. syncWorktreeStateBack does not copy task projections ───────────
  console.log('\n=== 8. syncWorktreeStateBack leaves task projections in worktree ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-wt-'));

    try {
      // Build worktree milestone structure with slice-level and task-level files
      // Use M002 as the milestone to sync, M001 as the "current" being merged (skipped)
      const wtSliceDir = join(wtBase, '.gsd', 'phases', '02-m002');
      const wtTasksDir = join(wtSliceDir, 'tasks');
      mkdirSync(wtTasksDir, { recursive: true });
      writeFileSync(join(wtSliceDir, '01-01-SUMMARY.md'), '# S01 Summary');
      writeFileSync(join(wtTasksDir, 'T01-SUMMARY.md'), '# T01 Summary');
      writeFileSync(join(wtTasksDir, 'T02-SUMMARY.md'), '# T02 Summary');

      // Main project root starts with only the milestone directory (no slices yet)
      mkdirSync(join(mainBase, '.gsd', 'phases', '02-m002'), { recursive: true });

      const { synced } = syncWorktreeStateBack(mainBase, wtBase, 'M001');

      const mainSliceDir = join(mainBase, '.gsd', 'phases', '02-m002');
      const mainTasksDir = join(mainSliceDir, 'tasks');

      assert.ok(
        !existsSync(join(mainSliceDir, '01-01-SUMMARY.md')),
        'slice SUMMARY projection is not copied to project root',
      );
      assert.ok(
        !existsSync(join(mainTasksDir, 'T01-SUMMARY.md')),
        'task T01-SUMMARY projection is not copied to project root',
      );
      assert.ok(
        !existsSync(join(mainTasksDir, 'T02-SUMMARY.md')),
        'task T02-SUMMARY projection is not copied to project root',
      );
      assert.ok(
        !synced.some((p) => p.includes('tasks/T01-SUMMARY.md')),
        'task summary does not appear in synced list',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 9. syncWorktreeStateBack does not import root-level state projections ──────────
  console.log('\n=== 9. syncWorktreeStateBack leaves root-level state projections authoritative ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-root-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-root-wt-'));

    try {
      mkdirSync(join(mainBase, '.gsd', 'phases', '01-m001'), { recursive: true });
      mkdirSync(join(wtBase, '.gsd', 'phases', '01-m001'), { recursive: true });

      // Main has original REQUIREMENTS and PROJECT
      writeFileSync(join(mainBase, '.gsd', 'REQUIREMENTS.md'), '# Requirements\n## R001');
      writeFileSync(join(mainBase, '.gsd', 'PROJECT.md'), '# Project\n## Milestone: M001');

      // Worktree has updated versions (complete-milestone added M002 refs)
      writeFileSync(join(wtBase, '.gsd', 'REQUIREMENTS.md'), '# Requirements\n## R001\n## R002 — New req');
      writeFileSync(join(wtBase, '.gsd', 'PROJECT.md'), '# Project\n## Milestone: M001\n## Milestone: M002');
      writeFileSync(join(wtBase, '.gsd', 'KNOWLEDGE.md'), '# Knowledge\nLearned something.');

      const { synced } = syncWorktreeStateBack(mainBase, wtBase, 'M001');

      // Root-level state projections must not be overwritten with worktree versions.
      const reqContent = readFileSync(join(mainBase, '.gsd', 'REQUIREMENTS.md'), 'utf-8');
      assert.ok(
        !reqContent.includes('R002'),
        'REQUIREMENTS.md ignores worktree projection content',
      );

      const projContent = readFileSync(join(mainBase, '.gsd', 'PROJECT.md'), 'utf-8');
      assert.ok(
        !projContent.includes('M002'),
        'PROJECT.md ignores worktree projection content',
      );

      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'KNOWLEDGE.md')),
        'KNOWLEDGE.md is not copied back from worktree',
      );

      assert.ok(
        !synced.includes('REQUIREMENTS.md'),
        'REQUIREMENTS.md does not appear in synced list',
      );
      assert.ok(
        !synced.includes('PROJECT.md'),
        'PROJECT.md does not appear in synced list',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 10. syncWorktreeStateBack does not copy milestone directories ─────
  //
  // Each assertion below is its own case so a regression reports every
  // invariant it breaks rather than stopping at the first. The worktree
  // fixture uses canonical flat-phase filenames on purpose: when the fixture
  // names and the asserted names diverge, `!existsSync(...)` holds whether or
  // not the phases copy-back runs, and the case defends nothing.
  describe('10. syncWorktreeStateBack does not copy phase dirs back to the project root', () => {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-all-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-all-wt-'));
    after(() => {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    });

    const mainPhases = join(mainBase, '.gsd', 'phases');
    mkdirSync(mainPhases, { recursive: true });
    mkdirSync(join(wtBase, '.gsd', 'phases'), { recursive: true });

    // Worktree has M001 (current) AND M002 (next, created by complete-milestone)
    const wtM001Dir = join(wtBase, '.gsd', 'phases', '01-m001');
    mkdirSync(wtM001Dir, { recursive: true });
    writeFileSync(join(wtM001Dir, '01-SUMMARY.md'), '# M001 Summary');

    const wtM002Dir = join(wtBase, '.gsd', 'phases', '02-m002-abc123');
    mkdirSync(wtM002Dir, { recursive: true });
    writeFileSync(join(wtM002Dir, '02-CONTEXT.md'), '# M002 Context');
    writeFileSync(join(wtM002Dir, '02-ROADMAP.md'), '# M002 Roadmap');

    // Fixture precondition — main starts with an empty phases/ tree.
    assert.deepEqual(readdirSync(mainPhases), [], 'main phases/ is empty before sync');

    // Sync with milestoneId = M001 (the current milestone being merged — skipped)
    const { synced } = syncWorktreeStateBack(mainBase, wtBase, 'M001');

    test('project-root phases/ tree gains no entries at all', () => {
      assert.deepEqual(
        readdirSync(mainPhases).sort(),
        [],
        'no worktree phase dir is materialised in the project root',
      );
    });

    test('current milestone phase dir is not created in the project root', () => {
      assert.equal(
        existsSync(join(mainPhases, '01-m001')),
        false,
        'M001 phase dir NOT created (current milestone skipped to prevent merge conflicts — #3641)',
      );
    });

    test('M001 SUMMARY projection is not copied to the project root', () => {
      assert.equal(
        existsSync(join(mainPhases, '01-m001', '01-SUMMARY.md')),
        false,
        'M001 SUMMARY NOT synced (current milestone skipped to prevent merge conflicts)',
      );
    });

    test('next-milestone phase dir is not created in the project root', () => {
      assert.equal(
        existsSync(join(mainPhases, '02-m002-abc123')),
        false,
        'M002 phase dir NOT created; worktree projections are not authoritative',
      );
    });

    test('M002 CONTEXT and ROADMAP projections are not copied to the project root', () => {
      assert.equal(
        existsSync(join(mainPhases, '02-m002-abc123', '02-CONTEXT.md')),
        false,
        'M002 CONTEXT projection is not copied to main',
      );
      assert.equal(
        existsSync(join(mainPhases, '02-m002-abc123', '02-ROADMAP.md')),
        false,
        'M002 ROADMAP projection is not copied to main',
      );
    });

    test('no phase-tree entry is advertised in the synced list', () => {
      assert.deepEqual(
        synced.filter((p) => /phases|m001|m002/i.test(p)),
        [],
        'synced must not report any milestone/phase projection as having crossed the boundary',
      );
    });
  });

  // ─── 11. Full M006→M007 transition scenario ───────────────────────────
  console.log('\n=== 11. complete-milestone worktree projections do not overwrite project root ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-transition-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-transition-wt-'));

    try {
      mkdirSync(join(mainBase, '.gsd', 'phases'), { recursive: true });
      mkdirSync(join(wtBase, '.gsd', 'phases'), { recursive: true });

      // Main starts with M006 context + existing REQUIREMENTS
      const mainM006 = join(mainBase, '.gsd', 'phases', '06-m006-589wvh');
      mkdirSync(mainM006, { recursive: true });
      writeFileSync(join(mainM006, 'M006-589wvh-CONTEXT.md'), '# M006 Context');
      writeFileSync(join(mainBase, '.gsd', 'REQUIREMENTS.md'), '# Requirements\n## R001 through R089');
      writeFileSync(join(mainBase, '.gsd', 'PROJECT.md'), '# Project\nMilestones: M001-M006');

      // Worktree (M006 execution context) has:
      // - M006 SUMMARY + VALIDATION (created by complete-milestone)
      // - M007 setup (created by complete-milestone for next milestone)
      // - Updated REQUIREMENTS with R090-R094
      // - Updated PROJECT with M007
      // Canonical flat-phase filenames, so the assertions below name files that
      // really exist on the worktree side and fail if a copy-back reappears.
      const wtM006 = join(wtBase, '.gsd', 'phases', '06-m006-589wvh');
      mkdirSync(join(wtM006, 'slices', 'S01'), { recursive: true });
      writeFileSync(join(wtM006, '06-CONTEXT.md'), '# M006 Context');
      writeFileSync(join(wtM006, '06-SUMMARY.md'), '# M006 Complete');
      writeFileSync(join(wtM006, '06-VALIDATION.md'), '# Validated');
      writeFileSync(join(wtM006, 'slices', 'S01', '01-01-SUMMARY.md'), '# S01 done');

      const wtM007 = join(wtBase, '.gsd', 'phases', '07-m007-wortc8');
      mkdirSync(wtM007, { recursive: true });
      writeFileSync(join(wtM007, '07-CONTEXT.md'), '# M007 Enterprise Security');
      writeFileSync(join(wtM007, '07-ROADMAP.md'), '# M007 Roadmap\n10 phases');

      writeFileSync(join(wtBase, '.gsd', 'REQUIREMENTS.md'), '# Requirements\n## R001-R089\n## R090 — SCIM\n## R091 — WebAuthn');
      writeFileSync(join(wtBase, '.gsd', 'PROJECT.md'), '# Project\nMilestones: M001-M007');

      // Sync with milestoneId = M006 (the completing milestone — skipped by sync)
      const { synced } = syncWorktreeStateBack(mainBase, wtBase, 'M006-589wvh');

      // M006 is the current milestone being merged — it should be SKIPPED (#3641)
      // Its files are already in the milestone branch and would conflict with squash merge.
      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'phases', '06-m006-589wvh', '06-SUMMARY.md')),
        'M006 SUMMARY NOT synced (current milestone skipped)',
      );

      // Verify M007 worktree projections are not copied back.
      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'phases', '07-m007-wortc8', '07-CONTEXT.md')),
        'M007 CONTEXT projection is not copied to main',
      );
      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'phases', '07-m007-wortc8', '07-ROADMAP.md')),
        'M007 ROADMAP projection is not copied to main',
      );

      // Verify root-level projections remain project-root authoritative.
      const reqContent = readFileSync(join(mainBase, '.gsd', 'REQUIREMENTS.md'), 'utf-8');
      assert.ok(
        !reqContent.includes('R090'),
        'REQUIREMENTS.md ignores worktree projection updates',
      );

      const projContent = readFileSync(join(mainBase, '.gsd', 'PROJECT.md'), 'utf-8');
      assert.ok(
        !projContent.includes('M007'),
        'PROJECT.md ignores worktree projection updates',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 12. syncWorktreeStateBack no-op for root files that don't exist ──
  console.log('\n=== 12. root files not in worktree are not created in main ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-noroot-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-noroot-wt-'));

    try {
      mkdirSync(join(mainBase, '.gsd', 'phases', '01-m001'), { recursive: true });
      mkdirSync(join(wtBase, '.gsd', 'phases', '01-m001'), { recursive: true });

      // Main has REQUIREMENTS, worktree does not
      writeFileSync(join(mainBase, '.gsd', 'REQUIREMENTS.md'), '# Original');

      const { synced } = syncWorktreeStateBack(mainBase, wtBase, 'M001');

      // Main's REQUIREMENTS should be untouched (worktree had nothing to sync)
      const content = readFileSync(join(mainBase, '.gsd', 'REQUIREMENTS.md'), 'utf-8');
      assert.ok(
        content === '# Original',
        'REQUIREMENTS.md unchanged when worktree has no copy',
      );
      assert.ok(
        !synced.includes('REQUIREMENTS.md'),
        'REQUIREMENTS.md not in synced list',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 13. syncWorktreeStateBack skips QUEUE.md but preserves completed-units diagnostics ──
  console.log('\n=== 13. QUEUE.md skipped; completed-units.json diagnostic synced ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-queue-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-queue-wt-'));

    try {
      mkdirSync(join(mainBase, '.gsd', 'phases', '01-m001'), { recursive: true });
      mkdirSync(join(wtBase, '.gsd', 'phases', '01-m001'), { recursive: true });

      // Worktree has QUEUE.md projection and completed-units.json diagnostic.
      writeFileSync(join(wtBase, '.gsd', 'QUEUE.md'), '# Queue\n- M002 next');
      writeFileSync(
        join(wtBase, '.gsd', 'completed-units.json'),
        JSON.stringify({ units: [{ id: 'M001-S01-T01', completed: true }] }),
      );

      // Main has neither
      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'QUEUE.md')),
        'QUEUE.md missing in main before sync',
      );
      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'completed-units.json')),
        'completed-units.json missing in main before sync',
      );

      const { synced } = syncWorktreeStateBack(mainBase, wtBase, 'M001');

      // QUEUE.md is state/projection content and should not be copied back.
      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'QUEUE.md')),
        'QUEUE.md is not synced from worktree to main',
      );
      assert.ok(
        !synced.includes('QUEUE.md'),
        'QUEUE.md does not appear in synced list',
      );

      // completed-units.json is diagnostic and may be copied for operator visibility.
      assert.ok(
        existsSync(join(mainBase, '.gsd', 'completed-units.json')),
        '#1787: completed-units.json synced from worktree to main',
      );
      const cuContent = readFileSync(join(mainBase, '.gsd', 'completed-units.json'), 'utf-8');
      assert.ok(
        cuContent.includes('M001-S01-T01'),
        '#1787: completed-units.json has correct content',
      );
      assert.ok(
        synced.includes('completed-units.json'),
        '#1787: completed-units.json appears in synced list',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 14. syncGsdStateToWorktree syncs suffixed phase dir names (#1547) ──
  console.log('\n=== 14. syncGsdStateToWorktree syncs suffixed phase dir names (#1547) ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      // Main has a team-suffixed phase dir name
      const suffixDir = join(mainBase, '.gsd', 'phases', '01-m001-abc123');
      mkdirSync(suffixDir, { recursive: true });
      writeFileSync(join(suffixDir, '01-CONTEXT.md'), '# M001 Context');

      assert.ok(!existsSync(join(wtBase, '.gsd', 'phases', '01-m001-abc123')), 'M001-abc123 missing before sync');

      const result = syncGsdStateToWorktree(mainBase, wtBase);

      assert.ok(
        existsSync(join(wtBase, '.gsd', 'phases', '01-m001-abc123', '01-CONTEXT.md')),
        '#1547: suffixed milestone dir "M001-abc123" synced to worktree',
      );
      assert.ok(result.synced.length > 0, 'sync reported files');
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 15. syncWorktreeStateBack skips non-standard milestone dir names ──
  console.log('\n=== 15. syncWorktreeStateBack skips non-standard milestone dir names ===');
  {
    const mainBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-custom-main-'));
    const wtBase = mkdtempSync(join(tmpdir(), 'gsd-wt-back-custom-wt-'));

    try {
      mkdirSync(join(mainBase, '.gsd', 'phases'), { recursive: true });
      mkdirSync(join(wtBase, '.gsd', 'phases'), { recursive: true });

      // Worktree has a non-standard milestone dir
      const wtCustomDir = join(wtBase, '.gsd', 'milestones', 'sprint-beta');
      mkdirSync(wtCustomDir, { recursive: true });
      writeFileSync(join(wtCustomDir, 'SUMMARY.md'), '# Sprint Beta Summary');

      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'milestones', 'sprint-beta')),
        'sprint-beta missing in main before sync',
      );

      const { synced } = syncWorktreeStateBack(mainBase, wtBase, 'M001');

      assert.ok(
        !existsSync(join(mainBase, '.gsd', 'milestones', 'sprint-beta', 'SUMMARY.md')),
        'non-standard milestone projection is not copied back to main',
      );
      assert.ok(
        !synced.some((p) => p.includes('sprint-beta')),
        'sprint-beta does not appear in synced list',
      );
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
      rmSync(wtBase, { recursive: true, force: true });
    }
  }

  // ─── 16. pre-dispatch sync projects missing future milestone top-level artifacts (#5687) ──
  console.log('\n=== 16. pre-dispatch sync projects missing future milestone top-level artifacts (#5687) ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      // Canonical .gsd has M003 context draft that complete-milestone needs.
      const mainM003 = join(mainBase, '.gsd', 'phases', '03-m003');
      mkdirSync(mainM003, { recursive: true });
      writeFileSync(join(mainM003, '03-CONTEXT-DRAFT.md'), '# M003 Context Draft');
      writeFileSync(join(mainM003, '03-ROADMAP.md'), '# M003 Roadmap');

      // Worktree only has skeletal roadmap for M003.
      const wtM003 = join(wtBase, '.gsd', 'phases', '03-m003');
      mkdirSync(wtM003, { recursive: true });
      writeFileSync(join(wtM003, '03-ROADMAP.md'), '# WT Roadmap');

      // Worktree has current milestone file that must not be overwritten.
      const mainM002 = join(mainBase, '.gsd', 'phases', '02-m002');
      mkdirSync(mainM002, { recursive: true });
      writeFileSync(join(mainM002, '02-ROADMAP.md'), '# Main M002 Roadmap');
      const wtM002 = join(wtBase, '.gsd', 'phases', '02-m002');
      mkdirSync(wtM002, { recursive: true });
      writeFileSync(join(wtM002, '02-ROADMAP.md'), '# Worktree M002 Roadmap');

      // Canonical .gsd has M004 with no corresponding worktree directory at all.
      const mainM004 = join(mainBase, '.gsd', 'phases', '04-m004');
      mkdirSync(mainM004, { recursive: true });
      writeFileSync(join(mainM004, '04-CONTEXT-DRAFT.md'), '# M004 Context Draft');

      syncProjectRootToWorktree(mainBase, wtBase, 'M002');

      assert.ok(
        existsSync(join(wtBase, '.gsd', 'phases', '03-m003', '03-CONTEXT-DRAFT.md')),
        '#5687: future milestone context draft projected into worktree',
      );
      assert.equal(
        readFileSync(join(wtBase, '.gsd', 'phases', '03-m003', '03-ROADMAP.md'), 'utf-8'),
        '# WT Roadmap',
        '#5687: existing worktree-local M003 file is not overwritten',
      );
      assert.equal(
        readFileSync(join(wtBase, '.gsd', 'phases', '02-m002', '02-ROADMAP.md'), 'utf-8'),
        '# Worktree M002 Roadmap',
        '#5687: existing worktree-local files are not overwritten',
      );
      assert.ok(
        existsSync(join(wtBase, '.gsd', 'phases', '04-m004', '04-CONTEXT-DRAFT.md')),
        '#5687: future milestone context draft projected into worktree when no wt dir existed',
      );
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }

  // ─── 17. pre-dispatch sync creates absent worktree milestone dir before projecting artifacts (#5687) ──
  console.log('\n=== 17. pre-dispatch sync creates absent worktree milestone dir before projecting artifacts (#5687) ===');
  {
    const mainBase = createBase('main');
    const wtBase = createBase('wt');

    try {
      // Canonical .gsd has a future milestone M004 with a context draft.
      const mainM004 = join(mainBase, '.gsd', 'phases', '04-m004');
      mkdirSync(mainM004, { recursive: true });
      writeFileSync(join(mainM004, '04-CONTEXT-DRAFT.md'), '# M004 Context Draft');

      // Active milestone M002 exists in both main and worktree.
      const mainM002 = join(mainBase, '.gsd', 'phases', '02-m002');
      mkdirSync(mainM002, { recursive: true });
      writeFileSync(join(mainM002, '02-ROADMAP.md'), '# Main M002 Roadmap');
      const wtM002 = join(wtBase, '.gsd', 'phases', '02-m002');
      mkdirSync(wtM002, { recursive: true });
      writeFileSync(join(wtM002, '02-ROADMAP.md'), '# Worktree M002 Roadmap');

      // M004 does NOT exist in the worktree at all before sync.
      assert.ok(
        !existsSync(join(wtBase, '.gsd', 'phases', '04-m004')),
        '#5687: worktree M004 dir must not exist before sync',
      );

      syncProjectRootToWorktree(mainBase, wtBase, 'M002');

      assert.ok(
        existsSync(join(wtBase, '.gsd', 'phases', '04-m004', '04-CONTEXT-DRAFT.md')),
        '#5687: context draft projected into worktree even when milestone dir was absent',
      );
    } finally {
      cleanup(mainBase);
      cleanup(wtBase);
    }
  }
});
