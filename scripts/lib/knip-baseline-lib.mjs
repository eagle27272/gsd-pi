/**
 * Knip dead-code baseline: flatten a knip JSON report into stable keys and
 * diff those keys against a committed snapshot.
 */
import {
  diffAgainstBaseline,
  exitCodeForDiff,
  parseBaseline as parseBaselineText,
  renderBaselineFile as renderBaseline,
} from './baseline-ratchet.mjs';

// Must stay in step with the `include` list in knip.jsonc. Anything else in a
// report row is not a finding: knip's JSON reporter also attaches `file`, and
// `owners` once a CODEOWNERS file exists, which would otherwise flatten into
// one bogus "new finding" per row.
export const ISSUE_TYPES = Object.freeze([
  'binaries',
  'classMembers',
  'dependencies',
  'devDependencies',
  'duplicates',
  'enumMembers',
  'exports',
  'optionalPeerDependencies',
  'types',
  'unlisted',
  'unresolved',
]);

// A duplicate-export finding is a group of aliases for one symbol; sorting the
// group keeps the key stable when knip reorders them.
function symbolOf(entry) {
  if (Array.isArray(entry)) {
    return entry
      .map((alias) => alias.name)
      .sort()
      .join(',');
  }
  return entry.name;
}

/**
 * Key each finding as `type|file|symbol`, deliberately without line or column:
 * knip already dedupes internally on exactly this triple, so two findings can
 * never collide, and moving code within a file does not read as new.
 */
export function flattenKnipReport(report) {
  const keys = [];
  for (const file of report.files ?? []) keys.push(`files|${file}|`);
  for (const issue of report.issues ?? []) {
    for (const type of ISSUE_TYPES) {
      const value = issue[type];
      if (Array.isArray(value)) {
        for (const entry of value) keys.push(`${type}|${issue.file}|${symbolOf(entry)}`);
      } else if (value && typeof value === 'object') {
        // classMembers/enumMembers arrive keyed by their declaring class or enum.
        for (const [owner, members] of Object.entries(value)) {
          for (const member of members) keys.push(`${type}|${issue.file}|${owner}.${member.name}`);
        }
      }
    }
  }
  return keys.sort();
}

// knip exits 1 when it finds issues, which is the normal path for this gate.
// Any other non-zero status is a real failure and must not be read as "clean".
export function parseKnipReport({ status, stdout, stderr }) {
  if (status !== 0 && status !== 1) {
    throw new Error(`knip exited with status ${status}:\n${stderr || stdout}`);
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`knip produced no parseable JSON report (${error.message}):\n${stderr || stdout}`);
  }
}

const BASELINE_HEADER =
  'Accepted dead-code findings as of the knip rollout. Never add to this list by ' +
  'hand: delete the dead code, or regenerate with `pnpm run lint:dead-code:update` ' +
  'when a finding moves for a legitimate reason. See docs/dev/dead-code-lint.md.';

export { diffAgainstBaseline, exitCodeForDiff };

export function parseBaseline(text) {
  return parseBaselineText(text, 'knip baseline');
}

export function renderBaselineFile(keys) {
  return renderBaseline(BASELINE_HEADER, keys);
}
