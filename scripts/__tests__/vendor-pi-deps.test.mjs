// Project/App: gsd-pi
// File Purpose: Regression coverage for vendor-pi-deps.cjs copies, GSD naming, and missing-upstream errors.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// vendor-pi-deps.cjs anchors ROOT to resolve(__dirname, '..') and shells out to
// three post-processing scripts with cwd=ROOT, so copying it into a tmpdir
// relocates the whole script and lets stubs stand in for those steps. It takes
// no --ref: it reads whatever .cache/pi-upstream already holds, which is why
// vendor-pi.cjs owns the checkout.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_SCRIPT = resolve(__dirname, '..', 'vendor-pi-deps.cjs');
const POST_STEPS = ['normalize-pi-imports.cjs', 'apply-gsd-pi-package-json.cjs', 'restore-pi-tsconfig.cjs'];
const UPSTREAM_DIRS = [
  ['packages/agent', 'pi-agent-core', '@gsd/pi-agent-core'],
  ['packages/ai', 'pi-ai', '@gsd/pi-ai'],
  ['packages/tui', 'pi-tui', '@gsd/pi-tui'],
];

function makeFixtureRoot({ stagedUpstream }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vendor-pi-deps-')));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(SOURCE_SCRIPT, join(root, 'scripts', 'vendor-pi-deps.cjs'));

  for (const step of POST_STEPS) {
    writeFileSync(
      join(root, 'scripts', step),
      `'use strict'\n` +
        `require('fs').appendFileSync(require('path').join(__dirname, '..', 'post.log'), ${JSON.stringify(`${step}\n`)})\n`,
    );
  }

  for (const upstreamSubdir of stagedUpstream) {
    const dir = join(root, '.cache', 'pi-upstream', upstreamSubdir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: `@earendil-works/${upstreamSubdir}`, version: '9.9.9', publishConfig: { access: 'public' } }, null, 2)}\n`,
    );
    writeFileSync(join(dir, 'MARKER'), `${upstreamSubdir}\n`);
  }

  return root;
}

function runVendorPiDeps(root) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'vendor-pi-deps.cjs')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, stderr: result.stderr ?? '' };
}

function postLog(root) {
  const p = join(root, 'post.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
}

describe('vendor-pi-deps.cjs', () => {
  test('copies the three dep packages under their GSD names and runs post-processing', () => {
    const root = makeFixtureRoot({ stagedUpstream: UPSTREAM_DIRS.map(([u]) => u) });

    try {
      const result = runVendorPiDeps(root);
      assert.equal(result.status, 0, result.stderr);

      for (const [upstreamSubdir, target, gsdName] of UPSTREAM_DIRS) {
        const pkg = JSON.parse(readFileSync(join(root, 'packages', target, 'package.json'), 'utf8'));
        assert.equal(pkg.name, gsdName);
        assert.equal(pkg.publishConfig, undefined, 'upstream publishConfig must not survive vendoring');
        assert.equal(readFileSync(join(root, 'packages', target, 'MARKER'), 'utf8').trim(), upstreamSubdir);
      }

      assert.deepEqual(postLog(root), POST_STEPS);
      assert.ok(!existsSync(join(root, 'packages', 'pi-coding-agent')), 'pi-coding-agent is not this script’s job');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails loudly and vendors nothing when a mapped package is missing upstream', () => {
    // packages/agent is deliberately absent, so the first mapped package is missing.
    const root = makeFixtureRoot({ stagedUpstream: ['packages/ai', 'packages/tui'] });

    try {
      const result = runVendorPiDeps(root);

      assert.notEqual(result.status, 0, 'a missing upstream package must not report success');
      assert.match(result.stderr, /Missing upstream package: .*packages\/agent/);
      assert.deepEqual(
        existsSync(join(root, 'packages')) ? readdirSync(join(root, 'packages')) : [],
        [],
        'nothing should be vendored before the error',
      );
      assert.deepEqual(postLog(root), [], 'post-processing must not run on a failed copy');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
