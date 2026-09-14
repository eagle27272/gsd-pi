// gsd-pi + Auto-mode worker registry tests (Phase B coordination)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";

import { openDatabase, closeDatabase } from "../gsd-db.ts";
import { _getAdapter } from "../gsd-db.ts";
import {
  registerAutoWorker,
  heartbeatAutoWorker,
  markWorkerCrashed,
  markWorkerStopping,
  markWorkerStoppingByPid,
  getActiveAutoWorkers,
  getAutoWorker,
  findStaleWorkerForProject,
  isAutoWorkerLive,
  isDeadLocalAutoWorker,
} from "../db/auto-workers.ts";

const FOREIGN_HOST = `${hostname()}-not-this-box`;
/** High enough to be free on a fresh box, so the local PID probe says "dead". */
const DEAD_PID = 999999999;

function setWorkerHostAndPid(workerId: string, host: string, pid: number): void {
  _getAdapter()!.prepare(
    `UPDATE workers SET host = :host, pid = :pid WHERE worker_id = :worker_id`,
  ).run({ ":host": host, ":pid": pid, ":worker_id": workerId });
}

function expireHeartbeat(workerId: string): void {
  _getAdapter()!.prepare(
    `UPDATE workers SET last_heartbeat_at = '1970-01-01T00:00:00.000Z' WHERE worker_id = :worker_id`,
  ).run({ ":worker_id": workerId });
}

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-auto-workers-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

test("registerAutoWorker creates a row with active status and heartbeat", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  assert.match(id, /^auto-/, "worker_id has expected prefix");

  const row = getAutoWorker(id);
  assert.ok(row, "row exists");
  assert.equal(row!.status, "active");
  assert.equal(row!.project_root_realpath, base);
  assert.equal(row!.pid, process.pid);
});

test("heartbeatAutoWorker updates last_heartbeat_at", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  const initial = getAutoWorker(id)!;
  await new Promise(r => setTimeout(r, 10));
  heartbeatAutoWorker(id);
  const after = getAutoWorker(id)!;
  const initialTs = Date.parse(initial.last_heartbeat_at);
  const afterTs = Date.parse(after.last_heartbeat_at);
  assert.ok(Number.isFinite(initialTs), "initial heartbeat parses");
  assert.ok(Number.isFinite(afterTs), "updated heartbeat parses");
  assert.ok(afterTs > initialTs, "heartbeat advanced");
});

test("markWorkerStopping flips status to stopping", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  markWorkerStopping(id);
  const row = getAutoWorker(id)!;
  assert.equal(row.status, "stopping");
});

test("markWorkerStoppingByPid flips matching active row to stopping", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  const pid = getAutoWorker(id)!.pid;
  markWorkerStoppingByPid(base, pid);
  const row = getAutoWorker(id)!;
  assert.equal(row.status, "stopping");
});

test("markWorkerCrashed flips status to crashed", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  markWorkerCrashed(id);
  const row = getAutoWorker(id)!;
  assert.equal(row.status, "crashed");
});

test("getActiveAutoWorkers filters by status and TTL", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const a = registerAutoWorker({ projectRootRealpath: base });
  const b = registerAutoWorker({ projectRootRealpath: base });

  const active = getActiveAutoWorkers();
  assert.equal(active.length, 2);
  assert.ok(active.find(w => w.worker_id === a));
  assert.ok(active.find(w => w.worker_id === b));

  _getAdapter()!.prepare(
    `UPDATE workers SET last_heartbeat_at = '1970-01-01T00:00:00.000Z' WHERE worker_id = :worker_id`,
  ).run({ ":worker_id": a });

  const after = getActiveAutoWorkers();
  assert.equal(after.length, 1);
  assert.equal(after[0].worker_id, b);
});

test("findStaleWorkerForProject returns dead PID immediately even before heartbeat TTL", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  _getAdapter()!.prepare(
    `UPDATE workers SET pid = -1 WHERE worker_id = :worker_id`,
  ).run({ ":worker_id": id });

  const stale = findStaleWorkerForProject(base);
  assert.ok(stale, "dead pid should be detected as stale immediately");
  assert.equal(stale!.worker_id, id);
});

for (const status of ["pending", "claimed", "running"] as const) {
  test(`findStaleWorkerForProject detects a stopping worker with a ${status} dispatch (#1773)`, (t) => {
    const base = makeBase();
    t.after(() => cleanup(base));
    openDatabase(join(base, ".gsd", "gsd.db"));

    const id = registerAutoWorker({ projectRootRealpath: base });
    markWorkerStopping(id);
    _getAdapter()!.prepare(
      `UPDATE workers SET pid = -1 WHERE worker_id = :worker_id`,
    ).run({ ":worker_id": id });
    _getAdapter()!.prepare(
      `INSERT INTO unit_dispatches (
        trace_id, turn_id, worker_id, milestone_lease_token,
        milestone_id, slice_id, task_id, unit_type, unit_id,
        status, attempt_n, started_at
      ) VALUES (
        'trace-orphan', 'turn-orphan', :worker_id, 7,
        'M001', 'S01', 'T01', 'validate-milestone', 'M001',
        :status, 1, '2026-07-13T00:00:00.000Z'
      )`,
    ).run({ ":worker_id": id, ":status": status });

    const stale = findStaleWorkerForProject(base);
    assert.ok(stale, `a stopping worker with a ${status} dispatch must be sweepable`);
    assert.equal(stale!.worker_id, id);
    assert.equal(isDeadLocalAutoWorker(id, base), true);
  });
}

// ─── Cross-host liveness (#16) ───────────────────────────────────────────
// A PID is only meaningful on the host that issued it. When the worker row
// belongs to another host the local process table proves nothing, so the
// heartbeat TTL is the only admissible evidence.

test("#16: findStaleWorkerForProject leaves a foreign-host worker alone while its heartbeat is fresh", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  setWorkerHostAndPid(id, FOREIGN_HOST, DEAD_PID);

  assert.equal(
    findStaleWorkerForProject(base),
    null,
    "a live remote holder must not be swept just because its PID is absent here",
  );
});

test("#16: findStaleWorkerForProject sweeps a foreign-host worker once its heartbeat lapses", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  setWorkerHostAndPid(id, FOREIGN_HOST, DEAD_PID);
  expireHeartbeat(id);

  const stale = findStaleWorkerForProject(base);
  assert.ok(stale, "a lapsed heartbeat is the only liveness signal available for a remote host");
  assert.equal(stale!.worker_id, id);
});

test("#16: findStaleWorkerForProject ignores a foreign-host PID that collides with a live local one", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  setWorkerHostAndPid(id, FOREIGN_HOST, process.pid);
  expireHeartbeat(id);

  const stale = findStaleWorkerForProject(base);
  assert.ok(stale, "our own PID says nothing about a worker registered on another host");
  assert.equal(stale!.worker_id, id);
});

test("#16: isAutoWorkerLive trusts a fresh heartbeat from a foreign host", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  setWorkerHostAndPid(id, FOREIGN_HOST, DEAD_PID);

  assert.equal(isAutoWorkerLive(id), true);
});

test("#16: isAutoWorkerLive rejects a foreign host whose heartbeat lapsed", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  setWorkerHostAndPid(id, FOREIGN_HOST, process.pid);
  expireHeartbeat(id);

  assert.equal(isAutoWorkerLive(id), false);
});

test("#16: isDeadLocalAutoWorker never claims a foreign-host worker is dead", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  setWorkerHostAndPid(id, FOREIGN_HOST, DEAD_PID);
  expireHeartbeat(id);

  assert.equal(isDeadLocalAutoWorker(id, base), false);
});

test("findStaleWorkerForProject ignores a stopping worker with no active dispatch (#1773)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  markWorkerStopping(id);
  _getAdapter()!.prepare(
    `UPDATE workers SET pid = -1 WHERE worker_id = :worker_id`,
  ).run({ ":worker_id": id });

  assert.equal(
    findStaleWorkerForProject(base),
    null,
    "a stopping worker with nothing running is a normal shutdown, not an orphan",
  );
});
