// Project/App: gsd-pi
// File Purpose: Contracts for parking, unparking, cancelling and discarding Milestones with adopted canonical lifecycle history (#311).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  getMilestone,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import {
  cancelMilestone,
  discardMilestone,
  parkMilestone,
  parseParkArguments,
  unparkMilestone,
} from "../milestone-actions.ts";
import { reopenMilestone } from "../milestone-lifecycle-domain-operation.ts";
import { clearPathCache } from "../paths.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  clearPathCache();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function milestoneLifecycleStatus(): string | undefined {
  const row = db().prepare(`
    SELECT lifecycle_status FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = 'M001'
  `).get();
  return row ? String(row["lifecycle_status"]) : undefined;
}

function operationTypes(): string[] {
  return db().prepare("SELECT operation_type FROM workflow_operations ORDER BY resulting_revision")
    .all()
    .map((row) => String(row["operation_type"]));
}

function adoptAtFence(write: (context: Readonly<DomainOperationContext>) => void, key: string): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.adopt",
    idempotencyKey: key,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { key },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: "test.adopted",
        entityType: "milestone",
        entityId: "M001",
        payload: { key },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${key}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function makeAdoptedBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-park-adopted-"));
  tempDirs.add(basePath);
  const milestoneDir = join(basePath, ".gsd", "phases", "01-m001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "01-CONTEXT.md"), "# M001\n");

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Adopted", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "pending" });
  insertTask({ id: "T02", sliceId: "S02", milestoneId: "M001", status: "pending" });
  adoptAtFence((context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "completed",
    });
  }, "fixture/milestone-park-adopted/adopt");
  return basePath;
}

function parkedMarker(basePath: string): string {
  return join(basePath, ".gsd", "phases", "01-m001", "01-PARKED.md");
}

test("parking an adopted milestone pauses its canonical lifecycle and projects parked (#311)", () => {
  const basePath = makeAdoptedBase();

  assert.equal(parkMilestone(basePath, "M001", "priority shift"), true);

  assert.equal(getMilestone("M001")!.status, "parked");
  assert.equal(milestoneLifecycleStatus(), "paused");
  assert.ok(existsSync(parkedMarker(basePath)), "PARKED.md marker is written");
  assert.ok(operationTypes().includes("milestone.park"), "park is a durable Domain Operation");
});

test("unparking an adopted milestone returns its canonical lifecycle to ready (#311)", () => {
  const basePath = makeAdoptedBase();
  assert.equal(parkMilestone(basePath, "M001", "priority shift"), true);

  assert.equal(unparkMilestone(basePath, "M001"), true);

  assert.equal(getMilestone("M001")!.status, "active");
  assert.equal(milestoneLifecycleStatus(), "ready");
  assert.equal(existsSync(parkedMarker(basePath)), false, "PARKED.md marker is removed");
  assert.ok(operationTypes().includes("milestone.unpark"));
});

test("a park whose DB update is rejected throws instead of reporting success (#311)", () => {
  const basePath = makeAdoptedBase();
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.cancel",
    idempotencyKey: "fixture/milestone-park-adopted/cancel",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "cancelled",
    });
    return {
      events: [{
        eventType: "test.cancelled", entityType: "milestone", entityId: "M001",
        payload: {}, destinations: ["test"],
      }],
      projections: [{ projectionKey: "test/cancel", projectionKind: "test", rendererVersion: "1" }],
    };
  });

  assert.throws(() => parkMilestone(basePath, "M001", "too late"), /M001/);

  assert.equal(existsSync(parkedMarker(basePath)), false, "no PARKED.md is left behind");
  assert.equal(getMilestone("M001")!.status, "active");
});

test("unpark of an adopted milestone that cannot resume throws and keeps the marker (#311)", () => {
  const basePath = makeAdoptedBase();
  assert.equal(parkMilestone(basePath, "M001", "priority shift"), true);
  db().prepare("UPDATE milestones SET status = 'active' WHERE id = 'M001'").run();

  assert.throws(() => unparkMilestone(basePath, "M001"), /M001/);

  assert.ok(existsSync(parkedMarker(basePath)), "marker stays so the milestone is still parked");
});

test("discarding an adopted milestone explains how to abandon it (#311)", () => {
  const basePath = makeAdoptedBase();

  assert.throws(
    () => discardMilestone(basePath, "M001"),
    /adopted canonical lifecycle history.*\/gsd park M001.*\/gsd cancel M001/s,
  );
  assert.ok(getMilestone("M001"), "history is untouched");
});

test("parseParkArguments separates the milestone id from the reason (#311)", () => {
  assert.deepEqual(parseParkArguments(""), { targetId: "", reason: "" });
  assert.deepEqual(parseParkArguments("M007"), { targetId: "M007", reason: "" });
  assert.deepEqual(parseParkArguments('M007 "waiting on vendor"'), {
    targetId: "M007",
    reason: "waiting on vendor",
  });
  assert.deepEqual(parseParkArguments("M007-abc123 waiting on vendor"), {
    targetId: "M007-abc123",
    reason: "waiting on vendor",
  });
  assert.deepEqual(parseParkArguments('"waiting on vendor"'), {
    targetId: "",
    reason: "waiting on vendor",
  });
});

function legacyStatuses(): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const [table, key] of [["milestones", "id"], ["slices", "id"], ["tasks", "id"]] as const) {
    for (const row of db().prepare(`SELECT ${key} AS id, status FROM ${table}`).all()) {
      statuses[`${table}/${String(row["id"])}`] = String(row["status"]);
    }
  }
  return statuses;
}

function lifecycleStatuses(): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const row of db().prepare(`
    SELECT item_kind, slice_id, task_id, lifecycle_status FROM workflow_item_lifecycles
  `).all()) {
    const key = [row["item_kind"], row["slice_id"], row["task_id"]].filter(Boolean).join("/");
    statuses[key] = String(row["lifecycle_status"]);
  }
  return statuses;
}

test("cancelling an adopted milestone cancels unfinished work and keeps completed history (#311)", () => {
  const basePath = makeAdoptedBase();

  assert.equal(cancelMilestone(basePath, "M001", "scope dropped"), true);

  assert.deepEqual(legacyStatuses(), {
    "milestones/M001": "skipped",
    "slices/S01": "complete",
    "slices/S02": "skipped",
    "tasks/T01": "complete",
    "tasks/T02": "skipped",
  });
  const lifecycles = lifecycleStatuses();
  assert.equal(lifecycles["milestone"], "cancelled");
  assert.equal(lifecycles["slice/S01"], "completed", "finished slice keeps its canonical history");
  assert.equal(lifecycles["slice/S02"], "cancelled");
  assert.equal(lifecycles["task/S02/T02"], "cancelled");
  assert.ok(operationTypes().includes("milestone.cancel"));
});

test("a cancelled milestone is no longer parked and can be reopened (#311)", () => {
  const basePath = makeAdoptedBase();
  assert.equal(parkMilestone(basePath, "M001", "pause first"), true);

  assert.equal(cancelMilestone(basePath, "M001", "scope dropped"), true);

  assert.equal(existsSync(parkedMarker(basePath)), false, "stale PARKED.md marker is removed");
  assert.equal(milestoneLifecycleStatus(), "cancelled");

  reopenMilestone({
    invocation: {
      idempotencyKey: "test/milestone-cancel/reopen",
      sourceTransport: "internal",
      actorType: "user",
    },
    milestoneId: "M001",
    reason: "scope came back",
  });
  assert.equal(milestoneLifecycleStatus(), "ready");
  assert.equal(getMilestone("M001")!.status, "active");
});

test("cancelling refuses a milestone that is already complete (#311)", () => {
  const basePath = makeAdoptedBase();
  db().prepare("UPDATE milestones SET status = 'complete' WHERE id = 'M001'").run();

  assert.equal(cancelMilestone(basePath, "M001", "too late"), false);
  assert.equal(getMilestone("M001")!.status, "complete");
});

test("cancelling an unknown milestone reports not found (#311)", () => {
  const basePath = makeAdoptedBase();

  assert.equal(cancelMilestone(basePath, "M099", "no such thing"), false);
});

test("cancelling requires a reason (#311)", () => {
  const basePath = makeAdoptedBase();

  assert.throws(() => cancelMilestone(basePath, "M001", "   "), /reason/);
  assert.equal(getMilestone("M001")!.status, "active");
});
