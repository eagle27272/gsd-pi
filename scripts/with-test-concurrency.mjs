#!/usr/bin/env node

// Runs node with --test-concurrency pinned before the caller's arguments.
//
// The unit suite needs a concurrency ceiling: node defaults to
// availableParallelism() - 1, and on a many-core dev machine that many
// process-isolated workers either gets the run OOM-killed (exit 137, empty
// log) or oversubscribes the box badly enough to trip the 90s
// workflow-authority baseline budget. The ceiling cannot live in the caller's
// hands, because `test:unit` is a compound `&&` script and pnpm appends
// trailing args to the last sub-command only — `pnpm run test:unit
// --test-concurrency=8` silently lands the flag on test:live-workflow:unit
// and never reaches the big suite.
//
// The default ceiling is capped by node's own default rather than replacing
// it, so this stays a no-op on small CI runners: on a 4-vCPU runner node
// already picks 3, and forcing 8 there would oversubscribe the runner and make
// the timing-sensitive baseline flaky. TEST_CONCURRENCY overrides the value
// verbatim, and a --test-concurrency the caller passes still wins because node
// takes the last occurrence.

import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

const DEFAULT_CEILING = 8;

function resolveConcurrency() {
  const override = process.env.TEST_CONCURRENCY;
  if (override !== undefined && override !== '') {
    const parsed = Number(override);
    if (!Number.isInteger(parsed) || parsed < 1) {
      process.stderr.write(
        `with-test-concurrency: TEST_CONCURRENCY must be a positive integer, got ${JSON.stringify(override)}\n`,
      );
      process.exit(1);
    }
    return parsed;
  }
  return Math.max(1, Math.min(DEFAULT_CEILING, availableParallelism() - 1));
}

const nodeArgs = process.argv.slice(2);
if (nodeArgs.length === 0) {
  process.stderr.write('with-test-concurrency: expected node arguments\n');
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [`--test-concurrency=${resolveConcurrency()}`, ...nodeArgs],
  { stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  process.stderr.write(`with-test-concurrency: failed to run node: ${error.message}\n`);
  process.exit(1);
});
