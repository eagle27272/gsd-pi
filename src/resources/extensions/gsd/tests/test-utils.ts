/**
 * Shared test utilities for GSD extension tests.
 *
 * Provides cross-platform helpers for creating temporary git repos,
 * safe cleanup, file creation, and shell-free git operations.
 *
 * Usage:
 *   import { git, makeTempRepo, cleanup, createFile } from "./test-utils.ts";
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { externalGsdRoot } from "../repo-identity.ts";
import {
  LAYOUT_SEGMENTS,
  canonicalPhaseDirName,
  milestoneIdToPhaseNum,
  slicePlanFileName,
} from "../layout-policy.ts";

/**
 * Shell-free git helper — uses execFileSync to bypass shell entirely.
 * No quoting issues, no Windows cmd.exe incompatibilities.
 *
 * @param cwd - Working directory for git command
 * @param args - Git arguments (e.g., "add", "-A")
 * @returns trimmed stdout
 */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

/**
 * Create a temporary git repository with an initial commit.
 * Configures user.email, user.name, and core.autocrlf=false for
 * consistent behavior across platforms.
 *
 * @param prefix - Optional prefix for the temp directory name
 * @returns absolute path to the temp repo
 */
export function makeTempRepo(prefix: string = "gsd-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "README.md"), "# init\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  git(dir, "branch", "-M", "main");
  return dir;
}

/**
 * Create a temporary directory (not a git repo).
 *
 * @param prefix - Optional prefix for the temp directory name
 * @returns absolute path to the temp directory
 */
export function makeTempDir(prefix: string = "gsd-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

let sharedExternalStateRoot: string | null = null;

/**
 * Give a fixture repo the layout auto-start produces for a fresh project:
 * `<base>/.gsd` as a symlink into the external state root. Link before the
 * fixture writes any state — everything written to `<base>/.gsd/...`
 * afterwards lands in the external directory, exactly as in production.
 *
 * Redirects GSD_STATE_DIR into a temp root so no fixture reaches the real
 * ~/.gsd. Test files run one per process, so the override is process-local.
 *
 * @param base - Project root; must already be a git repo
 * @returns absolute path to the external state directory
 */
export function linkExternalGsdState(base: string): string {
  if (!sharedExternalStateRoot) {
    sharedExternalStateRoot = realpathSync(mkdtempSync(join(tmpdir(), "gsd-external-state-")));
    process.env.GSD_STATE_DIR = sharedExternalStateRoot;
  }
  const localGsd = join(base, ".gsd");
  const externalPath = externalGsdRoot(base);
  mkdirSync(externalPath, { recursive: true });
  rmSync(localGsd, { recursive: true, force: true });
  symlinkSync(externalPath, localGsd, "junction");
  return externalPath;
}

/**
 * Safely clean up a temporary directory.
 * Non-fatal — Windows may hold file descriptors briefly.
 */
export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore — Windows may hold file descriptors briefly after test
  }
}

/**
 * Create a file with intermediate directories.
 *
 * @param base - Base directory
 * @param relativePath - Relative path within base (e.g., "src/index.ts")
 * @param content - File content (defaults to empty string)
 * @returns absolute path to the created file
 */
export function createFile(base: string, relativePath: string, content: string = ""): string {
  const fullPath = join(base, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
  return fullPath;
}

/**
 * Safely read a file, returning null if it doesn't exist or is a directory.
 * Prevents EISDIR errors.
 */
export function safeReadFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    if (!statSync(filePath).isFile()) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Absolute path to the flat-phase directory a milestone id projects to.
 * `.gsd/phases/NN-slug/` — the only on-disk milestone layout.
 */
export function phaseDirFor(base: string, mid: string, title?: string): string {
  return join(base, ".gsd", LAYOUT_SEGMENTS.level1, canonicalPhaseDirName(mid, title));
}

/** Flat-phase milestone-level artifact file name: `NN-SUFFIX.md`. */
export function phaseFileName(mid: string, suffix: string): string {
  return `${String(milestoneIdToPhaseNum(mid)).padStart(2, "0")}-${suffix}.md`;
}

/**
 * Create a minimal GSD milestone structure in a temp directory, using the
 * flat-phase layout (`.gsd/phases/NN-slug/NN-SUFFIX.md`, plans at
 * `NN-MM-SUFFIX.md`).
 *
 * @param base - Base directory (should have .gsd/ or be a temp repo)
 * @param mid - Milestone ID (e.g., "M001")
 * @param options - What to create
 */
export function writeMilestoneFixture(
  base: string,
  mid: string,
  options: {
    title?: string;
    roadmap?: string;
    context?: string;
    summary?: string;
    validation?: string;
    slices?: Array<{
      id: string;
      plan?: string;
      summary?: string;
      uat?: string;
    }>;
  } = {},
): void {
  const phaseDir = phaseDirFor(base, mid, options.title);
  const phaseNum = milestoneIdToPhaseNum(mid);
  mkdirSync(phaseDir, { recursive: true });

  const writeMilestoneArtifact = (suffix: string, content: string): void => {
    writeFileSync(join(phaseDir, phaseFileName(mid, suffix)), content);
  };

  if (options.roadmap) writeMilestoneArtifact("ROADMAP", options.roadmap);
  if (options.context) writeMilestoneArtifact("CONTEXT", options.context);
  if (options.summary) writeMilestoneArtifact("SUMMARY", options.summary);
  if (options.validation) writeMilestoneArtifact("VALIDATION", options.validation);

  for (const slice of options.slices ?? []) {
    const writeSliceArtifact = (suffix: string, content: string): void => {
      writeFileSync(join(phaseDir, slicePlanFileName(phaseNum, slice.id, suffix)), content);
    };
    if (slice.plan) writeSliceArtifact("PLAN", slice.plan);
    if (slice.summary) writeSliceArtifact("SUMMARY", slice.summary);
    if (slice.uat) writeSliceArtifact("UAT", slice.uat);
  }
}
