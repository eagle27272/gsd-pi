/**
 * Runtime regression — `.bg-shell/` baseline pattern (#4902, prior #2655).
 *
 * The deleted `gitignore-bg-shell.test.ts` asserted `.bg-shell/` appeared in
 * the BASELINE_PATTERNS array via source grep. This rewrite drives
 * `ensureGitignore()` against a tmp repo and asserts the written ignore rules
 * actually contain the `.bg-shell/` pattern — i.e. tests the behaviour the
 * constant exists to guarantee, not the spelling of the constant.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ensureGitignore } from '../gitignore.ts';

function makeTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gitignore-bg-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

/** Where ensureGitignore writes: the repo-local exclude file, not .gitignore. */
function excludeFile(dir: string): string {
  return path.join(dir, '.git', 'info', 'exclude');
}

function patternsIn(file: string): Set<string> {
  return new Set(
    fs.readFileSync(file, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
}

describe('ensureGitignore writes .bg-shell/ baseline (#4902)', () => {
  test('appends .bg-shell/ to a fresh repo', () => {
    const dir = makeTmpRepo();
    try {
      const wrote = ensureGitignore(dir);
      assert.equal(wrote, true, 'ensureGitignore should report it wrote');

      const lines = patternsIn(excludeFile(dir));
      assert.ok(lines.has('.bg-shell/'), 'exclude should include .bg-shell/');
      assert.ok(lines.has('.gsd-backups/'), 'exclude should include .gsd-backups/');
    } finally {
      cleanup(dir);
    }
  });

  test('does not re-add .bg-shell/ when .gitignore already declares it', () => {
    const dir = makeTmpRepo();
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), '.bg-shell/\nnode_modules/\n');
      ensureGitignore(dir);

      assert.ok(
        !patternsIn(excludeFile(dir)).has('.bg-shell/'),
        'a pattern already in .gitignore must not be duplicated into the exclude file',
      );
    } finally {
      cleanup(dir);
    }
  });

  test('adds Windows reserved device-name patterns', () => {
    const dir = makeTmpRepo();
    try {
      ensureGitignore(dir);
      const lines = patternsIn(excludeFile(dir));
      for (const pattern of ['nul', 'nul.*', 'con', 'con.*', 'prn', 'prn.*', 'aux', 'aux.*', 'com[1-9]', 'com[1-9].*', 'lpt[1-9]', 'lpt[1-9].*']) {
        assert.ok(lines.has(pattern), `missing Windows reserved pattern: ${pattern}`);
      }
    } finally {
      cleanup(dir);
    }
  });
});
