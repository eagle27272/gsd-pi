// @opengsd/mcp-server — Environment variable write utilities
//
// Shared helpers for writing env vars to .env files, detecting project
// destinations, and checking existing keys. Used by secure_env_collect
// MCP tool. No TUI dependencies — pure filesystem + process.env operations.

import { open, readFile, rename, rm } from "node:fs/promises";
import { constants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Keys this process wrote and then mirrored into `process.env`. Their presence
 * in the environment says nothing about whether the *destination file* is
 * configured, so `checkExistingEnvKeys` must not read them as "already set".
 */
const hydratedByThisProcess = new Set<string>();

/**
 * Mirror a freshly written value into `process.env` so the current session
 * sees it, while remembering that we are the reason it is there.
 */
export function hydrateProcessEnv(key: string, value: string): void {
  process.env[key] = value;
  hydratedByThisProcess.add(key);
}

// ---------------------------------------------------------------------------
// checkExistingEnvKeys
// ---------------------------------------------------------------------------

/**
 * Check which keys already exist in a .env file or process.env.
 * Returns the subset of `keys` that are already set.
 */
export async function checkExistingEnvKeys(keys: string[], envFilePath: string): Promise<string[]> {
  let fileContent = "";
  try {
    fileContent = await readFile(envFilePath, "utf8");
  } catch (err) {
    // A missing file means nothing is configured yet. Any other failure
    // (EACCES, EISDIR, …) would make every key look unset and re-prompt the
    // user for secrets they have already supplied.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const existing: string[] = [];
  for (const key of keys) {
    const regex = new RegExp(`^${escapeRegExp(key)}\\s*=`, "m");
    const inheritedFromEnvironment = key in process.env && !hydratedByThisProcess.has(key);
    if (regex.test(fileContent) || inheritedFromEnvironment) {
      existing.push(key);
    }
  }
  return existing;
}

// ---------------------------------------------------------------------------
// detectDestination
// ---------------------------------------------------------------------------

/**
 * Detect the write destination based on project files in basePath.
 * Priority: vercel.json → convex/ dir → fallback "dotenv".
 */
export function detectDestination(basePath: string): "dotenv" | "vercel" | "convex" {
  if (existsSync(resolve(basePath, "vercel.json"))) {
    return "vercel";
  }
  const convexPath = resolve(basePath, "convex");
  try {
    if (existsSync(convexPath) && statSync(convexPath).isDirectory()) {
      return "convex";
    }
  } catch {
    // stat error — treat as not found
  }
  return "dotenv";
}

// ---------------------------------------------------------------------------
// writeEnvKey
// ---------------------------------------------------------------------------

/**
 * Write a single key=value pair to a .env file.
 * Updates existing keys in-place, appends new ones at the end.
 */
export async function writeEnvKey(filePath: string, key: string, value: string): Promise<void> {
  if (typeof value !== "string") {
    throw new TypeError(`writeEnvKey expects a string value for key "${key}", got ${typeof value}`);
  }
  assertWritableEnvFileTarget(filePath);
  let content = "";
  try {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      content = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    content = "";
  }
  const line = `${key}=${formatEnvValue(value)}`;
  const keyLinePattern = `^${escapeRegExp(key)}\\s*=.*$`;
  if (new RegExp(keyLinePattern, "m").test(content)) {
    // Every definition is rewritten, not just the first: dotenv and `source`
    // both honour the last one, so a duplicate left behind would keep the old
    // value operative while we report the write as applied. The replacement is
    // a function so `$&`-style sequences inside the secret stay literal.
    content = content.replace(new RegExp(keyLinePattern, "gm"), () => line);
  } else {
    if (content.length > 0 && !content.endsWith("\n")) content += "\n";
    content += `${line}\n`;
  }
  const tempPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.close();
    handle = undefined;
    assertWritableEnvFileTarget(filePath);
    await rename(tempPath, filePath);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Best-effort cleanup.
      }
    }
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Render a value so both `dotenv` and `set -a; source .env` read back exactly
 * what the user typed.
 *
 * Single quotes are the only form dotenv returns byte-for-byte — it strips the
 * quotes and unescapes nothing inside them — and POSIX shells treat them the
 * same way, so `$`, a backtick, `"`, `#` and spaces all survive. A value that
 * contains a single quote cannot use them and falls back to double quotes with
 * the four characters a shell still expands escaped; that form is exact for
 * dotenv too unless the value mixes a quote with one of ``\ " $ ` ``.
 *
 * The one input this is lossy for is a newline, stored as the two-character
 * escape `\n` so the file stays line-oriented for the in-place update above.
 * Both consumers read that back as a literal backslash-n, so a multi-line
 * secret (a PEM key, a service-account JSON) does not survive.
 */
function formatEnvValue(value: string): string {
  const stripped = value.replace(/\r/g, "");
  if (!stripped.includes("'")) {
    return `'${stripped.replace(/\n/g, "\\n")}'`;
  }
  return `"${stripped.replace(/[\\"$`]/g, "\\$&").replace(/\n/g, "\\n")}"`;
}

function assertWritableEnvFileTarget(filePath: string): void {
  try {
    if (lstatSync(filePath).isSymbolicLink()) {
      throw new Error("Refusing to write symlinked env file");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function isSafeEnvVarKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/**
 * Keys that influence the MCP server's own runtime — module loading, project
 * sandbox, CLI resolution. Allowing the LLM to set these via secure_env_collect
 * would let a misbehaving caller swap the workflow executor module mid-session
 * (RCE chain) or escape the project sandbox. We refuse to write or hydrate
 * these keys even when isSafeEnvVarKey() would otherwise accept them.
 */
const SECURITY_SENSITIVE_KEYS = new Set<string>([
  "GSD_WORKFLOW_EXECUTORS_MODULE",
  "GSD_WORKFLOW_WRITE_GATE_MODULE",
  "GSD_WORKFLOW_PROJECT_ROOT",
  "GSD_CLI_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
]);

export function isSecuritySensitiveEnvKey(key: string): boolean {
  return SECURITY_SENSITIVE_KEYS.has(key.toUpperCase());
}

export function isSupportedDeploymentEnvironment(env: string): boolean {
  return env === "development" || env === "preview" || env === "production";
}

function isWithinProjectRoot(projectRoot: string, candidatePath: string): boolean {
  const rel = relative(projectRoot, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Destinations this module is willing to write a secret to. Containment alone
 * is not enough: every part of the path is model-supplied, and `.bashrc`,
 * `.envrc` (executed by direnv on `cd`) and tracked source files are all
 * "inside the project". The user consented to storing a secret in a .env file.
 *
 * `:` is excluded from the suffix so an NTFS alternate data stream
 * (`.env.local:evil`) cannot hide a secret beside the file the user expects.
 */
const ENV_FILE_NAME_PATTERN = /^\.env(?:\.[^.:\\/]+)*$/;

/** Conventionally git-tracked placeholders — a secret here is staged for commit. */
const PLACEHOLDER_ENV_SUFFIXES = new Set(["example", "sample", "template", "dist", "defaults"]);

export const ENV_FILE_NAME_ERROR =
  "envFilePath must name a .env file (.env, .env.local, .env.production, …) and not a tracked placeholder";

/**
 * Shared by the tool schema and the write path so the two cannot drift. Takes a
 * whole path and judges its last segment, splitting on either separator so a
 * Windows-style path is not mistaken for one long filename.
 */
export function isAllowedEnvFilePath(envFilePath: string): boolean {
  const name = envFilePath.split(/[\\/]/).pop() ?? "";
  if (!ENV_FILE_NAME_PATTERN.test(name)) return false;
  const suffixes = name.slice(".env".length).split(".").filter(Boolean);
  const last = suffixes[suffixes.length - 1];
  return last === undefined || !PLACEHOLDER_ENV_SUFFIXES.has(last.toLowerCase());
}

/**
 * Files that mark a directory as a real project. `.git` is matched as a plain
 * entry so a linked worktree, where it is a file rather than a directory, still
 * counts.
 */
const PROJECT_ROOT_MARKERS = [
  ".gsd",
  ".git",
  "package.json",
  "deno.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "vercel.json",
  "convex",
];

function resolveHomeDir(): string {
  try {
    return realpathSync.native(resolve(homedir()));
  } catch {
    return resolve(homedir());
  }
}

/**
 * Nearest self-or-ancestor of `startDir` that carries a project marker, or null.
 *
 * The walk stops before `$HOME` and the filesystem root rather than passing
 * through them: a stray `~/package.json` should not make every directory under
 * the home directory look like a project.
 */
function findVerifiedProjectRoot(startDir: string): string | null {
  const home = resolveHomeDir();
  const fsRoot = parse(startDir).root;
  let current = startDir;
  while (current !== home && current !== fsRoot) {
    if (PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(current, marker)))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Containment is only meaningful against a root this module has some reason to
 * believe in. `projectDir` is model-supplied and `validateProjectDir` imposes no
 * containment unless GSD_WORKFLOW_PROJECT_ROOT is set, so without this an
 * arbitrary path — `$HOME`, `/`, a scratch directory — becomes the root and the
 * containment check below is a no-op.
 *
 * This does not distinguish one real project from another: a caller naming a
 * different checkout still passes. It rules out the directories that are not
 * projects at all.
 */
function assertPlausibleProjectRoot(projectRoot: string): void {
  if (projectRoot === parse(projectRoot).root) {
    throw new Error("projectDir must not be a filesystem root");
  }
  if (projectRoot === resolveHomeDir()) {
    throw new Error("refusing to write env files directly into the user's home directory");
  }
  if (findVerifiedProjectRoot(projectRoot) === null) {
    throw new Error(
      `projectDir does not look like a project: no ${PROJECT_ROOT_MARKERS.slice(0, 3).join(", ")} ` +
      `or similar marker at or above ${projectRoot}`,
    );
  }
}

export function resolveProjectEnvFilePath(projectDir: string, envFilePath = ".env"): string {
  const projectRoot = realpathSync.native(resolve(projectDir));
  assertPlausibleProjectRoot(projectRoot);
  const candidate = resolve(projectRoot, envFilePath);
  if (!isWithinProjectRoot(projectRoot, candidate)) {
    throw new Error("envFilePath must resolve inside the project directory");
  }
  if (!isAllowedEnvFilePath(candidate)) {
    throw new Error(ENV_FILE_NAME_ERROR);
  }
  if (existsSync(candidate)) {
    const targetRealPath = realpathSync.native(candidate);
    if (!isWithinProjectRoot(projectRoot, targetRealPath)) {
      throw new Error("envFilePath must resolve inside the project directory");
    }
    // The name check above only saw the link. Judge the file we will actually
    // write, or an in-repo `.env -> .envrc` would route the secret into a file
    // direnv executes on `cd`.
    if (!isAllowedEnvFilePath(targetRealPath)) {
      throw new Error(ENV_FILE_NAME_ERROR);
    }
    // Hand back the link target rather than the link. writeEnvKey renames a
    // temp file into place, which would replace an in-root symlink with a
    // regular file — and assertWritableEnvFileTarget refuses to do that at all,
    // so a project laid out as `.env -> config/.env.local` could never be
    // written. Resolving here keeps the link intact and the write contained.
    return targetRealPath;
  }
  const candidateParent = dirname(candidate);
  const parentRealPath = realpathSync.native(candidateParent);
  if (isWithinProjectRoot(projectRoot, parentRealPath)) {
    return candidate;
  }
  throw new Error("envFilePath must resolve inside the project directory");
}

// ---------------------------------------------------------------------------
// Shell helpers (for vercel/convex CLI)
// ---------------------------------------------------------------------------

export function shellEscapeSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// applySecrets
// ---------------------------------------------------------------------------

interface ApplyResult {
  applied: string[];
  errors: string[];
}

interface ExecOptions {
  stdin?: string;
}

/**
 * Apply collected secrets to the target destination.
 * Dotenv writes are handled directly; vercel/convex shell out via execFn.
 */
export async function applySecrets(
  provided: Array<{ key: string; value: string }>,
  destination: "dotenv" | "vercel" | "convex",
  opts: {
    envFilePath: string;
    environment?: string;
    execFn?: (cmd: string, args: string[], opts?: ExecOptions) => Promise<{ code: number; stderr: string }>;
  },
): Promise<ApplyResult> {
  const applied: string[] = [];
  const errors: string[] = [];

  if (destination === "dotenv") {
    for (const { key, value } of provided) {
      if (!isSafeEnvVarKey(key)) {
        errors.push(`${key}: invalid environment variable name`);
        continue;
      }
      if (isSecuritySensitiveEnvKey(key)) {
        errors.push(`${key}: refusing to set MCP server runtime variable via secure_env_collect`);
        continue;
      }
      try {
        await writeEnvKey(opts.envFilePath, key, value);
        applied.push(key);
        // Hydrate process.env so the current session sees the new value.
        // Sensitive keys are excluded above so a malicious caller cannot
        // swap our module-loading or sandbox configuration mid-session.
        hydrateProcessEnv(key, value);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${key}: ${msg}`);
      }
    }
  }

  if ((destination === "vercel" || destination === "convex") && opts.execFn) {
    const env = opts.environment ?? "development";
    if (!isSupportedDeploymentEnvironment(env)) {
      errors.push(`environment: unsupported target environment "${env}"`);
      return { applied, errors };
    }
    for (const { key, value } of provided) {
      if (!isSafeEnvVarKey(key)) {
        errors.push(`${key}: invalid environment variable name`);
        continue;
      }
      if (isSecuritySensitiveEnvKey(key)) {
        errors.push(`${key}: refusing to set MCP server runtime variable via secure_env_collect`);
        continue;
      }
      try {
        const result = destination === "vercel"
          ? await opts.execFn("vercel", ["env", "add", key, env], { stdin: value })
          : await opts.execFn("npx", ["convex", "env", "set", key], { stdin: value });
        if (result.code !== 0) {
          // The exit code, never the provider's stderr: a provider that rejects
          // a value on length or charset routinely echoes it back, and this
          // string goes into the one channel the AI reads.
          errors.push(`${key}: ${destination} command failed with exit code ${result.code}`);
        } else {
          applied.push(key);
          // Do NOT hydrate process.env after pushing to a remote destination:
          // no in-process reader needs a freshly-pushed remote secret, and
          // every spawned child would inherit the plaintext value.
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${key}: ${msg}`);
      }
    }
  }

  return { applied, errors };
}
