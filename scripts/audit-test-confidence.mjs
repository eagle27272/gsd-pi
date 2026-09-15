#!/usr/bin/env node
/**
 * Audit local verification tiers against CI jobs and surface test distribution gaps.
 *
 * Usage:
 *   node scripts/audit-test-confidence.mjs          # human-readable report
 *   node scripts/audit-test-confidence.mjs --json   # machine-readable
 *   node scripts/audit-test-confidence.mjs --strict # exit 1 if tier map drifts
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffDocumentedJobs, readWorkflows } from './lib/ci-workflow-lib.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

const args = new Set(process.argv.slice(2));
const jsonOut = args.has('--json');
const strict = args.has('--strict');

const TEST_FILE_RE = /\.(?:test|spec)\.(?:ts|tsx|mjs|js|cjs)$/;

/**
 * Every CI job this repo documents, with the local steps that approximate it.
 * `ciJob` values are reconciled against `.github/workflows/*.yml` below, so a
 * deleted job fails the audit instead of living on in prose.
 */
const CI_PR_BLOCKING_MAP = [
  {
    ciJob: 'build-and-test',
    local: 'verify:pr (nearest; not an exact match)',
    steps: [
      'pnpm install --frozen-lockfile',
      'lint:dead-code',
      'build:core',
      'typecheck:extensions',
      'build:native:test (RUSTFLAGS=-C debuginfo=0)',
      'test:unit',
    ],
    when: "head_ref starts with 'mergify/merge-queue/' — merge queue only, not on ordinary PRs",
    enforcement: 'block',
  },
];

/**
 * Gates that exist only as local scripts. They have no `ciJob` on purpose:
 * nothing in `.github/workflows/` runs them, and claiming otherwise is the
 * exact drift this audit exists to catch.
 */
const LOCAL_ONLY_GATES = [
  {
    name: 'verify:fast',
    local: 'bash scripts/ci-fast-gates.sh',
    note: 'Despite the filename, no CI job runs this. Local/pre-push only.',
  },
  {
    name: 'verify:merge',
    local: 'bash scripts/verify-merge.sh',
    note: 'Heavier than anything CI runs; the full Linux stack is local-only.',
  },
  {
    name: 'verify:merge:needed',
    local: 'bash scripts/verify-merge-needed.sh',
    note: 'Wraps scripts/ci-classify-changes.sh, which no CI job invokes.',
  },
];

const LOCAL_TIERS = [
  {
    name: 'verify:fast',
    when: 'Every push',
    matchesCi: [],
    scriptKey: 'verify:fast',
    gapNote: 'No CI equivalent — nothing in .github/workflows/ runs these gates.',
  },
  {
    name: 'verify:pr',
    when: 'Fast iteration while editing',
    matchesCi: ['build-and-test'],
    scriptKey: 'verify:pr',
    gapNote: 'Closest local analogue to the merge-queue job; also runs the no-cutover gate.',
  },
  {
    name: 'verify:merge',
    when: 'Before requesting PR review (default merge confidence)',
    matchesCi: [],
    scriptKey: 'verify:merge',
    gapNote: 'Strictly broader than CI. Nothing re-runs it after merge.',
  },
];

function loadPackageScripts() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return pkg.scripts ?? {};
}

function collectTestFiles(dir, skip = new Set(['node_modules', 'dist', 'dist-test', '.cache'])) {
  const results = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTestFiles(full, skip));
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      results.push(relative(ROOT, full).replaceAll('\\', '/'));
    }
  }
  return results;
}

function countByPrefix(files, prefix) {
  return files.filter(f => f.startsWith(prefix)).length;
}

function countSourceFiles(dir, skip = new Set(['node_modules', 'dist', 'dist-test', '.cache'])) {
  let count = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countSourceFiles(full, skip);
    } else if (
      entry.isFile() &&
      /\.(?:ts|tsx|mjs|js)$/.test(entry.name) &&
      !TEST_FILE_RE.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      count++;
    }
  }
  return count;
}

function verifyMergeScriptExists(scripts) {
  const issues = [];
  if (!scripts['verify:merge']) {
    issues.push('package.json missing scripts.verify:merge');
  }
  if (scripts['verify:full'] && !/run verify:merge$/.test(scripts['verify:full'])) {
    issues.push('verify:full should alias verify:merge for backward compatibility');
  }
  if (!existsSync(join(ROOT, 'scripts/verify-merge.sh'))) {
    issues.push('scripts/verify-merge.sh is missing');
  }
  return issues;
}

/**
 * Reconcile the documented job names above against the workflows on disk.
 * Both directions are drift: a documented job that no longer exists is a stale
 * claim, and a real job nobody documented is an unexplained merge gate.
 */
function ciJobDrift(documented) {
  const diff = diffDocumentedJobs(ROOT, documented);
  const issues = [];

  for (const job of diff.missing) {
    issues.push(
      `documented CI job '${job}' is not defined in any .github/workflows/*.yml`,
    );
  }
  for (const job of diff.undocumented) {
    issues.push(`CI job '${job}' exists in .github/workflows/ but is not documented here`);
  }
  for (const check of diff.requiredButUndefined) {
    issues.push(
      `.mergify.yml requires check '${check}', which no workflow job defines`,
    );
  }

  return { issues, diff };
}

function buildReport() {
  const scripts = loadPackageScripts();
  const allTests = collectTestFiles(ROOT);
  const thinAreas = [
    { area: 'web/', tests: countByPrefix(allTests, 'web/'), sources: countSourceFiles(join(ROOT, 'web')) },
  ].filter(row => row.sources > 0 && row.tests / row.sources < 0.05);

  const { issues: ciIssues, diff: ciDiff } = ciJobDrift(
    CI_PR_BLOCKING_MAP.map(row => row.ciJob),
  );
  const drift = [...verifyMergeScriptExists(scripts), ...ciIssues];

  return {
    generatedAt: new Date().toISOString(),
    workflows: readWorkflows(ROOT),
    requiredChecks: ciDiff.required,
    totals: {
      testFiles: allTests.length,
      byArea: {
        gsdExtension: countByPrefix(allTests, 'src/resources/extensions/gsd/'),
        srcTests: countByPrefix(allTests, 'src/tests/'),
        packages: allTests.filter(f => f.startsWith('packages/')).length,
        e2e: countByPrefix(allTests, 'tests/e2e/'),
        scripts: countByPrefix(allTests, 'scripts/'),
      },
    },
    localTiers: LOCAL_TIERS.map(tier => ({
      ...tier,
      script: scripts[tier.scriptKey] ?? null,
    })),
    ciPrBlocking: CI_PR_BLOCKING_MAP,
    localOnlyGates: LOCAL_ONLY_GATES,
    thinAreas,
    drift,
  };
}

function printHuman(report) {
  process.stdout.write('Test confidence stack audit\n');
  process.stdout.write('===========================\n\n');

  process.stdout.write(`Test files: ${report.totals.testFiles}\n`);
  process.stdout.write(
    `  GSD extension: ${report.totals.byArea.gsdExtension}, src/tests: ${report.totals.byArea.srcTests}, packages: ${report.totals.byArea.packages}, e2e: ${report.totals.byArea.e2e}\n\n`,
  );

  process.stdout.write('Workflows on disk\n');
  for (const workflow of report.workflows) {
    process.stdout.write(
      `  ${workflow.file} [on: ${workflow.triggers.join(', ')}] → ${workflow.jobs.join(', ')}\n`,
    );
  }
  process.stdout.write(`  required by .mergify.yml: ${report.requiredChecks.join(', ')}\n\n`);

  process.stdout.write('Local tiers\n');
  for (const tier of report.localTiers) {
    process.stdout.write(`  ${tier.name} — ${tier.when}\n`);
    process.stdout.write(`    CI: ${tier.matchesCi.join(', ') || 'none'}\n`);
    if (tier.gapNote) process.stdout.write(`    Note: ${tier.gapNote}\n`);
  }
  process.stdout.write('\n');

  process.stdout.write('CI PR blocking jobs → local steps\n');
  for (const row of report.ciPrBlocking) {
    process.stdout.write(`  ${row.ciJob} (${row.enforcement}): ${row.steps.join(' → ')}\n`);
    if (row.when) process.stdout.write(`    When: ${row.when}\n`);
  }
  process.stdout.write('\n');

  process.stdout.write('Local-only gates (no CI job runs these)\n');
  for (const row of report.localOnlyGates) {
    process.stdout.write(`  ${row.name}: ${row.local}\n`);
    process.stdout.write(`    ${row.note}\n`);
  }
  process.stdout.write('\n');

  if (report.thinAreas.length > 0) {
    process.stdout.write('Low test density (tests / source files < 5%)\n');
    for (const row of report.thinAreas) {
      const ratio = row.sources === 0 ? 'n/a' : `${((row.tests / row.sources) * 100).toFixed(1)}%`;
      process.stdout.write(`  ${row.area} ${row.tests} tests / ${row.sources} sources (${ratio})\n`);
    }
    process.stdout.write('\n');
  }

  if (report.drift.length > 0) {
    process.stdout.write('Tier map drift\n');
    for (const issue of report.drift) {
      process.stdout.write(`  ✗ ${issue}\n`);
    }
    process.stdout.write('\n');
  } else {
    process.stdout.write('Tier map drift: none detected ✓\n\n');
  }

  process.stdout.write('Full map: docs/dev/test-confidence-stack.md\n');
}

function main() {
  const report = buildReport();
  if (jsonOut) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }
  if (strict && report.drift.length > 0) {
    process.exit(1);
  }
}

main();
