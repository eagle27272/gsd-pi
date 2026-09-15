/**
 * Baseline ratchet shared by the dead-code gates: parse a committed findings
 * snapshot, diff the current run against it, and render it back deterministically.
 *
 * `label` names the owning gate in error messages so a corrupt baseline says
 * which file to regenerate.
 */

export function parseBaseline(text, label = 'baseline') {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  const findings = parsed?.findings;
  if (!Array.isArray(findings) || findings.some((key) => typeof key !== 'string')) {
    throw new Error(`${label} must hold a \`findings\` array of strings`);
  }
  return findings;
}

export function diffAgainstBaseline(current, baseline) {
  const currentSet = new Set(current);
  const baselineSet = new Set(baseline);
  return {
    added: current.filter((key) => !baselineSet.has(key)).sort(),
    resolved: baseline.filter((key) => !currentSet.has(key)).sort(),
  };
}

export function renderBaselineFile(header, keys) {
  return `${JSON.stringify({ '//': header, findings: [...keys].sort() }, null, 2)}\n`;
}

export function exitCodeForDiff(diff) {
  return diff.added.length > 0 ? 1 : 0;
}
