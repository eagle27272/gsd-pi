/**
 * Read the real CI surface so the tier map in audit-test-confidence.mjs can be
 * checked against it rather than trusted. Before this existed the map named a
 * `fast-gates` job that no workflow defined and --strict still passed (#191).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const WORKFLOW_DIR = '.github/workflows';
const MERGIFY_FILE = '.mergify.yml';

export function readWorkflowSources(root) {
  const dir = join(root, WORKFLOW_DIR);
  if (!existsSync(dir)) return {};
  const sources = {};
  for (const name of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    sources[name] = readFileSync(join(dir, name), 'utf8');
  }
  return sources;
}

export function readMergifySource(root) {
  const file = join(root, MERGIFY_FILE);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/**
 * Every job across every workflow, as { id, workflow, runs, if }.
 *
 * A flat list rather than a Map keyed by id: two workflows may legitimately
 * define the same job id, and collapsing them would hide one.
 */
export function parseWorkflowJobs(sources) {
  const jobs = [];
  for (const [workflow, source] of Object.entries(sources)) {
    const doc = parse(source) ?? {};
    for (const [id, job] of Object.entries(doc?.jobs ?? {})) {
      const runs = (job?.steps ?? [])
        .map((step) => step?.run)
        .filter((run) => typeof run === 'string')
        .map((run) => run.trim());
      jobs.push({ id, workflow, runs, if: job?.if ?? null });
    }
  }
  return jobs;
}

/**
 * The job names Mergify gates merges on. Conditions look like
 * `check-success = @github-actions/build-and-test`; the `@github-actions/`
 * prefix is the check *app*, so it is stripped to leave the job name.
 * Conditions may be nested inside `and:` / `or:` groups.
 */
export function parseRequiredChecks(mergifySource) {
  const required = new Set();
  if (!mergifySource.trim()) return required;

  const visit = (condition) => {
    if (Array.isArray(condition)) {
      condition.forEach(visit);
      return;
    }
    if (condition && typeof condition === 'object') {
      visit(condition.and);
      visit(condition.or);
      return;
    }
    if (typeof condition !== 'string') return;
    const match = /^check-success\s*=\s*(?:@[^/]+\/)?(.+)$/.exec(condition.trim());
    if (match) required.add(match[1].trim());
  };

  const doc = parse(mergifySource) ?? {};
  for (const rule of doc?.queue_rules ?? []) visit(rule?.merge_conditions);
  return required;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does this job still run `step`?
 *
 * Matched on whitespace boundaries rather than as a bare substring, so
 * `test:unit` does not silently accept `test:unit:compiled` — a strictly
 * narrower gate. Comment lines are stripped first so a commented-out command
 * cannot satisfy the check either.
 */
function jobRunsStep(job, step) {
  const pattern = new RegExp(`(^|\\s)${escapeRegExp(step)}(\\s|$)`);
  return job.runs.some((run) =>
    run
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .some((line) => pattern.test(line)),
  );
}

/**
 * Compare the documented CI map against the workflows and merge queue.
 *
 * `blocking` entries must exist, be required by Mergify, still run every step
 * they claim, and carry no job-level `if:` beyond the one they declare via
 * `allowedIf`. `conditional` entries must exist but are not merge-gated.
 */
export function ciMapDrift({ blocking, conditional = [], workflows, mergify }) {
  const jobs = parseWorkflowJobs(workflows);
  const required = parseRequiredChecks(mergify);
  const issues = [];
  const documented = new Set();

  for (const row of [...blocking, ...conditional]) {
    documented.add(row.ciJob);
    const matches = jobs.filter((job) => job.id === row.ciJob);
    if (matches.length === 0) {
      issues.push(`CI map names job "${row.ciJob}" but no workflow defines it`);
      continue;
    }
    for (const job of matches) {
      for (const step of row.steps ?? []) {
        if (!jobRunsStep(job, step)) {
          issues.push(
            `CI map says job "${row.ciJob}" runs "${step}" but no step in ${job.workflow} does`,
          );
        }
      }
    }
  }

  for (const row of blocking) {
    const matches = jobs.filter((job) => job.id === row.ciJob);
    if (matches.length === 0) continue;
    if (!required.has(row.ciJob)) {
      issues.push(
        `job "${row.ciJob}" is documented as blocking but is not in ${MERGIFY_FILE} merge_conditions`,
      );
    }
    for (const job of matches) {
      if (job.if && job.if !== row.allowedIf) {
        issues.push(
          `blocking job "${row.ciJob}" (${job.workflow}) has an undeclared if: ${job.if} — a blocking job that skips never reports its check`,
        );
      }
    }
  }

  for (const job of jobs) {
    if (!documented.has(job.id)) {
      issues.push(`workflow job "${job.id}" (${job.workflow}) is not documented in the CI map`);
    }
  }

  return issues;
}

/**
 * The local-tier table names CI jobs too, and it is what the human-readable
 * report prints. An empty `matchesCi` means "local only"; anything listed must
 * be a real job.
 */
export function localTierDrift({ tiers, workflows }) {
  const ids = new Set(parseWorkflowJobs(workflows).map((job) => job.id));
  const issues = [];
  for (const tier of tiers) {
    for (const ciJob of tier.matchesCi ?? []) {
      if (!ids.has(ciJob)) {
        issues.push(
          `local tier "${tier.name}" claims CI job "${ciJob}" but no workflow defines it`,
        );
      }
    }
  }
  return issues;
}

export function ciDriftForRoot(root, { blocking, conditional, localTiers }) {
  const workflows = readWorkflowSources(root);
  return [
    ...ciMapDrift({
      blocking,
      conditional,
      workflows,
      mergify: readMergifySource(root),
    }),
    ...localTierDrift({ tiers: localTiers, workflows }),
  ];
}
