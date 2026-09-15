#!/usr/bin/env node
/**
 * Never-read interface properties: report first-party `PropertySignature`s that
 * are written somewhere and read nowhere, failing only on findings absent from
 * .config/iface-props-baseline.json. Pass --write to regenerate that baseline.
 *
 * Complements scripts/knip-gate.mjs, whose member analysis covers classes and
 * enums only. See docs/dev/dead-code-lint.md.
 */
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  diffAgainstBaseline,
  exitCodeForDiff,
  parseBaseline,
  renderBaselineFile,
} from './lib/baseline-ratchet.mjs';
import { analyse, BASELINE_HEADER, DECLARATION_GLOBS, PROGRAM_GLOBS } from './lib/iface-props-lib.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, '.config', 'iface-props-baseline.json');

function parseArgs(argv) {
  const unknown = argv.filter((arg) => arg !== '--write');
  if (unknown.length > 0) {
    throw new Error(`unknown argument(s): ${unknown.join(' ')}. The only flag is --write.`);
  }
  return { write: argv.includes('--write') };
}

// The analysed set is a function of these globs alone, never of local gitignore
// or build state, so the baseline is identical on every machine and in CI.
function resolveGlobs(globs) {
  const paths = new Set();
  for (const pattern of globs) {
    for (const match of globSync(pattern, { cwd: ROOT, nodir: true })) {
      if (!match.endsWith('.d.ts')) paths.add(join(ROOT, match));
    }
  }
  return [...paths].sort();
}

function readBaseline() {
  let text;
  try {
    text = readFileSync(BASELINE_PATH, 'utf8');
  } catch (error) {
    throw new Error(
      `cannot read the interface-property baseline at ${BASELINE_PATH} (${error.code}). ` +
        'Regenerate it with `pnpm run lint:dead-code:props:update`.',
    );
  }
  return parseBaseline(text, 'interface-property baseline');
}

function run() {
  const declarationPaths = new Set(resolveGlobs(DECLARATION_GLOBS));
  return analyse(resolveGlobs(PROGRAM_GLOBS), (path) => declarationPaths.has(path), ROOT);
}

function printKeys(stream, keys, prefix) {
  for (const key of keys) {
    const [, file, symbol] = key.split('|');
    stream.write(`  ${prefix}${file} — ${symbol}\n`);
  }
}

function main() {
  const { write } = parseArgs(process.argv.slice(2));
  const baseline = write ? null : readBaseline();
  const current = run();

  if (write) {
    const previous = (() => {
      try {
        return readBaseline();
      } catch {
        return [];
      }
    })();
    writeFileSync(BASELINE_PATH, renderBaselineFile(BASELINE_HEADER, current));
    process.stdout.write(`interface-property baseline written: ${current.length} accepted finding(s)\n`);
    const diff = diffAgainstBaseline(current, previous);
    printKeys(process.stdout, diff.resolved, 'resolved: ');
    printKeys(process.stdout, diff.added, 'accepted: ');
    return;
  }

  const diff = diffAgainstBaseline(current, baseline);

  if (diff.resolved.length > 0) {
    process.stdout.write(
      `interface properties: ${diff.resolved.length} baselined finding(s) no longer occur — ` +
        'run `pnpm run lint:dead-code:props:update` to tighten the baseline:\n',
    );
    printKeys(process.stdout, diff.resolved, '- ');
  }

  if (diff.added.length === 0) {
    process.stdout.write(
      `interface properties: no new never-read properties (${baseline.length} baselined finding(s)) ✓\n`,
    );
  } else {
    process.stderr.write(`\nERROR: ${diff.added.length} never-read interface propert(ies):\n`);
    printKeys(process.stderr, diff.added, '');
    process.stderr.write(
      '\nEach of these is written somewhere and read nowhere. Either read it or delete it. ' +
        'If a finding moved for a legitimate reason, rerun with ' +
        '`pnpm run lint:dead-code:props:update` and explain the change in the PR.\n',
    );
  }

  // Set the code rather than calling process.exit(): stdout and stderr are async
  // when they are pipes, as under CI, and exiting outright truncates the finding
  // list that makes a failure actionable.
  process.exitCode = exitCodeForDiff(diff);
}

try {
  main();
} catch (error) {
  process.stderr.write(`\nERROR: interface-property gate could not run: ${error.message}\n`);
  process.exitCode = 2;
}
