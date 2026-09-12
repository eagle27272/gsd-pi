# Obsolete Migration and Legacy-Path Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the migration and legacy-path machinery that can no longer fire in this personal fork, replacing it with one explicit guard that fails loudly on a legacy-layout project.

**Architecture:** Four waves in dependency order, leaf-first, one commit each. Wave 1 removes telemetry counters and MCP tool aliases. Wave 2 removes the `gsd migrate` command. Wave 3 extracts two general-purpose helpers out of the legacy-import kernel, then deletes the kernel. Wave 4 removes pre-flat-phase path resolution and the in-repo-to-external state relocation, and adds the guard. Each wave is independently revertable.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers pointing at `.ts` sources), Node's built-in test runner via `dist-test/`, pnpm workspaces, a Rust/napi native addon.

**Spec:** [`docs/superpowers/specs/2026-09-11-obsolete-migration-removal-design.md`](../specs/2026-09-11-obsolete-migration-removal-design.md)

## Global Constraints

- **Worktree must be built before any verification.** A fresh worktree fails both gates for artifact reasons, not code reasons. Run once, before Task 1:
  ```bash
  pnpm install --frozen-lockfile
  pnpm run build:contracts && pnpm run build:pi
  pnpm run build:rpc-client && pnpm run build:mcp-server
  node native/scripts/build.js --dev --test-fault-injection
  pnpm run build:core
  ```
  `build:native-pkg` builds only the TypeScript wrapper — it does **not** build the addon. Omitting `--test-fault-injection` leaves ~23 native tests red. A bare `npx tsc` instead of `build:core` leaves a partial `dist/` that makes `app-smoke.test.ts` fail with `expected >=10 extensions, found 7`.
- **Baseline is green: 14689 passed, 0 failed, 29 skipped.** Any failure appearing during a wave was caused by that wave.
- **Verification gates, run before every commit:** `pnpm run typecheck:extensions` must exit 0, and `pnpm run test:unit` must report 0 failures. `test:unit` takes 10–15 minutes and its compact reporter buffers all output until the end — a 0-byte log does not mean it is stuck.
- **Passing count may only drop by the number of tests in files that wave deleted.** An unexplained drop is a regression signal.
- **Import specifiers use `.js` even though sources are `.ts`.** Match the surrounding style in each file.
- **Do not touch:** `db-migration-steps.ts`, any `db-*-schema.ts`, `migration-auto-check.ts`, the `skill-md`/`agent-md` loaders in `component-loader.ts`, the `markdown-phase` workflow engine, the provider-default fallback in `model-router.ts`, the UOK parity fallback in `uok/kernel.ts`, `src/pi-migration.ts`, `src/provider-migrations.ts`, `packages/pi-coding-agent/**`, `md-importer.ts`.
- **`tests/migrate-safety-audit.test.ts` and `tests/migrate-hierarchy.test.ts` survive all four waves.** Their names match `migrate-*` but they test the native tree-publication engine and `md-importer.ts` respectively, not the `migrate/` directory.

---

## Wave 1 — Legacy telemetry counters and MCP tool aliases

### Task 1: Remove the legacy telemetry counters

The five `legacy.*` counters existed to prove a compat path had gone unused before deletion. Four of the five paths they guard are staying (see Global Constraints), so only the counting apparatus goes. Each call site is deleted along with its now-unused import; the surrounding logic is untouched.

**Files:**
- Delete: `src/resources/extensions/gsd/legacy-telemetry.ts`
- Delete: `src/resources/extensions/gsd/tests/legacy-telemetry.test.ts`
- Delete: `src/resources/extensions/gsd/tests/legacy-component-format-telemetry.test.ts`
- Delete: `src/tests/legacy-cleanup-gate.test.ts`
- Delete: `src/tests/legacy-cleanup-evidence.test.ts`
- Delete: `scripts/legacy-cleanup-gate.mjs`
- Delete: `scripts/legacy-cleanup-evidence.mjs`
- Delete: `scripts/legacy-state-path-proof.mjs`
- Modify: `src/resources/extensions/gsd/component-loader.ts:8,265,341`
- Modify: `src/resources/extensions/gsd/uok/kernel.ts:19,188`
- Modify: `src/resources/extensions/gsd/model-router.ts:8,1061`
- Modify: `src/resources/extensions/gsd/commands-workflow-templates.ts:32,504,671`
- Modify: `package.json:71-73`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing. After this task the identifiers `incrementLegacyTelemetry`, `getLegacyTelemetry`, `resetLegacyTelemetry`, `listLegacyTelemetryCounters`, `getLegacyTelemetryReport`, `persistLegacyTelemetrySnapshot`, `LegacyTelemetryCounter`, `LegacyTelemetrySnapshot`, and `LegacyTelemetryReport` no longer exist anywhere in the repo.

- [ ] **Step 1: Confirm the current call-site inventory**

Run:
```bash
rg -n 'incrementLegacyTelemetry|legacy-telemetry' -g '*.ts' src | rg -v '/tests/'
```
Expected: exactly 12 lines — one import and one or two calls in each of `bootstrap/db-tools.ts`, `component-loader.ts`, `uok/kernel.ts`, `model-router.ts`, `commands-workflow-templates.ts`. If the count differs, stop and reconcile against this plan before editing.

- [ ] **Step 2: Remove the call site in `uok/kernel.ts`**

Delete the import on line 19 (`import { incrementLegacyTelemetry } from "../legacy-telemetry.js";`).

Replace this block at line ~186:
```typescript
    if (plan.pathLabel !== "uok-kernel") {
      incrementLegacyTelemetry("legacy.uokFallbackUsed");
    }

```
with nothing — delete the whole `if` statement and the blank line after it. The `plan.pathLabel` check exists only to feed the counter; the fallback behavior itself lives elsewhere and is unchanged.

- [ ] **Step 3: Remove the call site in `model-router.ts`**

Delete the import on line 8. At line ~1061, this block:
```typescript
  if (availableModelIds.length === 0) {
    if (preferredModelId) {
      return normalizeResolvedTierModelId(preferredModelId, tier, routingConfig);
    }
    incrementLegacyTelemetry("legacy.providerDefaultUsed");
    return canonicalModelForTier(tier);
  }
```
becomes:
```typescript
  if (availableModelIds.length === 0) {
    if (preferredModelId) {
      return normalizeResolvedTierModelId(preferredModelId, tier, routingConfig);
    }
    return canonicalModelForTier(tier);
  }
```

- [ ] **Step 4: Remove the call sites in `component-loader.ts`**

Delete the import on line 8. Delete the single line `	incrementLegacyTelemetry('legacy.componentFormatUsed');` at line 265 and again at line 341, each with its preceding blank line. Both sit immediately before a `return { component, diagnostics };` — leave those returns and the `format: 'skill-md'` / `format: 'agent-md'` fields exactly as they are.

- [ ] **Step 5: Remove the call sites in `commands-workflow-templates.ts`**

Delete the import on line 32. At line ~503, this block:
```typescript
  if (isLegacyWorkflowMode(template.mode)) {
    incrementLegacyTelemetry("legacy.workflowEngineUsed");
  }
```
is deleted entirely. At line ~671, delete the bare line `  incrementLegacyTelemetry("legacy.workflowEngineUsed");`.

If `isLegacyWorkflowMode` now has no remaining callers, delete its definition too. Check with:
```bash
rg -n 'isLegacyWorkflowMode' -g '*.ts' src
```
If any caller remains, leave the function alone.

- [ ] **Step 6: Leave `bootstrap/db-tools.ts` alone**

Make no change to this file in this task. Its only telemetry call sits inside `registerAlias`, which Task 2 deletes wholesale — editing it here would mean touching the same function twice.

This is why Tasks 1 and 2 share a commit: Task 1 deletes `legacy-telemetry.ts` while `db-tools.ts` still imports it, so the tree does not typecheck between them. That intermediate state is expected and lasts only until Task 2 Step 1.

- [ ] **Step 7: Delete the telemetry module, gate scripts, and their tests**

```bash
git rm src/resources/extensions/gsd/legacy-telemetry.ts \
       src/resources/extensions/gsd/tests/legacy-telemetry.test.ts \
       src/resources/extensions/gsd/tests/legacy-component-format-telemetry.test.ts \
       src/tests/legacy-cleanup-gate.test.ts \
       src/tests/legacy-cleanup-evidence.test.ts \
       scripts/legacy-cleanup-gate.mjs \
       scripts/legacy-cleanup-evidence.mjs \
       scripts/legacy-state-path-proof.mjs
```

- [ ] **Step 8: Remove the package.json scripts**

Delete these three lines from `package.json` (lines 71–73):
```json
    "legacy:cleanup:gate": "node scripts/legacy-cleanup-gate.mjs",
    "legacy:cleanup:evidence": "node scripts/legacy-cleanup-evidence.mjs",
    "legacy:cleanup:proof": "node scripts/legacy-state-path-proof.mjs",
```
Check no CI workflow invokes them:
```bash
rg -n 'legacy:cleanup' .github/ package.json
```
Expected: no output.

- [ ] **Step 9: Verify only the expected reference survives**

Run:
```bash
rg -n 'legacy-telemetry|incrementLegacyTelemetry|LegacyTelemetry|legacy-cleanup|legacy-state-path-proof' -g '!docs/**' -g '!plans/**' .
```
Expected: exactly two matches, both in `src/resources/extensions/gsd/bootstrap/db-tools.ts` — the import on line 10 and the call on line 66. Task 2 removes both. Any other match means a call site was missed.

- [ ] **Step 10: Do not typecheck or commit yet**

The tree is intentionally broken at this point: `legacy-telemetry.ts` is gone but `db-tools.ts` still imports it. Proceed directly to Task 2, which closes the gap. The Wave 1 gates run at Task 2 Steps 7–8.

---

### Task 2: Remove the MCP tool aliases

Deprecated alias names for the canonical `gsd_*` workflow tools. They are already off by default — `registerWorkflowTool` returns early unless `GSD_ADVERTISE_TOOL_ALIASES=1`. This task removes the registration path and the last legacy-telemetry call site, completing the Wave 1 commit.

**Files:**
- Modify: `src/resources/extensions/gsd/bootstrap/db-tools.ts:10,52-91`
- Modify: `src/resources/extensions/gsd/auto-unit-tool-scope.ts:7,38`
- Delete: `src/resources/extensions/gsd/tests/db-tools-alias-suppression.test.ts`

**Interfaces:**
- Consumes: Task 1's deletion of `legacy-telemetry.ts`.
- Produces: `registerWorkflowTool(pi: ExtensionAPI, toolDef: any): void` keeps its signature but no longer registers aliases. `registerAlias` no longer exists.

- [ ] **Step 1: Delete the legacy-telemetry import and `registerAlias`**

In `src/resources/extensions/gsd/bootstrap/db-tools.ts`, delete line 10:
```typescript
import { incrementLegacyTelemetry } from "../legacy-telemetry.js";
```

Delete lines 52–82 in full — the doc comment, the eslint-disable, and the whole `registerAlias` function:
```typescript
/**
 * Register an alias tool that shares the same execute function as its canonical counterpart.
 * The alias description and promptGuidelines direct the LLM to prefer the canonical name.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- toolDef shape matches ToolDefinition but typing it fully requires generics
function registerAlias(
	pi: ExtensionAPI,
	toolDef: any,
	aliasName: string,
	canonicalName: string,
): void {
	const execute =
		typeof toolDef.execute === "function"
			? async (...args: any[]) => {
					incrementLegacyTelemetry("legacy.mcpAliasUsed");
					return toolDef.execute(...args);
				}
			: toolDef.execute;

	pi.registerTool({
		...toolDef,
		name: aliasName,
		description:
			toolDef.description +
			` (alias for ${canonicalName} — prefer the canonical name)`,
		promptGuidelines: [
			`Alias for ${canonicalName} — prefer the canonical name.`,
		],
		execute,
	});
}
```

- [ ] **Step 2: Simplify `registerWorkflowTool`**

Replace:
```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- toolDef shape matches ToolDefinition but varies by schema
function registerWorkflowTool(pi: ExtensionAPI, toolDef: any): void {
	pi.registerTool(toolDef);
	if (process.env.GSD_ADVERTISE_TOOL_ALIASES !== "1") return; // canonical-only model surface (see plan 035)
	for (const alias of aliasesForWorkflowTool(toolDef.name)) {
		registerAlias(pi, toolDef, alias, toolDef.name);
	}
}
```
with:
```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- toolDef shape matches ToolDefinition but varies by schema
function registerWorkflowTool(pi: ExtensionAPI, toolDef: any): void {
	pi.registerTool(toolDef);
}
```

- [ ] **Step 3: Drop the now-unused `aliasesForWorkflowTool` import**

Delete line 21:
```typescript
import { aliasesForWorkflowTool } from "../workflow-tool-surface.js";
```

Also update the file-purpose comment on line 2, which now overstates what the file does:
```typescript
// File Purpose: Registers DB-backed GSD workflow tools and compatibility aliases.
```
becomes:
```typescript
// File Purpose: Registers DB-backed GSD workflow tools.
```

- [ ] **Step 4: Switch `auto-unit-tool-scope.ts` off the alias table**

Line 38 reads the canonical side of the alias pairs, so it does not need the alias table at all:
```typescript
    ...WORKFLOW_TOOL_ALIAS_PAIRS.map(({ canonical }) => canonical),
```
becomes:
```typescript
    ...CANONICAL_WORKFLOW_TOOL_NAMES,
```
and in the import block at line 7, replace `WORKFLOW_TOOL_ALIAS_PAIRS` with `CANONICAL_WORKFLOW_TOOL_NAMES`. Both are exported from `workflow-tool-surface.ts` (lines 19 and 23).

- [ ] **Step 5: Delete the alias-suppression test**

```bash
git rm src/resources/extensions/gsd/tests/db-tools-alias-suppression.test.ts
```
This test asserts that aliases are suppressed unless the env var is set. With aliases gone the behavior it guards no longer exists.

- [ ] **Step 6: Check the remaining alias-table consumers**

Run:
```bash
rg -n 'WORKFLOW_TOOL_ALIAS_PAIRS|WORKFLOW_TOOL_ALIAS_NAMES|WORKFLOW_TOOL_ALIAS_TO_CANONICAL|aliasesForWorkflowTool' -g '*.ts' src packages | rg -v dist
```
Expected remaining matches, all of which stay: `packages/contracts/src/workflow.ts` (the source tables), `src/resources/extensions/gsd/workflow-tool-surface.ts` (re-exports), `packages/mcp-server/src/workflow-tools.ts` plus its two tests, and `src/resources/extensions/gsd/tests/{engine-hook-contract,tool-naming}.test.ts`.

Leave all of them. The packaged `gsd-workflow` MCP server has its own separate opt-in (`GSD_MCP_ADVERTISE_ALIASES`) and is a different surface from the in-process tools; collapsing both is out of scope for this plan.

- [ ] **Step 7: Typecheck**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

- [ ] **Step 8: Run the full unit suite**

Run: `pnpm run test:unit`
Expected: 0 failures. The passing count should drop by the number of tests in the four deleted test files. Record the new count.

- [ ] **Step 9: Commit Wave 1**

```bash
git add -A
git commit -m "refactor: drop legacy telemetry counters and MCP tool aliases

The five legacy.* counters existed to prove a compat path had gone
unused before deleting it. Four of the five paths they measured are
staying -- the skill-md loader every shipped skill uses, the
markdown-phase engine behind half the workflow templates, the
provider-default fallback, and the UOK parity fallback -- so only the
counting apparatus goes, along with the gate scripts built around it.

Also removes the deprecated workflow tool aliases, which were already
off unless GSD_ADVERTISE_TOOL_ALIASES=1. The contracts-level alias
tables stay: the packaged MCP server advertises them under its own
separate opt-in."
```

---

## Wave 2 — The `gsd migrate` command

### Task 3: Delete the v1 `.planning` migration command

Converts a v1 `.planning/` directory into a DB-backed `.gsd/`. Every project in this fork is already converted. The directory has no static importers — it is reached only through two dynamic `import()` calls.

**Files:**
- Delete: `src/resources/extensions/gsd/migrate/` (all 16 files)
- Delete: `src/resources/extensions/gsd/tests/migrate-parser.test.ts`
- Delete: `src/resources/extensions/gsd/tests/migrate-plan.test.ts`
- Delete: `src/resources/extensions/gsd/tests/migrate-presentation.test.ts`
- Delete: `src/resources/extensions/gsd/tests/migrate-transformer.test.ts`
- Delete: `src/resources/extensions/gsd/tests/migrate-validator-parsers.test.ts`
- Delete: `src/resources/extensions/gsd/tests/migrate-writer.test.ts`
- Modify: `src/resources/extensions/gsd/commands/handlers/ops.ts:252-255`
- Modify: `src/resources/extensions/gsd/guided-flow.ts:1964`
- Modify: `src/resources/extensions/gsd/commands/catalog.ts:22,75`

**Interfaces:**
- Consumes: nothing from Wave 1.
- Produces: the `migrate` slash command no longer resolves. `handleMigrate` no longer exists.

- [ ] **Step 1: Confirm `migrate/` has no static importers**

Run:
```bash
rg -l "from ['\"]\.\./migrate/|from ['\"]\./migrate/" -g '*.ts' src/resources/extensions/gsd | rg -v '/tests/|/migrate/'
```
Expected: no output. If anything appears, stop — a static dependency means this task's scope is wrong.

- [ ] **Step 2: Remove the command dispatch in `commands/handlers/ops.ts`**

Delete this block at lines 252–255:
```typescript
  if (trimmed === "migrate" || trimmed.startsWith("migrate ")) {
    const { handleMigrate } = await import("../../migrate/command.js");
    await handleMigrate(trimmed.replace(/^migrate\s*/, "").trim(), ctx, pi);
```
Include the block's closing lines — read the surrounding `if` to find where it ends (it will `return` something) and delete through that closing brace.

- [ ] **Step 3: Remove the dispatch in `guided-flow.ts`**

At line 1964:
```typescript
        const { handleMigrate } = await import("./migrate/command.js");
```
Delete this line and the guided-flow branch that invokes it. Read ~20 lines of surrounding context to find the enclosing block boundary before cutting.

- [ ] **Step 4: Remove the command from the catalog**

In `src/resources/extensions/gsd/commands/catalog.ts`, delete line 75:
```typescript
  { cmd: "migrate", desc: "Migrate a v1 .planning directory to DB-backed .gsd with backup + audit" },
```
On line 22, remove the `migrate|` token from the long pipe-delimited command string. The substring to remove is exactly `migrate|` — the surrounding tokens are `changelog|migrate|steer`, which becomes `changelog|steer`.

- [ ] **Step 5: Delete the directory and its tests**

```bash
git rm -r src/resources/extensions/gsd/migrate/
git rm src/resources/extensions/gsd/tests/migrate-parser.test.ts \
       src/resources/extensions/gsd/tests/migrate-plan.test.ts \
       src/resources/extensions/gsd/tests/migrate-presentation.test.ts \
       src/resources/extensions/gsd/tests/migrate-transformer.test.ts \
       src/resources/extensions/gsd/tests/migrate-validator-parsers.test.ts \
       src/resources/extensions/gsd/tests/migrate-writer.test.ts
```

Do **not** delete `tests/migrate-safety-audit.test.ts` (tests the native tree-publication engine via `atomic-write.ts`, `database-maintenance-fence.ts`, `db/domain-operation.ts`, `db/engine.ts`), `tests/migrate-hierarchy.test.ts` (tests `gsd-db.ts` and `md-importer.ts`), or the two `migrate-external-*.test.ts` files (Wave 4 owns those).

- [ ] **Step 6: Verify no dangling references**

Run:
```bash
rg -n 'migrate/command|migrate/execution|migrate/audit|handleMigrate|migrate/publication-store' -g '*.ts' src packages | rg -v dist
```
Expected: no output.

- [ ] **Step 7: Check the docs for a now-dead command reference**

Run:
```bash
rg -ln '/gsd migrate|gsd migrate' docs/ README.md
```
For each hit, remove the `migrate` row or sentence. Do not rewrite surrounding prose beyond what the removal requires. `docs/user-docs/migration.md` and `docs/zh-CN/user-docs/migration.md` document the migration process end-to-end; delete both files, and remove any table-of-contents or index entries pointing at them (check `docs/README.md` and `docs/user-docs/` index files).

- [ ] **Step 8: Typecheck**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

- [ ] **Step 9: Run the full unit suite**

Run: `pnpm run test:unit`
Expected: 0 failures. Passing count drops by the tests in the six deleted files.

- [ ] **Step 10: Commit Wave 2**

```bash
git add -A
git commit -m "refactor: remove the gsd migrate command

Converted a v1 .planning directory into a DB-backed .gsd. Every project
in this fork is already converted, and the directory had no static
importers -- only two dynamic import() dispatch sites.

Keeps migrate-safety-audit.test.ts and migrate-hierarchy.test.ts, which
match the migrate-* name but cover the native tree-publication engine
and md-importer respectively."
```

---

## Wave 3 — The legacy-import kernel

### Task 4: Extract the canonical-JSON helpers before deleting the kernel

`canonicalLegacyImportJson` and `hashLegacyImportValue` are thin, general-purpose primitives — deterministic canonical JSON and a sha256 over it — that happen to live inside `legacy-import-preview.ts`. `commands-maintenance.ts` uses them for the live DB backup/restore feature, which is staying. They must move out before the kernel is deleted.

**Files:**
- Create: `src/resources/extensions/gsd/canonical-json.ts`
- Create: `src/resources/extensions/gsd/tests/canonical-json.test.ts`
- Modify: `src/resources/extensions/gsd/commands-maintenance.ts:1130,1161,1575`
- Modify: `src/resources/extensions/gsd/db-workspace.ts`
- Modify: `src/resources/extensions/gsd/db/domain-operation.ts`

**Interfaces:**
- Consumes: nothing from Waves 1–2.
- Produces:
  - `export type Sha256 = \`sha256:${string}\``
  - `export type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue }`
  - `export function canonicalJson(value: unknown): string`
  - `export function hashBytes(value: string | Uint8Array): Sha256`
  - `export function hashValue(value: unknown): Sha256`

- [ ] **Step 1: Write the failing test**

Create `src/resources/extensions/gsd/tests/canonical-json.test.ts`:

```typescript
// Project/App: gsd-pi
// File Purpose: Tests the deterministic canonical-JSON and hashing primitives.

import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, hashBytes, hashValue } from "../canonical-json.js";

test("canonicalJson orders object keys deterministically", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("canonicalJson preserves array order", () => {
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
});

test("canonicalJson handles nested structures and null", () => {
  assert.equal(canonicalJson({ z: [{ y: null, x: 1 }] }), '{"z":[{"x":1,"y":null}]}');
});

test("hashBytes returns a sha256-prefixed digest", () => {
  const digest = hashBytes("abc");
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    digest,
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("hashValue is stable across key orderings", () => {
  assert.equal(hashValue({ a: 1, b: 2 }), hashValue({ b: 2, a: 1 }));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
node --experimental-strip-types --test src/resources/extensions/gsd/tests/canonical-json.test.ts
```
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../canonical-json.js`.

- [ ] **Step 3: Read the existing implementation**

Open `src/resources/extensions/gsd/legacy-import-preview.ts` and read the `canonicalJson` helper (the private recursive function that `canonicalLegacyImportJson` delegates to at line 161–163), plus `hashLegacyImportBytes` (165–167) and `hashLegacyImportValue` (169–171). Copy the private `canonicalJson` implementation verbatim — it handles cycle detection via the `Set` passed as its second argument. Do not reimplement it from scratch; a subtly different key-ordering or number-formatting rule would silently change hashes that the backup/restore feature has already written to disk.

- [ ] **Step 4: Create the new module**

Create `src/resources/extensions/gsd/canonical-json.ts` with the file-purpose header, the copied private `canonicalJson(value, seen)` implementation, the `Sha256` and `CanonicalValue` type aliases, and the three exported functions wrapping it. `canonicalJson(value)` calls the private helper with `new Set()`. Keep `createHash` imported from `node:crypto`.

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
node --experimental-strip-types --test src/resources/extensions/gsd/tests/canonical-json.test.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 6: Prove the extraction is byte-identical**

Write a scratch script that imports both the old and new implementations and compares them over a fixed corpus:
```bash
node --experimental-strip-types -e "
const oldMod = await import('./src/resources/extensions/gsd/legacy-import-preview.ts');
const newMod = await import('./src/resources/extensions/gsd/canonical-json.ts');
const cases = [
  {}, [], null, 0, '', 'x',
  { b: 1, a: 2 }, { z: [{ y: null, x: 1 }] },
  [3, 1, 2], { nested: { deep: { deeper: [1, { k: 'v' }] } } },
  { unicode: 'é中文', esc: 'a\"b\\\\c' },
];
let bad = 0;
for (const c of cases) {
  if (oldMod.canonicalLegacyImportJson(c) !== newMod.canonicalJson(c)) { bad++; console.log('JSON MISMATCH', JSON.stringify(c)); }
  if (oldMod.hashLegacyImportValue(c) !== newMod.hashValue(c)) { bad++; console.log('HASH MISMATCH', JSON.stringify(c)); }
}
console.log(bad === 0 ? 'IDENTICAL' : bad + ' MISMATCHES');
"
```
Expected: `IDENTICAL`. If not, the copy diverged — fix it before continuing. This check is only possible while the old module still exists, which is why it happens here rather than after the deletion.

- [ ] **Step 7: Rewire `commands-maintenance.ts`**

Three dynamic imports currently pull from the kernel. At line ~1130 and ~1161:
```typescript
  const { canonicalLegacyImportJson } = await import("./legacy-import-preview.js");
```
becomes:
```typescript
  const { canonicalJson } = await import("./canonical-json.js");
```
and the call sites below each (`canonicalLegacyImportJson(intent)`) become `canonicalJson(intent)`.

At line ~1575:
```typescript
    const { canonicalLegacyImportJson, hashLegacyImportValue } = await import("./legacy-import-preview.js");
```
becomes:
```typescript
    const { canonicalJson, hashValue } = await import("./canonical-json.js");
```
and rename the five call sites in the following ~25 lines: `hashLegacyImportValue(` → `hashValue(` (lines ~1577, ~1595, ~1597, ~1598, ~1599) and `canonicalLegacyImportJson(` → `canonicalJson(` (line ~1594).

Since these are static-looking dynamic imports in a live feature, convert them to top-level static imports if the surrounding code has no reason to defer loading — check whether the dynamic form was avoiding a cycle with `legacy-import-preview.js`. With the kernel gone that cycle cannot exist, so a static import is preferable.

- [ ] **Step 8: Rewire the type-only consumers**

Skip this in Task 4 — do it in Task 5 Steps 3–4 instead.

`db-workspace.ts` and `db/domain-operation.ts` import `LegacyImportValue` as a type, but Task 5 deletes most of both files. Renaming now would mean editing lines that are about to disappear. Task 5 substitutes `CanonicalValue` from `./canonical-json.js` (or `../canonical-json.js` from `db/`) only in the declarations that survive.

For reference, the current occurrences are:
```bash
rg -n 'LegacyImportValue' src/resources/extensions/gsd/db-workspace.ts src/resources/extensions/gsd/db/domain-operation.ts
```

- [ ] **Step 9: Typecheck and commit the extraction separately**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

```bash
git add src/resources/extensions/gsd/canonical-json.ts \
        src/resources/extensions/gsd/tests/canonical-json.test.ts \
        src/resources/extensions/gsd/commands-maintenance.ts
git commit -m "refactor: extract canonical-JSON helpers from the legacy-import kernel

canonicalLegacyImportJson and hashLegacyImportValue are general-purpose
deterministic-JSON and sha256 primitives that happened to live in
legacy-import-preview.ts. The live DB backup/restore path in
commands-maintenance.ts depends on them, so they move out ahead of the
kernel deletion.

Verified byte-identical against the original over a fixed corpus --
a divergent key ordering would silently invalidate hashes already
written to disk."
```

Committing the extraction on its own keeps the Wave 3 deletion diff reviewable and gives a clean revert point if the deletion goes wrong.

---

### Task 5: Delete the legacy-import kernel

**Files:**
- Delete: the 38 `src/resources/extensions/gsd/legacy-import-*.ts` modules
- Delete: `src/resources/extensions/gsd/db/writers/legacy-import-application.ts`
- Delete: `src/resources/extensions/gsd/db/writers/authority-recovery.ts`
- Delete: `src/resources/extensions/gsd/project-authority-cutover-domain-operation.ts`
- Delete: `src/resources/extensions/gsd/tests/__fixtures__/legacy-import-corpus/` (2.5MB)
- Delete: the 40 `src/resources/extensions/gsd/tests/*legacy-import*` files
- Modify: `src/resources/extensions/gsd/gsd-db.ts:76-77`
- Modify: `src/resources/extensions/gsd/db-workspace.ts:36-79`
- Modify: `src/resources/extensions/gsd/db/domain-operation.ts:17-19`
- Modify: `src/resources/extensions/gsd/commands-maintenance.ts:26-34` and the recovery command surfaces

**Interfaces:**
- Consumes: `canonicalJson`, `hashValue`, `CanonicalValue`, `Sha256` from Task 4.
- Produces: no `LegacyImport*` identifier remains in `src/`.

- [ ] **Step 1: Confirm `authority-recovery.ts` is import-only**

Run:
```bash
rg -n '^export (async )?(function|const|type|interface)' src/resources/extensions/gsd/db/writers/authority-recovery.ts
```
Expected: `AuthorityCutoverReceiptInput`, `AuthorityCutoverReceiptWriteResult`, `ImportRestoreReceiptInput`, `ImportRestoreReceiptWriteResult`, `ImportForwardRepairWriteResult`, `insertAuthorityCutoverReceipt`, `insertImportRestoreReceipt`, `applyImportForwardRepairPlan`, `insertImportForwardRepairReceipt` — all import receipts. Then:
```bash
rg -l 'authority-recovery' -g '*.ts' src | rg -v '/tests/'
```
Expected: `legacy-import-live-restore.ts`, `commands-maintenance.ts`, `project-authority-cutover-domain-operation.ts`, `legacy-import-forward-repair.ts` — every one deleted or edited by this task. Note `db-migration-steps.ts` imports `db-authority-recovery-schema.js`, a **different** file holding schema-v45 DDL. That file stays.

- [ ] **Step 2: Remove the barrel re-exports in `gsd-db.ts`**

Delete lines 76–77:
```typescript
export * from "./legacy-import-restore-assessment.js";
export * from "./legacy-import-live-restore.js";
```

- [ ] **Step 3: Strip the legacy-import imports from `db-workspace.ts`**

Delete the import blocks at lines 36–79 that pull from `legacy-import-application.js`, `legacy-import-backup.js`, `legacy-import-application-evidence.js`, `legacy-import-preview-base.js`, `legacy-import-preview.js`, `legacy-import-restore-drill.js`, `legacy-import-restore-assessment.js`, `legacy-import-live-restore.js`, and `legacy-import-contract.js`. Then delete every function in the file whose body referenced them. Work compiler-driven: after removing the imports, run `pnpm run typecheck:extensions` and delete each reported unreachable definition until it is clean.

- [ ] **Step 4: Strip `db/domain-operation.ts`**

Delete lines 17–19 (the `legacy-import-preview.js`, `legacy-import-forward-repair-plan.js`, and `legacy-import-contract.js` imports) and the declarations that used them. If `LegacyImportValue` was used in a surviving signature, substitute `CanonicalValue` from `../canonical-json.js` per Task 4 Step 8.

- [ ] **Step 5: Strip the recovery surfaces from `commands-maintenance.ts`**

Delete the imports at lines 26–34 and the command branches that used them: `requestedRestoreConsent` (line ~497), the recovery-action parsing at lines ~576–~700, and the `legacy-import.restored` event emission at lines ~1337–1344. Leave the backup/restore machinery that Task 4 rewired onto `canonical-json.js` — it is a separate feature that merely shared these helpers.

- [ ] **Step 6: Delete the kernel, the writers, and the cutover operation**

```bash
git rm src/resources/extensions/gsd/legacy-import-*.ts \
       src/resources/extensions/gsd/db/writers/legacy-import-application.ts \
       src/resources/extensions/gsd/db/writers/authority-recovery.ts \
       src/resources/extensions/gsd/project-authority-cutover-domain-operation.ts
git rm -r src/resources/extensions/gsd/tests/__fixtures__/legacy-import-corpus/
git rm src/resources/extensions/gsd/tests/*legacy-import*
```

- [ ] **Step 7: Sweep for stragglers**

Run:
```bash
rg -n 'LegacyImport|legacy-import|legacyImport' -g '*.ts' src packages | rg -v dist
```
Expected: no output. Also check the fixture workers referenced by deleted tests are gone:
```bash
ls src/resources/extensions/gsd/tests/fixtures/ | rg 'legacy-import'
```
Expected: no output.

- [ ] **Step 8: Typecheck**

Run: `pnpm run typecheck:extensions`
Expected: exit 0. Expect several iterations of Steps 3–5 before this passes; that is the intended compiler-driven workflow.

- [ ] **Step 9: Run the full unit suite**

Run: `pnpm run test:unit`
Expected: 0 failures. This is the largest single drop in passing count — roughly 40 test files' worth. Confirm the drop is accounted for by the deleted files and nothing else.

- [ ] **Step 10: Commit Wave 3**

```bash
git add -A
git commit -m "refactor: remove the legacy-import kernel

Imported a file-layout GSD project into the database, via preview,
backup, forward-repair, and live-restore stages. Every project in this
fork is already database-backed.

Removes 38 legacy-import modules, the import-receipt writers, the
authority-cutover domain operation, and a 2.5MB fixture corpus.

The schema DDL stays: db-migration-steps.ts still creates the
import-kernel tables at v35 and v45, because schema history has to
remain replayable for an existing v48 database. Those tables are now
orphaned by design."
```

---

## Wave 4 — Pre-flat-phase pathing, external-state relocation, and the guard

### Task 6: Add the legacy-layout guard

Written before the removals it protects, so the failure mode exists the moment the fallbacks disappear.

**Files:**
- Create: `src/resources/extensions/gsd/legacy-layout-guard.ts`
- Create: `src/resources/extensions/gsd/tests/legacy-layout-guard.test.ts`

**Interfaces:**
- Consumes: nothing from Waves 1–3.
- Produces:
  - `export type LegacyLayoutFinding = { kind: "milestones-layout" | "planning-v1" | "in-repo-state"; path: string }`
  - `export function detectLegacyLayout(basePath: string): LegacyLayoutFinding | null`
  - `export function assertNoLegacyLayout(basePath: string): void` — throws `Error` when `detectLegacyLayout` returns non-null

- [ ] **Step 1: Write the failing test**

Create `src/resources/extensions/gsd/tests/legacy-layout-guard.test.ts`:

```typescript
// Project/App: gsd-pi
// File Purpose: Tests detection of the three pre-migration on-disk layouts.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertNoLegacyLayout, detectLegacyLayout } from "../legacy-layout-guard.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "gsd-legacy-guard-"));
}

test("detects a content-bearing milestones/<MID>/ layout", () => {
  const root = makeRoot();
  const milestone = join(root, ".gsd", "milestones", "M001");
  mkdirSync(milestone, { recursive: true });
  writeFileSync(join(milestone, "ROADMAP.md"), "# roadmap\n");

  const finding = detectLegacyLayout(root);

  assert.equal(finding?.kind, "milestones-layout");
});

test("ignores an empty milestones/ directory", () => {
  const root = makeRoot();
  mkdirSync(join(root, ".gsd", "milestones"), { recursive: true });
  mkdirSync(join(root, ".gsd", "phases"), { recursive: true });

  assert.equal(detectLegacyLayout(root), null);
});

test("ignores a milestones/<MID>/ holding only META json", () => {
  const root = makeRoot();
  const milestone = join(root, ".gsd", "milestones", "M001");
  mkdirSync(milestone, { recursive: true });
  writeFileSync(join(milestone, "M001-META.json"), "{}\n");

  assert.equal(detectLegacyLayout(root), null);
});

test("detects a v1 .planning directory", () => {
  const root = makeRoot();
  mkdirSync(join(root, ".planning"), { recursive: true });
  writeFileSync(join(root, ".planning", "ROADMAP.md"), "# roadmap\n");

  const finding = detectLegacyLayout(root);

  assert.equal(finding?.kind, "planning-v1");
});

test("detects an in-repo .gsd that is a real directory", () => {
  const root = makeRoot();
  mkdirSync(join(root, ".gsd", "phases"), { recursive: true });

  const finding = detectLegacyLayout(root);

  assert.equal(finding?.kind, "in-repo-state");
});

test("accepts a .gsd symlink pointing at external state", () => {
  const root = makeRoot();
  const external = makeRoot();
  mkdirSync(join(external, "phases"), { recursive: true });
  symlinkSync(external, join(root, ".gsd"));

  assert.equal(detectLegacyLayout(root), null);
});

test("assertNoLegacyLayout names the last version that could migrate", () => {
  const root = makeRoot();
  mkdirSync(join(root, ".planning"), { recursive: true });
  writeFileSync(join(root, ".planning", "ROADMAP.md"), "# roadmap\n");

  assert.throws(() => assertNoLegacyLayout(root), /v1\.18\.0/);
});

test("assertNoLegacyLayout is a no-op on a clean project", () => {
  const root = makeRoot();
  const external = makeRoot();
  mkdirSync(join(external, "phases"), { recursive: true });
  symlinkSync(external, join(root, ".gsd"));

  assert.doesNotThrow(() => assertNoLegacyLayout(root));
});
```

Note the ordering constraint the tests encode: the `in-repo-state` check must run **after** the `milestones-layout` check, or the fifth test would shadow the first. Implement the checks in the order milestones → planning → in-repo.

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
node --experimental-strip-types --test src/resources/extensions/gsd/tests/legacy-layout-guard.test.ts
```
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../legacy-layout-guard.js`.

- [ ] **Step 3: Implement the guard**

Create `src/resources/extensions/gsd/legacy-layout-guard.ts`. The content-bearing test mirrors the semantics currently in `paths.ts` (`dirIsContentBearingLegacyMilestone`), which Task 9 deletes — a milestone directory counts as real legacy content when it holds any non-`*-META.json` regular file, or a non-empty subdirectory that is not a known runtime dir (`anchors`).

```typescript
// Project/App: gsd-pi
// File Purpose: Fails closed when a project still uses a pre-migration on-disk layout.

import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LEGACY_MILESTONE_RUNTIME_DIRS = new Set(["anchors"]);
const LAST_MIGRATING_VERSION = "v1.18.0";

export type LegacyLayoutFinding = {
  kind: "milestones-layout" | "planning-v1" | "in-repo-state";
  path: string;
};

function isContentBearingMilestone(dir: string): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile()) {
      if (!/-META\.json$/i.test(entry.name)) return true;
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (LEGACY_MILESTONE_RUNTIME_DIRS.has(entry.name)) continue;
    try {
      if (readdirSync(join(dir, entry.name)).length > 0) return true;
    } catch {
      // Unreadable subdirectory proves nothing; keep scanning.
    }
  }
  return false;
}

export function detectLegacyLayout(basePath: string): LegacyLayoutFinding | null {
  const gsd = join(basePath, ".gsd");

  const milestones = join(gsd, "milestones");
  if (existsSync(milestones)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(milestones);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const candidate = join(milestones, entry);
      try {
        if (!statSync(candidate).isDirectory()) continue;
      } catch {
        continue;
      }
      if (isContentBearingMilestone(candidate)) {
        return { kind: "milestones-layout", path: candidate };
      }
    }
  }

  const planning = join(basePath, ".planning");
  if (existsSync(planning)) {
    return { kind: "planning-v1", path: planning };
  }

  if (existsSync(gsd)) {
    try {
      if (lstatSync(gsd).isDirectory()) {
        return { kind: "in-repo-state", path: gsd };
      }
    } catch {
      // An unreadable .gsd is not evidence of a legacy layout.
    }
  }

  return null;
}

const REMEDIES: Record<LegacyLayoutFinding["kind"], string> = {
  "milestones-layout":
    "This project uses the pre-flat-phase milestones/<MID>/ layout.",
  "planning-v1": "This project still has a v1 .planning directory.",
  "in-repo-state":
    "This project keeps its state in an in-repo .gsd directory rather than a symlink to ~/.gsd/projects/<hash>/.",
};

export function assertNoLegacyLayout(basePath: string): void {
  const finding = detectLegacyLayout(basePath);
  if (!finding) return;
  throw new Error(
    `${REMEDIES[finding.kind]}\n` +
      `  Found: ${finding.path}\n` +
      `  Support for migrating this layout was removed. ` +
      `GSD ${LAST_MIGRATING_VERSION} is the last version that can convert it.`,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
node --experimental-strip-types --test src/resources/extensions/gsd/tests/legacy-layout-guard.test.ts
```
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

```bash
git add src/resources/extensions/gsd/legacy-layout-guard.ts \
        src/resources/extensions/gsd/tests/legacy-layout-guard.test.ts
git commit -m "feat: add the legacy-layout guard

Lands ahead of the removals it protects so the failure mode exists the
moment the fallbacks disappear. Without it a legacy-layout project
would present as an empty hierarchy, and the recovery machinery --
which writes -- could act on that misreading."
```

---

### Task 7: Remove the in-repo to external state relocation

`migrate-external.ts` moves an in-repo `.gsd/` to `~/.gsd/projects/<hash>/` and symlinks it back. All 63 local stores are already external. The separate "ensure symlink exists" step that handles fresh projects stays.

**Files:**
- Modify: `src/resources/extensions/gsd/migrate-external.ts`
- Modify: `src/resources/extensions/gsd/auto-start.ts:32,1220-1227`
- Modify: `src/resources/extensions/gsd/auto.ts:204`
- Modify: `src/resources/extensions/gsd/doctor-runtime-checks.ts:16`
- Delete: `src/resources/extensions/gsd/tests/migrate-external-wedge.test.ts`
- Delete: `src/resources/extensions/gsd/tests/migrate-external-worktree.test.ts`

**Interfaces:**
- Consumes: `assertNoLegacyLayout` from Task 6.
- Produces: `migrateToExternalState`, `recoverFailedMigration`, and `isCurrentGsdStateIntactForMigratingCleanup` no longer exist.

- [ ] **Step 1: Read the call site in `auto-start.ts` before cutting**

Read lines 1210–1240. The relocation call at 1220 and its error handling at 1221–1227 are removed; the symlink step at ~1228 and everything after stay. Confirm the boundary by reading, not by line number alone — earlier edits in this wave may have shifted it.

- [ ] **Step 2: Replace the relocation call with the guard**

In `auto-start.ts`, this block:
```typescript
    closeAllWorkflowDatabases();
    const migration = migrateToExternalState(base);
    if (migration.error) {
      const isAuthoritativeStateGuard = migration.error.includes(
        "External state already exists for this project",
      );
      const severity = isAuthoritativeStateGuard ? "info" : "warning";
      ctx.ui.notify(`External state migration warning: ${migration.error}`, severity);
    }
```
becomes:
```typescript
    closeAllWorkflowDatabases();
    assertNoLegacyLayout(base);
```
Update the import on line 32 from `migrate-external.js` to `assertNoLegacyLayout` from `./legacy-layout-guard.js`. Keep `closeAllWorkflowDatabases()` — it checkpoints the WAL and is unrelated to the relocation. Keep the symlink-ensuring code that follows.

- [ ] **Step 3: Remove the `auto.ts` call site**

Delete the `recoverFailedMigration` import at line 204 and the branch that calls it. Read ~15 lines around each call to find the enclosing block.

- [ ] **Step 4: Remove the doctor check**

In `doctor-runtime-checks.ts`, delete the line-16 import of `isCurrentGsdStateIntactForMigratingCleanup` and `recoverFailedMigration`, and the doctor check that used them. Replace that check with one calling `detectLegacyLayout(basePath)` and reporting a doctor issue when it returns non-null — doctor should report rather than throw, so use `detectLegacyLayout`, not `assertNoLegacyLayout`. Match the surrounding issue-object shape (`runGSDDoctor` issues have required fields asserted by `app-smoke.test.ts`).

- [ ] **Step 5: Delete the three exported functions**

From `migrate-external.ts`, delete `migrateToExternalState` (line 37), `isCurrentGsdStateIntactForMigratingCleanup` (line 225), `recoverFailedMigration` (line 261), the `MigrationResult` interface (line 18), and the private helpers `normalizeResolvedPath` (238) and `isLocalGsdExternalStateJunction` (243) if nothing else uses them.

If the file is left empty, delete it and remove its imports elsewhere. If anything survives, rename the file to reflect what remains and update the file-purpose header on lines 1–7, which currently describes only the migration.

- [ ] **Step 6: Delete the two tests**

```bash
git rm src/resources/extensions/gsd/tests/migrate-external-wedge.test.ts \
       src/resources/extensions/gsd/tests/migrate-external-worktree.test.ts
```

- [ ] **Step 7: Sweep**

Run:
```bash
rg -n 'migrateToExternalState|recoverFailedMigration|isCurrentGsdStateIntactForMigratingCleanup|migrate-external' -g '*.ts' src | rg -v dist
```
Expected: no output.

- [ ] **Step 8: Typecheck**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

- [ ] **Step 9: Defer commit to Task 9**

Waves 4's three tasks share a commit. Continue to Task 8.

---

### Task 8: Remove the flat-phase migration

**Files:**
- Delete: `src/resources/extensions/gsd/flat-phase-migration.ts`
- Delete: `src/resources/extensions/gsd/tests/flat-phase-migration.test.ts`
- Delete: `src/resources/extensions/gsd/tests/register-hooks-flat-phase-migration.test.ts`
- Modify: `src/resources/extensions/gsd/bootstrap/register-hooks.ts:1190,1195,1216`
- Modify: `src/resources/extensions/gsd/state-reconciliation/index.ts:107`
- Modify: `src/resources/extensions/gsd/auto-dispatch.ts:60`

**Interfaces:**
- Consumes: nothing from Task 7.
- Produces: `needsFlatPhaseMigration`, `migrateToFlatPhase`, `pruneStaleFlatPhaseBackups`, `isFlatPhaseMigrationInFlight`, `FLAT_PHASE_BACKUP_RETENTION_MS`, and `_setFlatPhaseMigrationBoundaryForTest` no longer exist.

- [ ] **Step 1: Remove the `register-hooks.ts` call sites**

Three dynamic imports at lines 1190, 1195, and 1216. Read lines 1180–1225 and delete the whole hook body that performs the migration and the backup pruning. If that leaves an empty registered hook, remove the hook registration too rather than leaving a no-op.

- [ ] **Step 2: Remove the `state-reconciliation/index.ts` call site**

At line 107:
```typescript
      const { needsFlatPhaseMigration, migrateToFlatPhase } = await import("../flat-phase-migration.js");
```
Delete this and the surrounding conditional that runs the migration during reconciliation.

- [ ] **Step 3: Remove the `auto-dispatch.ts` in-flight check**

Delete the line-60 import of `isFlatPhaseMigrationInFlight` and the guard that consulted it. With no migration there is no in-flight state, so the dispatch path proceeds unconditionally — verify by reading that the guard's only effect was to defer dispatch.

- [ ] **Step 4: Delete the module and its tests**

```bash
git rm src/resources/extensions/gsd/flat-phase-migration.ts \
       src/resources/extensions/gsd/tests/flat-phase-migration.test.ts \
       src/resources/extensions/gsd/tests/register-hooks-flat-phase-migration.test.ts
```

- [ ] **Step 5: Sweep**

Run:
```bash
rg -n 'flat-phase-migration|needsFlatPhaseMigration|migrateToFlatPhase|isFlatPhaseMigrationInFlight|pruneStaleFlatPhaseBackups' -g '*.ts' src | rg -v dist
```
Expected: no output.

- [ ] **Step 6: Typecheck**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

- [ ] **Step 7: Defer commit to Task 9**

---

### Task 9: Strip the pre-flat-phase branches from `paths.ts`

The highest-risk edit in the plan: `paths.ts` is 1218 lines and every path resolver runs through it. Work one region at a time, typechecking between each.

**Files:**
- Modify: `src/resources/extensions/gsd/paths.ts`
- Modify: `src/resources/extensions/gsd/tests/paths-migration-staging.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 7–8.
- Produces: `isLegacyMilestonesLayout`, `isLegacyMilestonesLayoutIn`, `dirIsContentBearingLegacyMilestone`, `dirIsMetaOnlyLegacyMilestone`, `legacyMilestonesDir`, and `LEGACY_GSD_ROOT_FILES` no longer exist. All other exports keep their signatures.

- [ ] **Step 1: Inventory the legacy regions**

Run:
```bash
rg -n -i 'legacy' src/resources/extensions/gsd/paths.ts
```
Expected: roughly 33 matches clustering into these regions — the flat-phase-plus-legacy task-id regex (~251–258), legacy descriptor directories (~266–281), the suffix-resolution fallbacks (~295–314), the legacy JSON filename pattern (~341–349), `LEGACY_GSD_ROOT_FILES` (~371), the worktree-local `.gsd` comment (~401), `legacyMilestonesHasSubdirsIn` / `legacyMilestonesHasSubdirs` (~639–651), the content-bearing predicates (~654–713), `legacyMilestonesDir` (~717–733), and the milestone-directory fallback (~789, ~824–831).

Record the actual line numbers before editing; the numbers above are from the pre-Wave-1 tree.

- [ ] **Step 2: Find every external consumer of the doomed exports**

Run:
```bash
rg -n 'isLegacyMilestonesLayout|dirIsContentBearingLegacyMilestone|dirIsMetaOnlyLegacyMilestone|legacyMilestonesDir|LEGACY_GSD_ROOT_FILES' -g '*.ts' src | rg -v 'paths\.ts|dist'
```
Every hit is a call site that must be resolved in this task. For each, the caller's legacy branch is deleted along with the callee — none of these predicates has a non-legacy use.

- [ ] **Step 3: Remove the layout-detection exports and their callers**

Delete `legacyMilestonesHasSubdirsIn`, `legacyMilestonesHasSubdirs`, `dirIsContentBearingLegacyMilestone`, `dirIsMetaOnlyLegacyMilestone`, `isLegacyMilestonesLayout`, `isLegacyMilestonesLayoutIn`, and `legacyMilestonesDir`.

At the layout-aware resolver (~717):
```typescript
  // Layout-aware: return milestones/ when it has legacy content, otherwise phases/.
  if (legacyMilestonesHasSubdirsIn(projectionRoot)) {
```
collapse to the unconditional `phases/` branch — delete the conditional and keep only what the `else` path returned.

Run `pnpm run typecheck:extensions` after this region alone.

- [ ] **Step 4: Remove the milestone-directory fallback**

At ~824:
```typescript
  // Legacy fallback: milestones/M001/ (pre-flat-phase layout). Only consider a
  // milestone dir legacy if it actually carries content — git-service.ts creates
  const legacyDir = join(projectionRoot, "milestones");
  if (existsSync(legacyDir)) {
    const candidate = resolveDir(legacyDir, milestoneId);
    if (candidate && dirIsContentBearingLegacyMilestone(join(legacyDir, candidate))) {
```
Delete the entire fallback block including its comment. The function returns whatever it returned when the fallback did not fire.

Run `pnpm run typecheck:extensions`.

- [ ] **Step 5: Remove the legacy filename fallbacks**

In the suffix resolver (~295–314), delete the two fallback branches, keeping only the current-format match:
```typescript
    // Legacy pattern match: ID-DESCRIPTOR-SUFFIX.md
```
and
```typescript
    // Legacy fallback: suffix.md
    const legacy = entries.find(e => e.toLowerCase() === `${suffix.toLowerCase()}.md`);
    if (legacy) return legacy;
```

In the task-id extractor (~251–258), delete the legacy alternative:
```typescript
  const legacy = new RegExp(`^(T\\d+)(?:-.*)?-${suffix}\\.md$`, "i").exec(fileName);
  return legacy?.[1]?.toUpperCase() ?? null;
```
and return `null` where it fell through, keeping the flat-phase `S##-T##-SUFFIX.md` branch. Update the doc comment on ~251 that says "plus legacy T##-SUFFIX.md".

In the JSON-filename lister (~341–349), drop `legacyPattern` from the filter:
```typescript
      .filter(f => currentPattern.test(f) || legacyPattern.test(f))
```
becomes:
```typescript
      .filter(f => currentPattern.test(f))
```

Run `pnpm run typecheck:extensions`.

- [ ] **Step 6: Remove the legacy descriptor-directory resolution**

At ~266–281, delete the prefix-match branch for `M001-SOMETHING` descriptor directories and its doc comment ("backward compatibility with legacy descriptor directories"), keeping the exact-match path.

- [ ] **Step 7: Remove `LEGACY_GSD_ROOT_FILES`**

Delete the constant at ~371 and the lookup that consulted it. Confirm the non-legacy root-file map fully covers `GSDRootFileKey`:
```bash
rg -n 'GSDRootFileKey' src/resources/extensions/gsd/paths.ts
```

- [ ] **Step 8: Update the stale comment at ~730**

```typescript
 * projects that haven't been migrated yet. The migration (flat-phase-migration.ts)
```
references a module Task 8 deleted. Remove the sentence or the whole comment if it only described the fallback.

- [ ] **Step 9: Fix `paths-migration-staging.test.ts`**

Run:
```bash
node --experimental-strip-types --test src/resources/extensions/gsd/tests/paths-migration-staging.test.ts
```
Read the failures. Delete the cases asserting legacy-layout behavior; keep any covering staging paths that survive. If every case was legacy, delete the file.

- [ ] **Step 10: Final sweep**

Run:
```bash
rg -n -i 'legacy' src/resources/extensions/gsd/paths.ts
```
Expected: no output, or only comments that describe genuinely current behavior.

- [ ] **Step 11: Typecheck**

Run: `pnpm run typecheck:extensions`
Expected: exit 0.

- [ ] **Step 12: Run the full unit suite**

Run: `pnpm run test:unit`
Expected: 0 failures.

- [ ] **Step 13: Rebuild and re-run to catch resource skew**

The guard and the deletions change what ships in `dist/`. Run:
```bash
pnpm run build:core && node scripts/compile-tests.mjs && pnpm run test:unit
```
Expected: 0 failures. This catches `app-smoke.test.ts` extension-count drift that a source-only run would miss.

- [ ] **Step 14: Commit Wave 4**

```bash
git add -A
git commit -m "refactor: remove pre-flat-phase pathing and external-state relocation

Strips the milestones/<MID>/ layout detection, the T##-DESC-SUFFIX.md
and bare roadmap.md filename fallbacks, and the legacy descriptor
directory resolution from paths.ts; deletes flat-phase-migration.ts
and the in-repo .gsd to ~/.gsd/projects/<hash>/ relocation.

The fresh-project symlink step stays -- it is a separate concern from
the relocation and is how a new project reaches its external store.

A legacy-layout project now fails closed via legacy-layout-guard rather
than being silently misread as an empty hierarchy."
```

---

## Post-wave cleanup

### Task 10: Reconcile the documentation

Four waves of deletion leave prose describing commands and behaviors that no longer exist.

**Files:**
- Modify: `docs/user-docs/configuration.md`, `docs/zh-CN/user-docs/configuration.md`
- Modify: `docs/user-docs/commands.md`, `docs/zh-CN/user-docs/commands.md`
- Modify: `docs/README.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Find surviving references**

Run:
```bash
rg -ln 'gsd migrate|legacy:cleanup|flat-phase-migration|legacy-import|migrateToExternalState|\.planning' docs/ README.md CHANGELOG.md
```

- [ ] **Step 2: Edit each hit**

Remove rows, sentences, and sections describing the deleted surfaces. Leave the `GSD_MCP_ADVERTISE_ALIASES` documentation intact — the packaged MCP server still honors it. Remove the `GSD_ADVERTISE_TOOL_ALIASES` row, which Wave 1 made inert.

Keep historical entries in `CHANGELOG.md` untouched; add a new `### Removed` entry under `## [Unreleased]` summarizing the four waves.

- [ ] **Step 3: Lint the markdown**

Run:
```bash
pnpm run lint:md
```
If that script does not exist, check `package.json` for the markdownlint invocation (the repo has `.markdownlint-cli2.jsonc`) and run it.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: drop references to the removed migration surfaces"
```

---

## Verification summary

| Wave | Commit | Gate |
|---|---|---|
| 1 | telemetry counters + MCP aliases | typecheck 0, test:unit 0 failures |
| 2 | `gsd migrate` command | typecheck 0, test:unit 0 failures |
| 3a | canonical-JSON extraction | typecheck 0, byte-identical corpus check |
| 3b | legacy-import kernel | typecheck 0, test:unit 0 failures |
| 4 | pathing + relocation + guard | typecheck 0, test:unit 0 failures, plus a `build:core` rebuild |
| 5 | docs | markdownlint |

At the end, confirm the whole removal against a fresh build:

```bash
pnpm run build:core && node scripts/compile-tests.mjs && pnpm run test:unit && pnpm run typecheck:extensions
```
