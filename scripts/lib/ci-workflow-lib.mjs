/**
 * Read the real CI surface out of `.github/workflows/*.yml` and `.mergify.yml`
 * so docs and audits can assert against it instead of restating it from memory.
 *
 * Docs rot silently when a workflow is deleted; a job name only a human ever
 * compares stays "true" forever. Everything here is derived from the files.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const WORKFLOW_DIR = '.github/workflows';
const MERGIFY_FILE = '.mergify.yml';
const WORKFLOW_EXT = /\.ya?ml$/;

// Mergify prefixes a check with the GitHub App that reported it, e.g.
// `@github-actions/build-and-test`. The job id is the last segment.
const CHECK_CONDITION = /^check-success\s*=\s*(.+)$/;

/**
 * Every workflow file, with its declared triggers and job ids.
 *
 * @returns {Array<{file: string, name: string|null, triggers: string[], jobs: string[]}>}
 */
export function readWorkflows(root) {
  const dir = join(root, WORKFLOW_DIR);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((entry) => WORKFLOW_EXT.test(entry))
    .sort()
    .map((entry) => {
      const doc = parse(readFileSync(join(dir, entry), 'utf8')) ?? {};
      return {
        file: `${WORKFLOW_DIR}/${entry}`,
        name: doc.name ?? null,
        // The `yaml` package reads YAML 1.2 core schema, where a bare `on:` key
        // stays the string "on". Under YAML 1.1 it would parse as boolean true.
        triggers: Object.keys(doc.on ?? {}).sort(),
        jobs: Object.keys(doc.jobs ?? {}).sort(),
      };
    });
}

/** Every job id defined across every workflow. */
export function listJobIds(root) {
  return new Set(readWorkflows(root).flatMap((workflow) => workflow.jobs));
}

/**
 * Check names Mergify requires before a queued PR merges. These, not GitHub
 * branch protection, are what actually gate merge on this repo.
 */
export function readRequiredChecks(root) {
  const path = join(root, MERGIFY_FILE);
  if (!existsSync(path)) return [];

  const doc = parse(readFileSync(path, 'utf8')) ?? {};
  const conditions = [
    ...(doc.queue_rules ?? []).flatMap((rule) => rule.merge_conditions ?? []),
    ...(doc.pull_request_rules ?? []).flatMap((rule) => rule.conditions ?? []),
  ];

  const checks = conditions
    .filter((condition) => typeof condition === 'string')
    .map((condition) => CHECK_CONDITION.exec(condition.trim())?.[1])
    .filter(Boolean)
    .map((check) => check.split('/').pop().trim());

  return [...new Set(checks)].sort();
}

/**
 * Reconcile a documented job list against the workflows on disk.
 *
 * `documented` jobs that no workflow defines are stale doc claims. Required
 * checks that nothing documents are gates nobody wrote down — both directions
 * matter, because a silently-added gate is as confusing as a deleted one.
 */
export function diffDocumentedJobs(root, documented) {
  const actual = listJobIds(root);
  const claimed = new Set(documented);
  const required = readRequiredChecks(root);

  return {
    actual: [...actual].sort(),
    required,
    missing: [...claimed].filter((job) => !actual.has(job)).sort(),
    undocumented: [...actual].filter((job) => !claimed.has(job)).sort(),
    requiredButUndefined: required.filter((check) => !actual.has(check)),
    requiredButUndocumented: required.filter(
      (check) => actual.has(check) && !claimed.has(check),
    ),
  };
}
