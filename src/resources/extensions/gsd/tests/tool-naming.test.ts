// Project/App: gsd-pi
// File Purpose: Verifies canonical DB tool registration.

import assert from 'node:assert/strict';
import {
  WORKFLOW_TOOL_ALIAS_PAIRS,
  WORKFLOW_TOOL_CONTRACTS,
} from '../workflow-tool-surface.ts';
import { registerDbTools } from '../bootstrap/db-tools.ts';


// ─── Mock PI ──────────────────────────────────────────────────────────────────

function makeMockPi() {
  const tools: any[] = [];
  return {
    registerTool: (tool: any) => tools.push(tool),
    tools,
  } as any;
}

// ─── Registration count ──────────────────────────────────────────────────────

console.log('\n── Tool naming: registration count ──');

const pi = makeMockPi();
registerDbTools(pi);

const toolByName = new Map<string, any>(pi.tools.map((tool: any) => [tool.name, tool]));
const registeredCanonicalNames = new Set<string>(
  WORKFLOW_TOOL_CONTRACTS
    .map((tool) => tool.canonicalName)
    .filter((name) => toolByName.has(name)),
);
const RENAME_MAP = WORKFLOW_TOOL_ALIAS_PAIRS.filter(({ canonical }) =>
  registeredCanonicalNames.has(canonical),
);
const expectedRegisteredNames = [...registeredCanonicalNames].sort();

assert.equal(pi.tools.length, toolByName.size, 'Tool registration should not produce duplicate names');
assert.deepStrictEqual(
  [...toolByName.keys()].sort(),
  expectedRegisteredNames,
  'Should register only the canonical workflow surface tools',
);

for (const name of registeredCanonicalNames) {
  assert.ok(toolByName.has(name), `Canonical tool "${name}" should be registered`);
}

// ─── Canonical tools have proper promptGuidelines ────────────────────────────

console.log('\n── Tool naming: canonical promptGuidelines use canonical name ──');

for (const { canonical } of RENAME_MAP) {
  const canonicalTool = toolByName.get(canonical);

  if (canonicalTool) {
    const guidelinesText = canonicalTool.promptGuidelines.join(' ');
    assert.ok(
      guidelinesText.includes(canonical),
      `Canonical tool "${canonical}" promptGuidelines should reference its own name`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
