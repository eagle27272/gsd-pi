// Project/App: gsd-pi
// File Purpose: Git-fixture coverage for vendor-pi.cjs one-shot orchestration and --ref semantics.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
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

// vendor-pi.cjs anchors REPO_ROOT to resolve(__dirname, '..') and reads its
// config from scripts/pi-upstream.json beside itself. Copying it into a tmpdir
// therefore relocates the whole script wholesale, letting us point `repository`
// at a local fixture remote and exercise the real git codepath offline. The
// three pipeline steps are replaced by stubs that append their name to
// pipeline.log, so these tests cover orchestration and argv handling only —
// each step keeps its own coverage.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_SCRIPT = resolve(__dirname, '..', 'vendor-pi.cjs');
const PIPELINE_STEPS = ['vendor-pi-deps.cjs', 'vendor-pi-coding-agent-core.cjs', 'apply-seam.cjs'];
const SEAM_SENTINEL = 'packages/pi-coding-agent/src/core/gsd-seam-types.ts';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

function configureRepo(repo) {
  git(repo, ['config', '--local', 'user.email', 'fixture@example.test']);
  git(repo, ['config', '--local', 'user.name', 'Fixture User']);
  git(repo, ['config', '--local', 'commit.gpgsign', 'false']);
  git(repo, ['config', '--local', 'tag.gpgsign', 'false']);
  // A global core.excludesFile can hide fixture paths from `git add`.
  git(repo, ['config', '--local', 'core.excludesFile', '/dev/null']);
}

let tmpRoot;
let upstreamUrl;

before(() => {
  // realpath because macOS $TMPDIR is a /var/folders symlink to /private/var/folders,
  // and a file:// clone URL must match the path git actually resolves.
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'vendor-pi-')));
  const upstream = join(tmpRoot, 'upstream');
  mkdirSync(join(upstream, 'packages', 'agent'), { recursive: true });
  git(upstream, ['init', '-q', '-b', 'main']);
  configureRepo(upstream);

  for (const tag of ['v1.0.0', 'v2.0.0']) {
    writeFileSync(join(upstream, 'packages', 'agent', 'MARKER'), `${tag}\n`);
    git(upstream, ['add', '-A']);
    git(upstream, ['commit', '-q', '-m', `release ${tag}`]);
    git(upstream, ['tag', tag]);
  }

  upstreamUrl = `file://${upstream}`;
});

after(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

/** Build a throwaway repo root holding the real vendor-pi.cjs plus stubbed pipeline steps. */
function makeFixtureRoot(configOverrides = {}, { failingStep } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpRoot, 'root-')));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(SOURCE_SCRIPT, join(root, 'scripts', 'vendor-pi.cjs'));

  writeFileSync(
    join(root, 'scripts', 'pi-upstream.json'),
    `${JSON.stringify({ repository: upstreamUrl, pinnedRef: 'v1.0.0', ...configOverrides }, null, 2)}\n`,
  );

  for (const step of PIPELINE_STEPS) {
    writeFileSync(
      join(root, 'scripts', step),
      `'use strict'\n` +
        `require('fs').appendFileSync(require('path').join(__dirname, '..', 'pipeline.log'), ${JSON.stringify(`${step}\n`)})\n` +
        (step === failingStep ? `process.stderr.write('stub failure\\n')\nprocess.exit(1)\n` : ''),
    );
  }

  mkdirSync(dirname(join(root, SEAM_SENTINEL)), { recursive: true });
  writeFileSync(join(root, SEAM_SENTINEL), 'export type GsdSeam = never\n');

  return root;
}

function runVendorPi(root, args) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'vendor-pi.cjs'), ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function pipelineLog(root) {
  const p = join(root, 'pipeline.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
}

/** The fixture ships exactly one package dir; anything else means the run wrote to the tree. */
function packageDirs(root) {
  const p = join(root, 'packages');
  return existsSync(p) ? readdirSync(p).sort() : [];
}

function cachedMarker(root) {
  const p = join(root, '.cache', 'pi-upstream', 'packages', 'agent', 'MARKER');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

describe('vendor-pi.cjs one-shot orchestration', () => {
  test('checks out the ref and runs the documented pipeline in order', () => {
    const root = makeFixtureRoot();
    const result = runVendorPi(root, ['--ref', 'v2.0.0']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(cachedMarker(root), 'v2.0.0');
    assert.deepEqual(pipelineLog(root), PIPELINE_STEPS);
  });

  test('leaves seam-protected pi-coding-agent files to the pipeline steps', () => {
    const root = makeFixtureRoot();
    const result = runVendorPi(root, []);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(root, SEAM_SENTINEL), 'utf8'),
      'export type GsdSeam = never\n',
      'vendor-pi.cjs must not copy packages/coding-agent over the seamed package itself',
    );
  });

  test('falls back to pinnedRef when --ref is omitted', () => {
    const root = makeFixtureRoot();
    const result = runVendorPi(root, []);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(cachedMarker(root), 'v1.0.0');
  });
});

describe('vendor-pi.cjs --ref semantics', () => {
  test('re-targets an already-populated cache to a different ref', () => {
    const root = makeFixtureRoot();

    assert.equal(runVendorPi(root, ['--ref', 'v1.0.0', '--checkout-only']).status, 0);
    assert.equal(cachedMarker(root), 'v1.0.0');

    const second = runVendorPi(root, ['--ref', 'v2.0.0', '--checkout-only']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(cachedMarker(root), 'v2.0.0', 'a warm cache must follow --ref, not stay pinned');
  });

  test('--checkout-only stages the cache without running any pipeline step', () => {
    const root = makeFixtureRoot();
    const result = runVendorPi(root, ['--ref', 'v2.0.0', '--checkout-only']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(cachedMarker(root), 'v2.0.0');
    assert.deepEqual(pipelineLog(root), []);
  });

  test('--skip-checkout runs the pipeline against the existing cache', () => {
    const root = makeFixtureRoot({ repository: 'file:///nonexistent-remote-must-not-be-used' });
    mkdirSync(join(root, '.cache', 'pi-upstream', 'packages', 'agent'), { recursive: true });
    writeFileSync(join(root, '.cache', 'pi-upstream', 'packages', 'agent', 'MARKER'), 'staged\n');

    const result = runVendorPi(root, ['--skip-checkout']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(cachedMarker(root), 'staged');
    assert.deepEqual(pipelineLog(root), PIPELINE_STEPS);
  });

  test('--skip-checkout fails when nothing is staged', () => {
    const root = makeFixtureRoot();
    const result = runVendorPi(root, ['--skip-checkout']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\.cache\/pi-upstream/);
    assert.deepEqual(pipelineLog(root), []);
  });

  test('--dry-run previews the pipeline without cloning, running steps, or touching the tree', () => {
    const root = makeFixtureRoot();
    const result = runVendorPi(root, ['--ref', 'v2.0.0', '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /v2\.0\.0/);
    for (const step of PIPELINE_STEPS) assert.match(result.stderr, new RegExp(step));
    assert.equal(cachedMarker(root), null, 'dry run must not create an upstream checkout');
    assert.deepEqual(pipelineLog(root), []);
    assert.deepEqual(packageDirs(root), ['pi-coding-agent'], 'dry run must not touch the working tree');
  });
});

describe('vendor-pi.cjs pipeline failure handling', () => {
  test('aborts on the first failing step instead of running the rest', () => {
    const root = makeFixtureRoot({}, { failingStep: 'vendor-pi-coding-agent-core.cjs' });
    const result = runVendorPi(root, []);

    assert.notEqual(result.status, 0, 'a failed step must not report success');
    assert.match(result.stderr, /vendor-pi-coding-agent-core\.cjs failed/);
    assert.deepEqual(
      pipelineLog(root),
      ['vendor-pi-deps.cjs', 'vendor-pi-coding-agent-core.cjs'],
      'apply-seam.cjs must not run on top of a half-vendored tree',
    );
  });
});

describe('vendor-pi.cjs argv validation', () => {
  test('rejects an unknown flag instead of silently ignoring it', () => {
    const root = makeFixtureRoot();
    const result = runVendorPi(root, ['--no-such-flag']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--no-such-flag/);
    assert.equal(cachedMarker(root), null);
  });

  test('rejects --ref with no value', () => {
    const root = makeFixtureRoot();
    const result = runVendorPi(root, ['--ref']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--ref/);
    assert.equal(cachedMarker(root), null);
  });

  test('rejects --checkout-only combined with --skip-checkout', () => {
    const root = makeFixtureRoot();
    const result = runVendorPi(root, ['--checkout-only', '--skip-checkout']);

    assert.notEqual(result.status, 0);
    assert.deepEqual(pipelineLog(root), []);
  });
});
