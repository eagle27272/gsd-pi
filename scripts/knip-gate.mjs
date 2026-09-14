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
// Spawn the bin directly rather than `pnpm exec`: no shell wrapper to resolve
// (which spawnSync cannot do for pnpm.cmd on Windows) and no nested pnpm.
const KNIP_BIN = join(ROOT, 'node_modules', 'knip', 'bin', 'knip.js');

function parseArgs(argv) {
  const unknown = argv.filter((arg) => arg !== '--write');
  if (unknown.length > 0) {
    throw new Error(`unknown argument(s): ${unknown.join(' ')}. The only flag is --write.`);
  }
  return { write: argv.includes('--write') };
}

function runKnip() {
  const result = spawnSync(process.execPath, [KNIP_BIN, '--no-progress', '--reporter', 'json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return parseKnipReport(result);
}

function readBaseline() {
  let text;
  try {
    text = readFileSync(BASELINE_PATH, 'utf8');
  } catch (error) {
    throw new Error(
      `cannot read the knip baseline at ${BASELINE_PATH} (${error.code}). ` +
        'Regenerate it with `pnpm run lint:dead-code:update`.',
    );
  }
  return parseBaseline(text);
}

function printDiff(diff) {
  for (const key of diff.resolved) process.stdout.write(`  resolved: ${key}\n`);
  for (const key of diff.added) {
    const [type, file, symbol] = key.split('|');
    process.stdout.write(`  accepted: ${type} ${file}${symbol ? ` — ${symbol}` : ''}\n`);
  }
}

function main() {
  const { write } = parseArgs(process.argv.slice(2));
  // Read the baseline before the 60-90s knip run so a missing or corrupt file
  // fails immediately rather than at the end.
  const baseline = write ? null : readBaseline();
  const current = flattenKnipReport(runKnip());

  if (write) {
    const previous = (() => {
      try {
        return readBaseline();
      } catch {
        return [];
      }
    })();
    writeFileSync(BASELINE_PATH, renderBaselineFile(current));
    process.stdout.write(`knip baseline written: ${current.length} accepted finding(s)\n`);
    printDiff(diffAgainstBaseline(current, previous));
    return;
  }

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

  // Set the code rather than calling process.exit(): stdout and stderr are
  // async when they are pipes, as they are under CI, and exiting outright
  // truncates the finding list that makes a failure actionable.
  process.exitCode = exitCodeForDiff(diff);
}

try {
  main();
} catch (error) {
  process.stderr.write(`\nERROR: dead-code gate could not run: ${error.message}\n`);
  process.exitCode = 2;
}
