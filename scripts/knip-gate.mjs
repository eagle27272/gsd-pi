#!/usr/bin/env node
/**
 * Dead-code gate: run knip and fail only on findings that are not already in
 * .config/knip-baseline.json. Pass --write to regenerate that baseline.
 *
 * See docs/dev/dead-code-lint.md.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  diffAgainstBaseline,
  exitCodeForDiff,
  flattenKnipReport,
  parseBaseline,
  parseKnipReport,
  renderBaselineFile,
} from './lib/knip-baseline-lib.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, '.config', 'knip-baseline.json');
const write = process.argv.slice(2).includes('--write');

// Spawn the bin directly rather than `pnpm exec`: no shell wrapper to resolve
// (which spawnSync cannot do for pnpm.cmd on Windows) and no nested pnpm.
const KNIP_BIN = join(ROOT, 'node_modules', 'knip', 'bin', 'knip.js');

function runKnip() {
  const result = spawnSync(process.execPath, [KNIP_BIN, '--no-progress', '--reporter', 'json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return parseKnipReport(result);
}

function main() {
  const current = flattenKnipReport(runKnip());

  if (write) {
    writeFileSync(BASELINE_PATH, renderBaselineFile(current));
    process.stdout.write(`knip baseline written: ${current.length} accepted finding(s)\n`);
    return;
  }

  const baseline = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'));
  const diff = diffAgainstBaseline(current, baseline);

  if (diff.resolved.length > 0) {
    process.stdout.write(
      `knip: ${diff.resolved.length} baselined finding(s) no longer occur — ` +
        'run `pnpm run lint:dead-code:update` to tighten the baseline:\n',
    );
    for (const key of diff.resolved) process.stdout.write(`  - ${key}\n`);
  }

  if (diff.added.length === 0) {
    process.stdout.write(`knip: no new dead code (${baseline.length} baselined finding(s)) ✓\n`);
  } else {
    process.stderr.write(`\nERROR: ${diff.added.length} new dead-code finding(s):\n`);
    for (const key of diff.added) {
      const [type, file, symbol] = key.split('|');
      process.stderr.write(`  ${type}: ${file}${symbol ? ` — ${symbol}` : ''}\n`);
    }
    process.stderr.write(
      '\nDelete the dead code. If a finding moved for a legitimate reason, ' +
        'rerun with `pnpm run lint:dead-code:update` and explain the change in the PR.\n',
    );
  }

  process.exit(exitCodeForDiff(diff));
}

main();
