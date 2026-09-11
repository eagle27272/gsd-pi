// Project/App: gsd-pi
// File Purpose: Workspace-facing Interface for opening and maintaining the workflow database.

import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { syncDirectoryEntry } from "@gsd/native/directory-sync";

import type { GsdWorkspace, MilestoneScope } from "./workspace.js";
import type { DbAdapter } from "./db-adapter.js";
import {
  checkpointDatabase,
  closeAllDatabases,
  closeDatabase,
  closeDatabaseByWorkspace,
  getDbPath,
  getDbStatus,
  getDbProvider,
  isDbAvailable,
  isSchemaTooNewError,
  _getAdapter,
  openDatabase,
  openExistingDatabase,
  openDatabaseByScope,
  openDatabaseByWorkspace,
  openIsolatedDatabase,
  refreshOpenDatabaseFromDisk,
  vacuumDatabase,
  wasDbOpenAttempted,
} from "./gsd-db.js";
import { resolveGsdPathContract, gsdRoot } from "./paths.js";
import { logWarning, setLogBasePath } from "./workflow-logger.js";
import { parseDecisionsTable } from "./decision-markdown-parser.js";
import { isSqliteBusyError } from "./sqlite-errors.js";

export interface WorkflowDatabaseLocation {
  projectRoot: string;
  projectGsd: string;
  projectDb: string;
}

export type WorkflowDatabaseOpenReason =
  | "opened-existing"
  | "created-empty"
  | "missing-database"
  | "missing-gsd-dir"
  | "locked"
  | "open-failed"
  | "schema-too-new";

export type WorkflowDatabaseOpenResult =
  | {
      ok: true;
      reason: "opened-existing" | "created-empty";
      location: WorkflowDatabaseLocation;
    }
  | {
      ok: false;
      reason: "missing-database" | "missing-gsd-dir" | "locked" | "open-failed";
      location: WorkflowDatabaseLocation;
      error?: Error;
    }
  | {
      // Refuse-newer version skew: the typed engine error (with its exact
      // message) is ALWAYS attached so read seams can surface it loudly.
      ok: false;
      reason: "schema-too-new";
      location: WorkflowDatabaseLocation;
      error: Error;
    };

export type WorkflowDatabaseStatus = ReturnType<typeof getDbStatus>;
export type WorkflowDatabaseProvider = ReturnType<typeof getDbProvider>;

/**
 * Global SQLite handle invariants:
 *
 * - `openWorkflowDatabase` / `openDatabase` switch the process-global handle consumed by
 *   deriveState, dispatch, reconciliation repairs, and domain writers. Only one active
 *   project database should own the global handle at a time.
 * - `openWorkflowDatabaseIsolated` opens a caller-owned connection that does not clobber
 *   the global handle. Use for read-only observers (parallel monitor) and other background
 *   probes that must not disturb the active workflow session.
 * - Reconciliation repairs that write markdown/DB state must use `ensureWorkflowDbForBase`
 *   so repairs target the correct project; those paths intentionally re-open the global handle.
 * - Pair ad-hoc project switches with `closeWorkflowDatabase()` or restore via
 *   `ensureWorkflowDbForBase(..., { refresh: true })` before returning to derive/dispatch.
 */
export function resolveWorkflowDatabaseLocation(basePath: string): WorkflowDatabaseLocation {
  const contract = resolveGsdPathContract(basePath);
  return {
    projectRoot: dirname(dirname(contract.projectDb)),
    projectGsd: contract.projectGsd,
    projectDb: contract.projectDb,
  };
}

/**
 * Resolve the correct DB path for the current working directory.
 * If `basePath` is inside a `.gsd/worktrees/<MID>/` directory, returns
 * the project root's `.gsd/gsd.db` (shared WAL — R012). Otherwise returns
 * `<basePath>/.gsd/gsd.db`.
 */
export function resolveProjectRootDbPath(basePath: string): string {
  return resolveWorkflowDatabaseLocation(basePath).projectDb;
}

function openWorkflowDatabaseWithMode(
  basePath: string,
  createIfMissing: boolean,
): WorkflowDatabaseOpenResult {
  const location = resolveWorkflowDatabaseLocation(basePath);
  if (!existsSync(location.projectGsd)) {
    return { ok: false, reason: "missing-gsd-dir", location };
  }

  const existed = existsSync(location.projectDb);
  if (!createIfMissing && !existed) {
    return { ok: false, reason: "missing-database", location };
  }
  try {
    const opened = createIfMissing
      ? openDatabase(location.projectDb)
      : openExistingDatabase(location.projectDb);
    if (!opened) {
      return { ok: false, reason: "open-failed", location };
    }
    setLogBasePath(location.projectRoot);
    return {
      ok: true,
      reason: existed ? "opened-existing" : "created-empty",
      location,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (isSchemaTooNewError(error)) {
      // Refuse-newer version skew stays distinguishable — never collapse it
      // into a generic open-failed that read seams degrade silently on.
      return {
        ok: false,
        reason: "schema-too-new",
        location,
        error,
      };
    }
    if (isSqliteBusyError(error)) {
      return {
        ok: false,
        reason: "locked",
        location,
        error,
      };
    }
    if (!createIfMissing && !existsSync(location.projectDb)) {
      return { ok: false, reason: "missing-database", location, error };
    }
    return {
      ok: false,
      reason: "open-failed",
      location,
      error,
    };
  }
}

export function openWorkflowDatabase(basePath: string): WorkflowDatabaseOpenResult {
  return openWorkflowDatabaseWithMode(basePath, true);
}

export function openExistingWorkflowDatabase(basePath: string): WorkflowDatabaseOpenResult {
  return openWorkflowDatabaseWithMode(basePath, false);
}

export function openWorkflowDatabasePath(path: string): boolean {
  return openDatabase(path);
}

/**
 * Open an isolated database connection for read-only observation without
 * displacing the active workflow session's global DB handle. The caller is
 * responsible for calling `adapter.close()` when done.
 *
 * Use this for background observers (e.g. the parallel monitor overlay) that
 * need to query a database on a 5s tick without interfering with the primary
 * connection. Returns null if the connection cannot be opened.
 */
export function openWorkflowDatabaseIsolated(path: string): DbAdapter | null {
  return openIsolatedDatabase(path);
}

export function openWorkflowDatabaseByWorkspace(workspace: GsdWorkspace): boolean {
  return openDatabaseByWorkspace(workspace);
}

export function openWorkflowDatabaseByScope(scope: MilestoneScope): boolean {
  return openDatabaseByScope(scope);
}

export function closeWorkflowDatabase(): void {
  closeDatabase();
}

export function closeWorkflowDatabaseByWorkspace(workspace: GsdWorkspace): void {
  closeDatabaseByWorkspace(workspace);
}

export function closeAllWorkflowDatabases(): void {
  closeAllDatabases();
}

export function isWorkflowDatabaseOpen(): boolean {
  return isDbAvailable();
}

export function wasWorkflowDatabaseOpenAttempted(): boolean {
  return wasDbOpenAttempted();
}

export function getWorkflowDatabaseStatus(): WorkflowDatabaseStatus {
  return getDbStatus();
}

export function getWorkflowDatabaseProvider(): WorkflowDatabaseProvider {
  return getDbProvider();
}

export function getWorkflowDatabasePath(): string | null {
  return getDbPath();
}

export function refreshWorkflowDatabaseFromDisk(): boolean {
  return refreshOpenDatabaseFromDisk();
}

export function expectedWorkflowDbPathForBase(basePath: string): string {
  return join(gsdRoot(basePath), "gsd.db");
}

export interface EnsureWorkflowDbOptions {
  /** When true, refresh from disk before reopening if already open on the correct path. */
  refresh?: boolean;
}

export function ensureWorkflowDbAtPath(dbPath: string | null): boolean {
  if (!dbPath || dbPath === ":memory:") return isDbAvailable();
  if (isDbAvailable() && getWorkflowDatabasePath() === dbPath) return true;
  if (!existsSync(dbPath)) return false;
  try {
    return openWorkflowDatabasePath(dbPath);
  } catch (err) {
    logWarning("reconcile", `ensureWorkflowDbAtPath could not reopen DB: ${(err as Error).message}`);
    return false;
  }
}

export function ensureWorkflowDbForBase(
  basePath: string,
  options: EnsureWorkflowDbOptions = {},
): boolean {
  const dbPath = expectedWorkflowDbPathForBase(basePath);
  if (!existsSync(dbPath)) return false;

  try {
    if (options.refresh) {
      if (isDbAvailable() && getWorkflowDatabasePath() === dbPath && refreshWorkflowDatabaseFromDisk()) {
        return true;
      }
      return openWorkflowDatabasePath(dbPath);
    }

    if (isDbAvailable() && getWorkflowDatabasePath() === dbPath) return true;
    return openWorkflowDatabasePath(dbPath);
  } catch (err) {
    logWarning("reconcile", `ensureWorkflowDbForBase could not reopen DB: ${(err as Error).message}`);
    return false;
  }
}

export function checkpointWorkflowDatabase(): void {
  checkpointDatabase();
}

export function vacuumWorkflowDatabase(): void {
  vacuumDatabase();
}
