// gsd-pi — CodeGraph detection.
//
// Everything this extension registers is gated on detectCodegraph() returning
// non-null: a codegraph binary, and a .codegraph/ index at or above the session
// cwd. A git worktree is deliberately NOT resolved to its main checkout — that
// index describes a different tree (see the design doc).

import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { isTruthy } from "../shared/rtk-shared.js";

export const CODEGRAPH_DISABLED_ENV = "GSD_CODEGRAPH_DISABLED";
export const CODEGRAPH_PATH_ENV = "GSD_CODEGRAPH_PATH";

const BIN_NAME = "codegraph";
const INDEX_DIR = ".codegraph";

export interface CodegraphEnv {
  /** Path to the codegraph binary to invoke. */
  binPath: string;
  /** Directory containing the .codegraph/ index — passed to the CLI as `-p`. */
  projectRoot: string;
}

interface DetectOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when `projectRoot` directly contains a .codegraph/ index. */
export function hasIndex(
  projectRoot: string,
  isDirectory: (path: string) => boolean = defaultIsDirectory,
): boolean {
  return isDirectory(join(projectRoot, INDEX_DIR));
}

/**
 * Nearest ancestor of `startDir` (inclusive) holding a .codegraph/ index.
 *
 * The walk stops before testing $HOME: ~/.codegraph is CodeGraph's own global
 * state directory (daemon records, telemetry), so testing it would report every
 * project under the home directory as indexed.
 */
export function findIndexRoot(
  startDir: string,
  opts: { home?: string; isDirectory?: (path: string) => boolean } = {},
): string | null {
  const isDirectory = opts.isDirectory ?? defaultIsDirectory;
  const home = resolve(opts.home ?? homedir());
  let dir = resolve(startDir);
  for (;;) {
    if (dir === home) return null;
    if (isDirectory(join(dir, INDEX_DIR))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The codegraph binary: the env override if usable, else the first hit on PATH. */
export function resolveBinary(
  opts: { env?: NodeJS.ProcessEnv; isExecutable?: (path: string) => boolean } = {},
): string | null {
  const env = opts.env ?? process.env;
  const isExecutable = opts.isExecutable ?? defaultIsExecutable;
  const override = env[CODEGRAPH_PATH_ENV]?.trim();
  if (override) return isExecutable(override) ? override : null;
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, BIN_NAME);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** The whole gate. Null means this extension registers nothing at all. */
export function detectCodegraph(opts: DetectOptions = {}): CodegraphEnv | null {
  const env = opts.env ?? process.env;
  if (isTruthy(env[CODEGRAPH_DISABLED_ENV])) return null;
  const projectRoot = findIndexRoot(opts.cwd ?? process.cwd(), {
    home: opts.home,
    isDirectory: opts.isDirectory,
  });
  if (!projectRoot) return null;
  const binPath = resolveBinary({ env, isExecutable: opts.isExecutable });
  if (!binPath) return null;
  return { binPath, projectRoot };
}
