import { existsSync } from 'node:fs'

export interface WorktreeDiff {
  added: string[]
  modified: string[]
  removed: string[]
}

export interface WorktreeNumstat {
  added: number
  removed: number
}

export interface WorktreeScanItem {
  name: string
  branch: string
}

export interface WorktreeStatusDependencies {
  diffWorktreeAll: (basePath: string, name: string, branch?: string) => WorktreeDiff
  diffWorktreeNumstat: (basePath: string, name: string, branch?: string) => WorktreeNumstat[]
  nativeWorkingTreeStatus: (path: string, opts?: { allowFailure?: boolean }) => string
  nativeDetectMainBranch: (basePath: string) => string
  nativeCommitCountBetween: (basePath: string, from: string, to: string) => number
  onDebugFailure?: (scope: string, error: unknown) => void
}

export interface WorktreeStatus {
  name: string
  path: string
  branch: string
  exists: boolean
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  uncommitted: boolean
  commits: number
}

export function hasWorktreeChanges(
  deps: WorktreeStatusDependencies,
  basePath: string,
  name: string,
  branch: string,
): boolean {
  const diff = deps.diffWorktreeAll(basePath, name, branch)
  return diff.added.length + diff.modified.length + diff.removed.length > 0
}

export function findWorktreesWithChanges<T extends WorktreeScanItem>(
  deps: WorktreeStatusDependencies,
  basePath: string,
  worktrees: T[],
  debugScope: string,
): T[] {
  return worktrees.filter((wt) => {
    try {
      return hasWorktreeChanges(deps, basePath, wt.name, wt.branch)
    } catch (error) {
      deps.onDebugFailure?.(`${debugScope} for ${wt.name}`, error)
      return false
    }
  })
}

export function getWorktreeStatus(
  deps: WorktreeStatusDependencies,
  basePath: string,
  name: string,
  wtPath: string,
  branch: string,
): WorktreeStatus {
  const diff = deps.diffWorktreeAll(basePath, name, branch)
  const numstat = deps.diffWorktreeNumstat(basePath, name, branch)
  const filesChanged = diff.added.length + diff.modified.length + diff.removed.length
  let linesAdded = 0
  let linesRemoved = 0
  for (const s of numstat) {
    linesAdded += s.added
    linesRemoved += s.removed
  }

  // `uncommitted` also decides whether doMerge auto-commits before the squash
  // merge, so an unreadable worktree must fail closed rather than merge as if
  // it were clean. nativeHasChanges is unsuitable here: it caches its verdict
  // for 10s and reports a failed status as clean.
  const exists = existsSync(wtPath)
  let uncommitted = false
  if (exists) {
    try {
      uncommitted = deps.nativeWorkingTreeStatus(wtPath, { allowFailure: false }).trim() !== ''
    } catch (error) {
      deps.onDebugFailure?.('native worktree dirty check', error)
      uncommitted = true
    }
  }

  let commits = 0
  try {
    const mainBranch = deps.nativeDetectMainBranch(basePath)
    commits = deps.nativeCommitCountBetween(basePath, mainBranch, branch)
  } catch (error) {
    deps.onDebugFailure?.('native commit count', error)
  }

  return {
    name,
    path: wtPath,
    branch,
    exists,
    filesChanged,
    linesAdded,
    linesRemoved,
    uncommitted,
    commits,
  }
}
