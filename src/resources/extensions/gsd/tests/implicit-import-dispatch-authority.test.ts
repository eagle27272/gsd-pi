// Project/App: gsd-pi
// File Purpose: Proves pre-dispatch reconciliation never imports Markdown into canonical authority.

import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import { hashBytes, hashValue, type Sha256 } from "../canonical-json.ts";
import { writeCompatMarker } from "../compat/compat-marker.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  isDbAvailable,
  openDatabase,
} from "../gsd-db.ts";
import { reconcileBeforeDispatch, type ReconciliationResult } from "../state-reconciliation.ts";
import { externalMarkdownEditHandler } from "../state-reconciliation/drift/external-markdown-edit.ts";
import { externalPlanningEditHandler } from "../state-reconciliation/drift/external-planning-edit.ts";
import type { GSDState } from "../types.ts";

const PLANNING_FIXTURE = join(
  import.meta.dirname,
  "__fixtures__",
  "round-trip",
  "planning-flat-phases",
  ".planning",
);
const CANONICAL_TABLES = [
  "milestones",
  "slices",
  "tasks",
  "slice_dependencies",
  "requirements",
  "decisions",
  "memories",
  "artifacts",
  "assessments",
  "workflow_item_lifecycles",
] as const;
const LINEAGE_TABLES = [
  "workflow_execution_attempts",
  "workflow_attempt_results",
  "workflow_kernel_checkpoints",
  "workflow_operations",
  "workflow_import_applications",
  "workflow_domain_events",
  "workflow_outbox",
  "workflow_projection_work",
  "workflow_recovery_actions",
  "workflow_recovery_budgets",
] as const;
const temporaryDirectories = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function tableSnapshot(tables: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(tables.map((table) => [
    table,
    db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

/**
 * Digest over the project authority row plus every canonical table. Replaces
 * the deleted legacy-import base snapshot: same row coverage, hashed with the
 * shared canonical-JSON primitives so the proof carries no kernel dependency.
 */
function canonicalBaseDigest(): Sha256 {
  return hashValue([
    db().prepare("SELECT * FROM project_authority ORDER BY rowid").all(),
    tableSnapshot(CANONICAL_TABLES),
  ]);
}

/** Byte-exact fingerprint of a directory tree, including symlink targets. */
function fingerprintTree(path: string, relative = ""): Sha256 {
  const rows: unknown[] = [];
  for (const name of readdirSync(join(path, relative)).sort()) {
    const child = relative ? `${relative}/${name}` : name;
    const physical = join(path, child);
    const stat = lstatSync(physical);
    if (stat.isDirectory()) rows.push([child, "directory", fingerprintTree(path, child)]);
    else if (stat.isSymbolicLink()) rows.push([child, "symlink", readlinkSync(physical)]);
    else rows.push([child, "file", hashBytes(readFileSync(physical))]);
  }
  return hashValue(rows);
}

function durableSnapshot(): Record<string, unknown> {
  return {
    base: canonicalBaseDigest(),
    authority: db().prepare("SELECT * FROM project_authority ORDER BY rowid").all(),
    canonical: tableSnapshot(CANONICAL_TABLES),
    lineage: tableSnapshot(LINEAGE_TABLES),
    totalChanges: Number(db().prepare("SELECT total_changes() AS count").get()?.["count"]),
  };
}

function makeWorkspace(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-authority-"));
  temporaryDirectories.add(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  return base;
}

function seedCanonicalHierarchy(): void {
  insertMilestone({ id: "M001", title: "Canonical milestone", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Canonical slice",
    status: "pending",
    risk: "low",
    depends: [],
    sequence: 1,
  });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Canonical task",
    status: "pending",
  });
}

function state(): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Canonical milestone" },
    activeSlice: null,
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "Continue canonical work",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } },
  };
}

function markerBytes(base: string): Buffer | null {
  const path = join(base, ".gsd", ".compat.json");
  return existsSync(path) ? readFileSync(path) : null;
}

function projectionTreeSnapshot(root: string, relative = ""): string[] {
  const rows: string[] = [];
  const entries = readdirSync(join(root, relative), { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (
      child === ".compat.json"
      || child === "gsd.db"
      || child === "gsd.db-wal"
      || child === "gsd.db-shm"
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      rows.push(`${child}/`);
      rows.push(...projectionTreeSnapshot(root, child));
    } else {
      rows.push(`${child}:${readFileSync(join(root, child)).toString("base64")}`);
    }
  }
  return rows;
}

function assertExplicitImportBlocker(result: ReconciliationResult): void {
  assert.ok(result.blockers.length > 0, "dispatch must block before importing a projection");
  const blockers = result.blockers.join("\n");
  assert.match(
    blockers,
    /database is authoritative/i,
    "blocker states that the database, not the projection, is authoritative",
  );
  assert.match(
    blockers,
    /\/gsd rebuild markdown/,
    "blocker routes the operator to the DB-first realignment command",
  );
}

function assertNoExternalImportRepair(result: ReconciliationResult): void {
  assert.equal(
    result.repaired.some((record) => (
      record.kind === "external-markdown-edit" || record.kind === "external-planning-edit"
    )),
    false,
    "runtime reconciliation must not report an external import as repaired",
  );
}

afterEach(() => {
  if (isDbAvailable()) closeDatabase();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

test("cold planning-only reconciliation ignores Markdown without capturing or adopting it", async () => {
  const base = makeWorkspace();
  cpSync(PLANNING_FIXTURE, join(base, ".planning"), { recursive: true });
  const databaseBefore = durableSnapshot();
  const markerBefore = markerBytes(base);
  const planningBefore = fingerprintTree(join(base, ".planning"));
  const projectionBefore = projectionTreeSnapshot(join(base, ".gsd"));

  const result = await reconcileBeforeDispatch(base);

  assert.equal(
    result.blockers.some((blocker) => /external modeled edit/i.test(blocker)),
    false,
    "projection observation is not a workflow blocker",
  );
  assertNoExternalImportRepair(result);
  assert.deepEqual(durableSnapshot(), databaseBefore, "canonical authority and lineage remain exact");
  assert.deepEqual(markerBytes(base), markerBefore, "inactive/default marker remains exact");
  assert.equal(
    fingerprintTree(join(base, ".planning")),
    planningBefore,
    "planning source bytes remain exact",
  );
  assert.deepEqual(
    projectionTreeSnapshot(join(base, ".gsd")),
    projectionBefore,
    "dispatch does not materialize a .gsd projection hierarchy",
  );
});

test("changed modeled .gsd projection blocks without importing or advancing its stale marker", async () => {
  const base = makeWorkspace();
  seedCanonicalHierarchy();
  const relativePath = "phases/01-canonical/01-ROADMAP.md";
  const projectionPath = join(base, ".gsd", relativePath);
  mkdirSync(join(base, ".gsd", "phases", "01-canonical"), { recursive: true });
  writeFileSync(
    projectionPath,
    [
      "# M001: Edited projection",
      "",
      "**Vision:** Markdown must not replace canonical rows during dispatch.",
      "",
      "## Slices",
      "",
      "- [x] **S01: Edited projection slice** `risk:high` `depends:[]`",
      "",
    ].join("\n"),
  );
  const siblingPath = join(base, ".gsd", "phases", "01-canonical", "01-CONTEXT.md");
  const siblingBefore = Buffer.from("# Unrelated sibling projection\n");
  writeFileSync(siblingPath, siblingBefore);
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-01T00:00:00.000Z",
    projections: {
      [relativePath]: { sha: "stale000000000000", entities: ["M001", "M001/S01"] },
    },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "test",
  });
  const databaseBefore = durableSnapshot();
  const markerBefore = markerBytes(base);
  const projectionBefore = projectionTreeSnapshot(join(base, ".gsd"));

  const result = await reconcileBeforeDispatch(base, {
    registry: [externalMarkdownEditHandler],
    invalidateStateCache: () => {},
    deriveState: async () => state(),
  });

  assertExplicitImportBlocker(result);
  assertNoExternalImportRepair(result);
  assert.deepEqual(durableSnapshot(), databaseBefore, "canonical authority and lineage remain exact");
  assert.deepEqual(markerBytes(base), markerBefore, "stale marker baseline remains exact");
  assert.deepEqual(
    projectionTreeSnapshot(join(base, ".gsd")),
    projectionBefore,
    "dispatch leaves the whole modeled .gsd projection tree exact",
  );

  writeFileSync(siblingPath, "# Sabotaged sibling projection\n");
  assert.notDeepEqual(
    projectionTreeSnapshot(join(base, ".gsd")),
    projectionBefore,
    "whole-tree proof detects an unrelated sibling projection write",
  );
  writeFileSync(siblingPath, siblingBefore);
  assert.deepEqual(projectionTreeSnapshot(join(base, ".gsd")), projectionBefore, "sibling sabotage restored");

  assert.ok(markerBefore);
  writeFileSync(join(base, ".gsd", ".compat.json"), Buffer.concat([markerBefore, Buffer.from("\n")]));
  assert.notDeepEqual(markerBytes(base), markerBefore, "marker proof detects an unrelated marker write");
  writeFileSync(join(base, ".gsd", ".compat.json"), markerBefore);
  assert.deepEqual(markerBytes(base), markerBefore, "marker sabotage restored");
});

test("changed modeled .planning projection blocks without transform, import, or marker advance", async () => {
  const base = makeWorkspace();
  seedCanonicalHierarchy();
  mkdirSync(join(base, ".planning"), { recursive: true });
  const projectionPath = join(base, ".planning", "ROADMAP.md");
  writeFileSync(
    projectionPath,
    "# Roadmap\n\n## Phases\n\n- [x] 01 — Edited projection\n",
  );
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-07-01T00:00:00.000Z",
    projections: {},
    planning: {
      active: true,
      layout: "flat-phases",
      projections: {
        "ROADMAP.md": { sha: "stale000000000000", entities: ["M001"] },
      },
      passthrough: {},
    },
    piVersion: "test",
  });
  const databaseBefore = durableSnapshot();
  const markerBefore = markerBytes(base);
  const planningBefore = fingerprintTree(join(base, ".planning"));
  const projectionBefore = projectionTreeSnapshot(join(base, ".gsd"));

  const result = await reconcileBeforeDispatch(base, {
    registry: [externalPlanningEditHandler],
    invalidateStateCache: () => {},
    deriveState: async () => state(),
  });

  assertExplicitImportBlocker(result);
  assertNoExternalImportRepair(result);
  assert.deepEqual(durableSnapshot(), databaseBefore, "canonical authority and lineage remain exact");
  assert.deepEqual(markerBytes(base), markerBefore, "planning marker baseline remains exact");
  assert.equal(
    fingerprintTree(join(base, ".planning")),
    planningBefore,
    "modeled .planning source bytes remain exact",
  );
  assert.deepEqual(
    projectionTreeSnapshot(join(base, ".gsd")),
    projectionBefore,
    "dispatch does not transform .planning into a .gsd hierarchy",
  );
});
