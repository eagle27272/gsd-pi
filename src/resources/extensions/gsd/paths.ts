// gsd-pi — ID-based path resolution for GSD project files and directories
/**
 * GSD Paths — ID-based path resolution
 *
 * Milestones live in the flat-phase layout: phases/NN-slug/, with phase-level
 * files named NN-SUFFIX.md and plan files NN-MM-SUFFIX.md. Slice directories,
 * when present, use bare IDs (S01/) and files use ID-SUFFIX (S01-PLAN.md).
 */

import { readdirSync, existsSync, realpathSync, statSync, Dirent } from "node:fs";
import { join, dirname, normalize, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { nativeScanGsdTree, type GsdTreeEntry } from "./native-parser-bridge.js";
import { DIR_CACHE_MAX } from "./constants.js";
import { gsdHome } from "./gsd-home.js";
import { normalizeRealPath } from "./real-path.js";
import { findWorktreeSegment, isGsdWorktreePath, resolveExternalStateProjectGsdFromWorktreePath, resolveWorktreeProjectRoot } from "./worktree-root.js";
import {
  LAYOUT_SEGMENTS,
  milestoneIdToPhaseNum,
  milestoneIdUniqueSuffix,
  slicePlanFileName,
  slicePlanSegment,
  canonicalPhaseDirName,
} from "./layout-policy.js";

export { canonicalPhaseDirName };

// ─── Directory Listing Cache ──────────────────────────────────────────────────

const dirEntryCache = new Map<string, Dirent[]>();
const dirListCache = new Map<string, string[]>();

// ─── Native Tree Cache ────────────────────────────────────────────────────────
// When the native module is available, scan the entire .gsd/ tree in one call
// and serve directory listings from memory instead of individual readdirSync calls.

let nativeTreeCache: Map<string, GsdTreeEntry[]> | null = null;
let nativeTreeBase: string | null = null;

function getNativeTree(gsdDir: string): Map<string, GsdTreeEntry[]> | null {
  if (nativeTreeCache && nativeTreeBase === gsdDir) return nativeTreeCache;

  const entries = nativeScanGsdTree(gsdDir);
  if (!entries) return null;

  // Build a map of parent directory -> entries
  const tree = new Map<string, GsdTreeEntry[]>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    const parentPath = parts.slice(0, -1).join('/');
    const parentKey = parentPath || '.';
    if (!tree.has(parentKey)) tree.set(parentKey, []);
    tree.get(parentKey)!.push(entry);
  }

  nativeTreeCache = tree;
  nativeTreeBase = gsdDir;
  return tree;
}

/**
 * Convert a native tree lookup into a relative key for the tree map.
 * Returns the relative path from the gsdDir, or null if the path isn't under gsdDir.
 */
function nativeTreeKey(dirPath: string, gsdDir: string): string | null {
  if (!dirPath.startsWith(gsdDir)) return null;
  const rel = dirPath.slice(gsdDir.length).replace(/^\//, '');
  return rel || '.';
}

function cachedReaddirWithTypes(dirPath: string): Dirent[] {
  const cached = dirEntryCache.get(dirPath);
  if (cached) return cached;

  // Try native tree cache for paths under .gsd/
  if (nativeTreeBase) {
    const key = nativeTreeKey(dirPath, nativeTreeBase);
    if (key && nativeTreeCache) {
      const treeEntries = nativeTreeCache.get(key);
      if (treeEntries) {
        // Synthesize Dirent-like objects from native tree entries
        const dirents = treeEntries.map(e => {
          const d = Object.create(Dirent.prototype) as Dirent;
          Object.assign(d, {
            name: e.name,
            parentPath: dirPath,
            path: dirPath,
          });
          // Override the type check methods
          const isDir = e.isDir;
          d.isDirectory = () => isDir;
          d.isFile = () => !isDir;
          d.isSymbolicLink = () => false;
          d.isBlockDevice = () => false;
          d.isCharacterDevice = () => false;
          d.isFIFO = () => false;
          d.isSocket = () => false;
          return d;
        });
        if (dirEntryCache.size >= DIR_CACHE_MAX) dirEntryCache.clear();
        dirEntryCache.set(dirPath, dirents);
        return dirents;
      }
    }
  }

  const entries = readdirSync(dirPath, { withFileTypes: true });
  if (dirEntryCache.size >= DIR_CACHE_MAX) dirEntryCache.clear();
  dirEntryCache.set(dirPath, entries);
  return entries;
}

function cachedReaddir(dirPath: string): string[] {
  const cached = dirListCache.get(dirPath);
  if (cached) return cached;

  // Try native tree cache for paths under .gsd/
  if (nativeTreeBase) {
    const key = nativeTreeKey(dirPath, nativeTreeBase);
    if (key && nativeTreeCache) {
      const treeEntries = nativeTreeCache.get(key);
      if (treeEntries) {
        const names = treeEntries.map(e => e.name);
        if (dirListCache.size >= DIR_CACHE_MAX) dirListCache.clear();
        dirListCache.set(dirPath, names);
        return names;
      }
    }
  }

  const entries = readdirSync(dirPath);
  if (dirListCache.size >= DIR_CACHE_MAX) dirListCache.clear();
  dirListCache.set(dirPath, entries);
  return entries;
}

function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Clear the volatile directory listing caches.
 * Call after milestone transitions, file creation in planning directories,
 * or at the start/end of a dispatch cycle.
 *
 * NOTE: This does NOT clear gsdRootCache. The project root is stable for
 * the lifetime of a process; clearing it on every agent turn-end caused a
 * 250–2500 ms regression per session (git rev-parse + dir walk per turn).
 * Use _clearGsdRootCache() at session-reset boundaries (workspace switch,
 * process exit) when the project root may genuinely change.
 */
export function clearPathCache(): void {
  dirEntryCache.clear();
  dirListCache.clear();
  nativeTreeCache = null;
  nativeTreeBase = null;
}

// ─── Name Builders ─────────────────────────────────────────────────────────

/** Directories owned by the GSD framework — metadata, never project source. */
export const FRAMEWORK_METADATA_DIRS: readonly string[] = [".gsd", ".planning", ".audits"];

/**
 * Every artifact suffix used with the name builders below — the single source
 * for the `<ID>-<SUFFIX>.md` naming vocabulary. Extend this list when a new
 * artifact type is introduced; consumers (md-importer walking, pre-execution
 * artifact detection) pick it up from here.
 */
export const PLANNING_ARTIFACT_SUFFIXES: readonly string[] = [
  "CONTEXT",
  "CONTEXT-DRAFT",
  "ROADMAP",
  "PLAN",
  "REPLAN",
  "SUMMARY",
  "RESEARCH",
  "UI-SPEC",
  "VALIDATION",
  "ASSESSMENT",
  "UAT",
  "DISCUSSION",
  "EVAL-REVIEW",
  "PARKED",
  "VERIFICATION-FAILED",
  "CONTINUE",
];

/** Matches a bare planning-artifact file name, e.g. "M001-CONTEXT.md", "S01-PLAN.md". */
export const PLANNING_ARTIFACT_NAME_RE = new RegExp(
  `^[MST]\\d+-(${PLANNING_ARTIFACT_SUFFIXES.join("|")})\\.md$`,
  "i",
);

/**
 * Build a milestone-level file name.
 * ("M001", "CONTEXT") → "M001-CONTEXT.md"
 */
export function buildMilestoneFileName(milestoneId: string, suffix: string): string {
  // Flat-phase: phase-level files are NN-SUFFIX.md (e.g. "01-CONTEXT.md")
  const phaseNum = milestoneIdToPhaseNum(milestoneId);
  return `${String(phaseNum).padStart(2, "0")}-${suffix}.md`;
}

/**
 * Build a slice-level file name.
 * ("S01", "PLAN") → "S01-PLAN.md"
 */
export function buildSliceFileName(sliceId: string, suffix: string): string {
  // Flat-phase: plan files need both phase and plan numbers (NN-MM-SUFFIX.md),
  // but this helper only has the sliceId. Callers needing the full name should
  // use slicePlanFileName() from layout-policy. This returns MM-SUFFIX.md for
  // any incremental callers that haven't migrated yet.
  return `${slicePlanSegment(sliceId)}-${suffix}.md`;
}

/**
 * Build a task file name.
 * ("T03", "PLAN") → "T03-PLAN.md"
 * ("T03", "SUMMARY") → "T03-SUMMARY.md"
 */
export function buildTaskFileName(taskId: string, suffix: string): string {
  // Flat-phase: tasks are checkboxes inside plan files, not separate files.
  // This helper is deprecated but kept for backward-compat callers.
  return `${taskId}-${suffix}.md`;
}

/**
 * Build a flat-phase task artifact file name.
 * ("S06", "T03", "SUMMARY") → "S06-T03-SUMMARY.md"
 */
export function buildFlatTaskFileName(sliceId: string, taskId: string, suffix: string): string {
  const redundantPrefix = `${sliceId}-`;
  const bareTaskId = taskId.toUpperCase().startsWith(redundantPrefix.toUpperCase())
    ? taskId.slice(redundantPrefix.length)
    : taskId;
  return `${sliceId}-${bareTaskId}-${suffix}.md`;
}

/**
 * Extract the task ID from a task artifact filename: the flat-phase
 * S##-T##-SUFFIX.md form, or the bare T##-SUFFIX.md that buildTaskFileName
 * still produces. Descriptor-suffixed names are not recognized.
 */
export function taskIdFromTaskFileName(fileName: string, suffix: string): string | null {
  const flat = new RegExp(`^S\\d+-(T\\d+)-${suffix}\\.md$`, "i").exec(fileName);
  if (flat?.[1]) return flat[1].toUpperCase();
  const bare = new RegExp(`^(T\\d+)-${suffix}\\.md$`, "i").exec(fileName);
  return bare?.[1]?.toUpperCase() ?? null;
}

// ─── Resolvers ─────────────────────────────────────────────────────────────

/**
 * Find a directory entry by bare ID within a parent directory (e.g. S01).
 * Matching is case-insensitive. Returns the directory name or null.
 */
export function resolveDir(parentDir: string, idPrefix: string): string | null {
  if (!existsSync(parentDir)) return null;
  try {
    const entries = cachedReaddirWithTypes(parentDir);
    const exact = entries.find(e => e.isDirectory() && e.name === idPrefix);
    if (exact) return exact.name;
    const idLower = idPrefix.toLowerCase();
    const exactCaseInsensitive = entries.find(
      e => e.isDirectory() && e.name.toLowerCase() === idLower
    );
    return exactCaseInsensitive ? exactCaseInsensitive.name : null;
  } catch {
    return null;
  }
}

/**
 * Find a file by ID prefix and suffix within a directory:
 * ID-SUFFIX.md (e.g. M001-ROADMAP.md, T03-PLAN.md).
 */
export function resolveFile(dir: string, idPrefix: string, suffix: string): string | null {
  if (!existsSync(dir)) return null;
  const target = `${idPrefix}-${suffix}.md`.toUpperCase();
  try {
    const entries = cachedReaddirWithTypes(dir).filter(e => e.isFile()).map(e => e.name);
    return entries.find(e => e.toUpperCase() === target) ?? null;
  } catch {
    return null;
  }
}

/**
 * Find all task files matching a pattern in a tasks directory or flat phase dir.
 * Returns sorted file names matching S##-T##-SUFFIX.md.
 */
export function resolveTaskFiles(tasksDir: string, suffix: string): string[] {
  if (!existsSync(tasksDir)) return [];
  try {
    return cachedReaddirWithTypes(tasksDir)
      .filter(e => e.isFile())
      .map(e => e.name)
      .filter(f => taskIdFromTaskFileName(f, suffix) !== null)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Find all task JSON files matching a pattern in a tasks directory.
 * Returns sorted file names matching T##-SUFFIX.json
 */
export function resolveTaskJsonFiles(tasksDir: string, suffix: string): string[] {
  if (!existsSync(tasksDir)) return [];
  try {
    const currentPattern = new RegExp(`^T\\d+-${suffix}\\.json$`, "i");
    return cachedReaddir(tasksDir)
      .filter(f => currentPattern.test(f))
      .sort();
  } catch {
    return [];
  }
}

// ─── Full Path Builders ────────────────────────────────────────────────────

export const GSD_ROOT_FILES = {
  PROJECT: "PROJECT.md",
  DECISIONS: "DECISIONS.md",
  QUEUE: "QUEUE.md",
  STATE: "STATE.md",
  REQUIREMENTS: "REQUIREMENTS.md",
  OVERRIDES: "OVERRIDES.md",
  KNOWLEDGE: "KNOWLEDGE.md",
  CODEBASE: "CODEBASE.md",
} as const;

export type GSDRootFileKey = keyof typeof GSD_ROOT_FILES;

// ─── GSD Root Discovery ───────────────────────────────────────────────────────

// Process-lifetime cache for gsdRoot() results.
// Keys are realpath-normalized (via normCacheKey) so /foo and /foo/ share the
// same entry and so do case-variant paths on case-insensitive volumes. This
// normalization is the safety net that prevents cache poisoning from the
// ~/.gsd walk-up bug (fixed in c46cf4786 + b35e070eb), making it safe to
// hold this cache for the entire process lifetime.
// Use _clearGsdRootCache() only at session-reset boundaries (workspace switch,
// process exit) — NOT inside clearPathCache(), which runs on every agent turn.
const gsdRootCache = new Map<string, string>();

export interface GsdPathContract {
  /** Canonical repo/project root where authoritative state lives. */
  projectRoot: string;
  /** Current execution root, which may be an auto-worktree. */
  workRoot: string;
  /** Canonical authoritative .gsd directory. */
  projectGsd: string;
  /** Worktree-local .gsd projection directory, when applicable. */
  worktreeGsd: string | null;
  /** Canonical authoritative SQLite DB path. */
  projectDb: string;
  /** True when workRoot is inside a GSD worktree layout. */
  isWorktree: boolean;
}

export function resolveGsdPathContract(
  workRoot: string,
  originalProjectRoot?: string | null,
): GsdPathContract {
  const resolvedWorkRoot = resolve(workRoot || process.cwd());
  const isWorktree = isGsdWorktreePath(resolvedWorkRoot);
  if (isWorktree && !originalProjectRoot?.trim()) {
    const rawProjectGsd = resolveExternalStateProjectGsdFromWorktreePath(resolvedWorkRoot);
    if (rawProjectGsd) {
      // Canonicalize the `.gsd` root so the DB path matches what every other
      // accessor (gsdRoot/gsdProjectionRoot) returns — otherwise an unresolved
      // symlink (e.g. `/mnt/c/.../.gsd` → native ext4 on WSL) selects the wrong
      // journal mode and yields a fragile, move-prone handle. See issue #1239.
      const projectGsd = normalizeRealPath(rawProjectGsd);
      return {
        projectRoot: dirname(dirname(projectGsd)),
        workRoot: resolvedWorkRoot,
        projectGsd,
        worktreeGsd: normalizeRealPath(join(resolvedWorkRoot, ".gsd")),
        projectDb: join(projectGsd, "gsd.db"),
        isWorktree,
      };
    }
  }
  const projectRoot = resolve(resolveWorktreeProjectRoot(resolvedWorkRoot, originalProjectRoot));
  const projectGsd = normalizeRealPath(join(projectRoot, ".gsd"));
  const worktreeGsd = isWorktree ? normalizeRealPath(join(resolvedWorkRoot, ".gsd")) : null;

  return {
    projectRoot,
    workRoot: resolvedWorkRoot,
    projectGsd,
    worktreeGsd,
    projectDb: join(projectGsd, "gsd.db"),
    isWorktree,
  };
}

export function gsdProjectionRoot(basePath: string): string {
  const contract = resolveGsdPathContract(basePath);
  return normalizeRealPath(contract.worktreeGsd ?? contract.projectGsd);
}

/**
 * Invalidate the gsdRoot cache.
 * Use ONLY at session-reset boundaries: workspace switch, process exit, or
 * any context where the project root itself may genuinely change.
 * Do NOT call this on every agent turn — use clearPathCache() for volatile
 * directory listing invalidation instead.
 */
export function _clearGsdRootCache(): void {
  gsdRootCache.clear();
}

export { normalizeRealPath };

/** Normalize a path for use as a gsdRootCache key (realpath + trailing-slash strip). */
function normCacheKey(p: string): string {
  const r = normalizeRealPath(p);
  const s = r.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * Resolve the `.gsd` directory for a given project base path.
 *
 * Probe order:
 *   1. basePath/.gsd         — fast path (common case)
 *   2. git rev-parse root    — handles cwd-is-a-subdirectory
 *   3. Walk up from basePath — handles moved .gsd in an ancestor (bounded by git root)
 *   4. basePath/.gsd         — creation fallback (init scenario)
 *
 * Result is cached per normalized basePath for the process lifetime.
 * Keys are realpath-normalized so /foo and /foo/ share the same cache entry.
 */
export function gsdRoot(basePath: string): string {
  const cacheKey = normCacheKey(basePath);
  const cached = gsdRootCache.get(cacheKey);
  if (cached) return cached;

  // Canonicalize result via realpath before asserting and caching so that
  // callers always receive a canonical path regardless of whether probeGsdRoot
  // returned a path through a symlink. Without this, the cached value can
  // diverge from other realpath-normalized paths (e.g. workspace.identityKey).
  const result = normalizeRealPath(probeGsdRoot(basePath));

  // Defense-in-depth: if basePath resolves to the user's home directory and
  // the result equals gsdHome(), refuse — project-scoped writes must never
  // land in the global ~/.gsd. Paths under ~/.gsd/projects/<hash>/ are still
  // valid (their basePath does not equal homedir).
  assertNotGlobalGsdHome(basePath, result);

  gsdRootCache.set(cacheKey, result);
  return result;
}

function assertNotGlobalGsdHome(basePath: string, result: string): void {
  const norm = (p: string): string => {
    let r: string;
    try { r = realpathSync.native(p); } catch { r = p; }
    const s = r.replaceAll("\\", "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  let baseNorm: string;
  let homeNorm: string;
  let resultNorm: string;
  let gsdHomeNorm: string;
  try {
    baseNorm = norm(basePath);
    homeNorm = norm(homedir());
    resultNorm = norm(result);
    gsdHomeNorm = norm(gsdHome());
  } catch {
    return;
  }
  if (baseNorm === homeNorm && resultNorm === gsdHomeNorm) {
    throw new Error(
      `Refusing to use ${result} as a project .gsd directory — that is the global GSD home. ` +
      `Run GSD from inside a project directory.`,
    );
  }
}

/**
 * Detect if a path is inside a .gsd/worktrees/<name>/ structure.
 *
 * GSD auto-worktrees live at <project>/.gsd/worktrees/<milestoneId>/.
 * When gsdRoot() is called with such a path, we must NOT walk up to the
 * project root's .gsd — each worktree manages its own .gsd state (#2594).
 *
 * Layout matching is owned by worktree-root's findWorktreeSegment; this
 * only adds the requirement that a non-empty worktree name follows the
 * marker (the worktrees container dir itself is not a worktree).
 */
function isInsideGsdWorktree(p: string): boolean {
  const normalized = p.replaceAll("\\", "/");
  const segment = findWorktreeSegment(normalized);
  if (!segment) return false;
  const name = normalized.slice(segment.afterWorktrees).split("/")[0];
  return name.length > 0;
}

/** Prefix used by staged-write temp dirs (`mkdtempSync(join(targetRoot, prefix))`). */
export const MIGRATION_STAGING_DIR_PREFIX = ".gsd-migrate-stage-";

/**
 * Detect a path inside a `.gsd-migrate-stage-*` temp dir.
 *
 * Staging lives under the target repo, so the git-root probe would otherwise
 * resolve to the live repo `.gsd` and write staged projection there (#1866).
 */
function isInsideMigrationStaging(p: string): boolean {
  return p.replaceAll("\\", "/").split("/").some((seg) => seg.startsWith(MIGRATION_STAGING_DIR_PREFIX));
}

function probeGsdRoot(rawBasePath: string): string {
  const contract = resolveGsdPathContract(rawBasePath);
  if (contract.isWorktree) return contract.projectGsd;

  // 1. Fast path — check the input path directly
  const local = join(rawBasePath, ".gsd");
  if (existsSync(local)) return local;

  // 1b. Worktree guard (#2594) — if basePath is inside a .gsd/worktrees/<name>/
  //     structure, return the worktree-local .gsd path immediately. Without this,
  //     the git-root probe (step 2) or walk-up (step 3) escapes to the project
  //     root's .gsd, causing ensurePreconditions() and deriveState() to read/write
  //     state in the wrong location.
  if (isInsideGsdWorktree(rawBasePath)) return local;

  // 1c. Migration staging (#1866) — temp dirs live inside the target repo, so
  //     git-root / walk-up would return the live `.gsd`. Keep staging local.
  if (isInsideMigrationStaging(rawBasePath)) return local;

  // Resolve symlinks so path comparisons work correctly across platforms
  // (e.g. macOS /var → /private/var). Use rawBasePath as fallback if not resolvable.
  let basePath: string;
  try { basePath = realpathSync.native(rawBasePath); } catch { basePath = rawBasePath; }

  // Also check the resolved path for the worktree pattern (macOS /tmp → /private/tmp)
  if (basePath !== rawBasePath && isInsideGsdWorktree(basePath)) return local;
  if (basePath !== rawBasePath && isInsideMigrationStaging(basePath)) return local;

  // 2. Git root anchor — used as both probe target and walk-up boundary
  //    Only walk if we're inside a git project — prevents escaping into
  //    unrelated filesystem territory when running outside any repo.
  let gitRoot: string | null = null;
  try {
    const out = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: basePath,
      encoding: "utf-8",
    });
    if (out.status === 0) {
      const r = out.stdout.trim();
      if (r) gitRoot = normalize(r);
    }
  } catch { /* git not available */ }

  // Compute gsdHome once for the skip-check used in steps 2 and 3.
  const normPath = (p: string): string => {
    let r: string;
    try { r = realpathSync.native(p); } catch { r = p; }
    const s = r.replaceAll("\\", "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  let gsdHomeNorm: string;
  try { gsdHomeNorm = normPath(gsdHome()); } catch { gsdHomeNorm = ""; }

  if (gitRoot) {
    const candidate = join(gitRoot, ".gsd");
    // Skip if the candidate resolves to the global GSD home — a subdir basePath
    // must not be anchored to ~/.gsd just because $HOME is a git repo.
    if (existsSync(candidate) && normPath(candidate) !== gsdHomeNorm) return candidate;
  }

  // 3. Walk up from basePath to the git root (only if we are in a subdirectory)
  if (gitRoot && basePath !== gitRoot) {
    let cur = dirname(basePath);
    while (cur !== basePath) {
      const candidate = join(cur, ".gsd");
      if (existsSync(candidate) && normPath(candidate) !== gsdHomeNorm) return candidate;
      if (cur === gitRoot) break;
      basePath = cur;
      cur = dirname(cur);
    }
  }

  // 4. Fallback for init/creation
  return local;
}

export function milestonesDirIn(projectionRoot: string): string {
  return join(projectionRoot, LAYOUT_SEGMENTS.level1);
}

export function milestonesDir(basePath: string): string {
  return milestonesDirIn(gsdProjectionRoot(basePath));
}

/**
 * Resolve a phase directory by milestone id using the flat-phase layout.
 * Scans phases/ for a dir whose zero-padded number prefix matches the milestone.
 * Returns the full path or null if not found.
 */
function pickPreferredPhaseDir(phasesDir: string, matches: string[]): string {
  if (matches.length === 1) return matches[0]!;
  let best = matches[0]!;
  let bestMtime = -1;
  for (const name of matches) {
    try {
      const mtime = statSync(join(phasesDir, name)).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = name;
      }
    } catch {
      // unreadable — keep prior best
    }
  }
  return best;
}

function slugLooksLikeTeamSuffixProjection(slugPart: string): boolean {
  return /^[a-z0-9]{6}(-|$)/.test(slugPart);
}

export function phaseDirMatchesMilestoneId(
  dirName: string,
  milestoneId: string,
  phaseNum: number,
  allowTeamSuffixSlugs = false,
): boolean {
  const numMatch = dirName.match(/^(\d+)-(.*)$/);
  if (!numMatch || parseInt(numMatch[1]!, 10) !== phaseNum) return false;
  const slugPart = numMatch[2]!;
  const suffix = milestoneIdUniqueSuffix(milestoneId);
  if (suffix) {
    return slugPart === suffix || slugPart.startsWith(`${suffix}-`);
  }
  if (slugLooksLikeTeamSuffixProjection(slugPart) && !allowTeamSuffixSlugs) return false;
  return true;
}

/**
 * resolvePhaseDir for callers that already hold the projection root — notably
 * anything deriving it from the open DB path, where the project root cannot be
 * recovered by string surgery because `.gsd` may be a symlink into the external
 * state dir (#2).
 */
export function resolvePhaseDirIn(projectionRoot: string, milestoneId: string): string | null {
  const phasesDir = join(projectionRoot, LAYOUT_SEGMENTS.level1);
  if (existsSync(phasesDir)) {
    const phaseNum = milestoneIdToPhaseNum(milestoneId);
    const canonical = canonicalPhaseDirName(milestoneId);
    if (existsSync(join(phasesDir, canonical))) {
      return join(phasesDir, canonical);
    }
    const matches: string[] = [];
    try {
      for (const entry of readdirSync(phasesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (phaseDirMatchesMilestoneId(entry.name, milestoneId, phaseNum)) {
          matches.push(entry.name);
        }
      }
      // Bare milestone ids may only have a suffixed team-mode projection on disk.
      if (matches.length === 0 && !milestoneIdUniqueSuffix(milestoneId)) {
        for (const entry of readdirSync(phasesDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (phaseDirMatchesMilestoneId(entry.name, milestoneId, phaseNum, true)) {
            matches.push(entry.name);
          }
        }
      }
    } catch {
      // unreadable — fall through
    }
    if (matches.length > 0) {
      const preferred = matches.includes(canonical)
        ? canonical
        : pickPreferredPhaseDir(phasesDir, matches);
      return join(phasesDir, preferred);
    }
  }
  return null;
}

function resolvePhaseDir(basePath: string, milestoneId: string): string | null {
  return resolvePhaseDirIn(gsdProjectionRoot(basePath), milestoneId);
}

export function resolveRuntimeFile(basePath: string): string {
  return join(gsdRoot(basePath), "RUNTIME.md");
}

export function resolveGsdRootFile(basePath: string, key: GSDRootFileKey): string {
  return join(gsdRoot(basePath), GSD_ROOT_FILES[key]);
}

export function relGsdRootFile(key: GSDRootFileKey): string {
  return `.gsd/${GSD_ROOT_FILES[key]}`;
}

/**
 * Resolve the full path to a milestone directory.
 * Returns null if the milestone doesn't exist.
 */
export function resolveMilestonePath(basePath: string, milestoneId: string): string | null {
  // Flat-phase: scan phases/ for NN-slug dir matching the milestone number.
  return resolvePhaseDir(basePath, milestoneId);
}

/**
 * Returns true iff a milestone directory physically exists on disk.
 * See doctor-runtime-checks.ts orphan_milestone_db (#1524).
 */
export function milestoneDirExists(basePath: string, milestoneId: string): boolean {
  return resolveMilestonePath(basePath, milestoneId) !== null;
}

/**
 * Resolve the full path to a milestone file (e.g. ROADMAP, CONTEXT, RESEARCH).
 */
export function resolveMilestoneFile(
  basePath: string, milestoneId: string, suffix: string
): string | null {
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (!mDir) return null;
  // Flat-phase: phase-level files are NN-SUFFIX.md (e.g. 01-CONTEXT.md)
  const phaseNum = milestoneIdToPhaseNum(milestoneId);
  const prefix = `${String(phaseNum).padStart(2, "0")}`;
  const flatName = `${prefix}-${suffix}.md`;
  const flatPath = join(mDir, flatName);
  if (isExistingFile(flatPath)) return flatPath;
  // Compatibility: an <MID>-SUFFIX.md written into the phase dir by an older
  // projection is still readable.
  const file = resolveFile(mDir, milestoneId, suffix);
  return file ? join(mDir, file) : null;
}

/**
 * Resolve the full path to a slice directory within a milestone.
 */
export function resolveSlicePath(
  basePath: string, milestoneId: string, sliceId: string
): string | null {
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (!mDir) return null;
  // Slice files live under slices/SID/ when that subdir exists.
  const slicesDir = join(mDir, "slices");
  const dir = resolveDir(slicesDir, sliceId);
  if (dir) return join(slicesDir, dir);
  // Flat-phase: plans are files inside the phase dir, not subdirs.
  return mDir;
}

/**
 * Resolve the full path to a slice file (e.g. PLAN, RESEARCH, CONTEXT, SUMMARY).
 */
export function resolveSliceFile(
  basePath: string, milestoneId: string, sliceId: string, suffix: string
): string | null {
  const phaseDir = resolveMilestonePath(basePath, milestoneId);
  if (!phaseDir) return null;
  // Flat-phase: plan files are NN-MM-SUFFIX.md inside the phase dir.
  // The segment comes from the canonical layout mapping, never from digits
  // guessed out of a non-canonical slice id (#1975): R01 must not resolve
  // to S01's 01-01-* files.
  const phaseNum = milestoneIdToPhaseNum(milestoneId);
  const planSegment = slicePlanSegment(sliceId);
  const flatName = slicePlanFileName(phaseNum, sliceId, suffix);
  const flatPath = join(phaseDir, flatName);
  if (isExistingFile(flatPath)) return flatPath;
  // Also check plan-number-only format MM-SUFFIX.md (written by buildSliceFileName).
  // Skip it when the plan segment equals the phase number: `01-RESEARCH.md` in
  // phase 01 is the MILESTONE artifact, and claiming it as S01's would hand a
  // slice-scoped reader the milestone's file.
  const phasePad = String(phaseNum).padStart(2, "0");
  if (planSegment !== phasePad) {
    const planOnlyPath = join(phaseDir, `${planSegment}-${suffix}.md`);
    if (isExistingFile(planOnlyPath)) return planOnlyPath;
  }
  // Try prefix match for the phase+plan number (handles suffix variations)
  const planPrefix = `${String(phaseNum).padStart(2, "0")}-${planSegment}-`;
  try {
    for (const entry of readdirSync(phaseDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(planPrefix) && entry.name.endsWith(`-${suffix}.md`)) {
        return join(phaseDir, entry.name);
      }
    }
  } catch {
    // unreadable
  }
  // Fall back to a slices/SID/ subdir when the phase dir has one.
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  if (sDir && sDir !== phaseDir) {
    const file = resolveFile(sDir, sliceId, suffix);
    if (file) return join(sDir, file);
  }
  return null;
}

/**
 * Resolve the tasks directory within a slice.
 */
export function resolveTasksDir(
  basePath: string, milestoneId: string, sliceId: string
): string | null {
  // Flat-phase: no tasks/ subdir. Tasks live as checkboxes inside plan files.
  // Returns a tasks/ dir only when the resolved slice dir actually has one.
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  if (!sDir) return null;
  const tDir = join(sDir, "tasks");
  return existsSync(tDir) ? tDir : null;
}

/**
 * Resolve a specific task file.
 */
export function resolveTaskFile(
  basePath: string, milestoneId: string, sliceId: string,
  taskId: string, suffix: string
): string | null {
  const phaseDir = resolveMilestonePath(basePath, milestoneId);
  if (!phaseDir) return null;

  if (suffix !== "PLAN") {
    // Flat-phase writes task artifacts at the phase root. A tasks/ subdir may
    // still exist for auxiliary task-scoped artifacts, and a stale summary
    // inside it must NOT satisfy the canonical phase-root artifact (#1208).
    const flatPath = join(phaseDir, buildFlatTaskFileName(sliceId, taskId, suffix));
    if (isExistingFile(flatPath)) return flatPath;
    const bareTaskPath = join(phaseDir, buildTaskFileName(taskId, suffix));
    return isExistingFile(bareTaskPath) ? bareTaskPath : null;
  }

  const tDir = resolveTasksDir(basePath, milestoneId, sliceId);
  if (tDir) {
    const file = resolveFile(tDir, taskId, suffix);
    if (file) return join(tDir, file);
  }

  return null;
}

// ─── Relative Path Builders (for prompts — .gsd/milestones/...) ────────────

/**
 * Build relative .gsd/ path to a milestone directory.
 * Uses the actual directory name on disk if it exists, otherwise the canonical
 * flat-phase dir name the renderer will create (NN-slug).
 *
 * Pass `title` when the milestone title is available so the fallback slug
 * matches what the renderer will create.  Without a title the phase number is
 * used as a placeholder (no DB import is allowed here — db/engine uses
 * import.meta.url which breaks the Next.js SSR build path).
 */
export function relMilestonePath(basePath: string, milestoneId: string, title?: string): string {
  const phaseDir = resolvePhaseDir(basePath, milestoneId);
  if (phaseDir) {
    const name = phaseDir.split(/[/\\]/).pop()!;
    return `.gsd/${LAYOUT_SEGMENTS.level1}/${name}`;
  }
  // No dir on disk yet — derive canonical flat-phase name.
  // If the caller provides the milestone title, the slug will match what the
  // renderer creates (e.g. "01-foundation").  Without a title, falls back to
  // the milestone ID as the slug placeholder (e.g. "01-m001").
  return `.gsd/${LAYOUT_SEGMENTS.level1}/${canonicalPhaseDirName(milestoneId, title)}`;
}

/**
 * Build the canonical absolute write target for a milestone file.
 * Existing compatibility filenames are intentionally ignored; readers that need
 * to preserve an existing file should call resolveMilestoneFile first.
 */
export function targetMilestoneFile(
  basePath: string, milestoneId: string, suffix: string, title?: string
): string {
  const dir = resolveMilestonePath(basePath, milestoneId)
    ?? join(milestonesDir(basePath), canonicalPhaseDirName(milestoneId, title));
  return join(dir, `${String(milestoneIdToPhaseNum(milestoneId)).padStart(2, "0")}-${suffix}.md`);
}

/**
 * Build relative .gsd/ path to a milestone file.
 * Preserves an existing compatibility filename when present; otherwise falls
 * back to the canonical write target.
 */
export function relMilestoneFile(
  basePath: string, milestoneId: string, suffix: string, title?: string
): string {
  const rel = relative(
    gsdProjectionRoot(basePath),
    resolveMilestoneFile(basePath, milestoneId, suffix) ?? targetMilestoneFile(basePath, milestoneId, suffix, title),
  ).replace(/\\/g, "/");
  return `.gsd/${rel}`;
}

/**
 * Build relative .gsd/ path to a slice directory.
 * Flat-phase projects use the phase dir directly.
 *
 * @param milestoneTitle - Optional milestone title passed through to
 *   relMilestonePath so the flat-phase fallback dir name uses the human-readable
 *   slug ("05-milestone-five") rather than the bare ID slug ("05-m005").
 *   Only consulted when no phase directory exists on disk yet.
 */
export function relSlicePath(
  basePath: string, milestoneId: string, sliceId: string, milestoneTitle?: string
): string {
  // Flat-phase: plans are files inside the phase dir, no slices/ subdir.
  return relMilestonePath(basePath, milestoneId, milestoneTitle);
}

/**
 * Build the canonical absolute write target for a slice file.
 * Existing compatibility filenames are intentionally ignored; readers that need
 * to preserve an existing file should call resolveSliceFile first.
 */
export function targetSliceFile(
  basePath: string, milestoneId: string, sliceId: string, suffix: string, milestoneTitle?: string
): string {
  const milestoneDir = resolveMilestonePath(basePath, milestoneId)
    ?? dirname(targetMilestoneFile(basePath, milestoneId, "ROADMAP", milestoneTitle));
  return join(
    milestoneDir,
    slicePlanFileName(milestoneIdToPhaseNum(milestoneId), sliceId, suffix),
  );
}

/**
 * Build the canonical absolute write target for a task file.
 * Readers that must honour an existing on-disk filename call resolveTaskFile.
 */
export function targetTaskFile(
  basePath: string, milestoneId: string, sliceId: string,
  taskId: string, suffix: string, milestoneTitle?: string
): string {
  if (suffix === "PLAN") {
    return targetSliceFile(basePath, milestoneId, sliceId, "PLAN", milestoneTitle);
  }

  const milestoneDir = resolveMilestonePath(basePath, milestoneId)
    ?? dirname(targetMilestoneFile(basePath, milestoneId, "ROADMAP", milestoneTitle));
  return join(milestoneDir, buildFlatTaskFileName(sliceId, taskId, suffix));
}

/**
 * Build relative .gsd/ path to a slice file.
 * Preserves an existing compatibility filename when present; otherwise falls
 * back to the canonical write target.
 */
export function relSliceFile(
  basePath: string, milestoneId: string, sliceId: string, suffix: string, milestoneTitle?: string
): string {
  const rel = relative(
    gsdProjectionRoot(basePath),
    resolveSliceFile(basePath, milestoneId, sliceId, suffix)
      ?? targetSliceFile(basePath, milestoneId, sliceId, suffix, milestoneTitle),
  ).replace(/\\/g, "/");
  return `.gsd/${rel}`;
}

/**
 * Build relative .gsd/ path to a task file.
 *
 * slices/ subdir present: slices/SID/tasks/TID-SUFFIX.md
 * Flat-phase:              PLAN → slice plan path (tasks as checkboxes); other
 *                          suffixes (e.g. SUMMARY) → phase dir / TID-SUFFIX.md
 */
export function relTaskFile(
  basePath: string, milestoneId: string, sliceId: string,
  taskId: string, suffix: string, milestoneTitle?: string
): string {
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  const phaseDir = resolveMilestonePath(basePath, milestoneId);
  // The slice resolved to a slices/SID/ subdir inside the phase dir.
  if (sDir && phaseDir && sDir !== phaseDir) {
    const relS = relSlicePath(basePath, milestoneId, sliceId);
    return `${relS}/tasks/${taskId}-${suffix}.md`;
  }
  // Flat-phase: task plans are checkboxes inside the slice plan file
  if (suffix === "PLAN") {
    return relSliceFile(basePath, milestoneId, sliceId, "PLAN");
  }
  const relS = relSlicePath(basePath, milestoneId, sliceId, milestoneTitle);
  return `${relS}/${buildFlatTaskFileName(sliceId, taskId, suffix)}`;
}
