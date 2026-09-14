/**
 * Shared git constants used across git-service and native-git-bridge.
 */

/**
 * Parent process env vars that, if leaked into a git child process, can
 * silently redirect every operation to a different repo or index.
 *
 * Stripped by gitNoPromptEnv() so a GSD invoked from inside a git hook,
 * a different worktree's terminal, or any context that pre-set these vars
 * cannot redirect GSD's git operations to the wrong target.
 * (Issue #4980 NEW-1)
 */
const LEAKING_GIT_ENV_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
] as const;

function buildSafeParentEnv(): NodeJS.ProcessEnv {
  const safe: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!LEAKING_GIT_ENV_VARS.includes(k as (typeof LEAKING_GIT_ENV_VARS)[number])) {
      safe[k] = v;
    }
  }
  return safe as NodeJS.ProcessEnv;
}

/**
 * Env overlay for git child processes: suppresses interactive credential
 * prompts and git-svn noise, and strips the redirecting vars above.
 *
 * Rebuilt from the current process.env on every call. An earlier version was a
 * module-load snapshot, which also froze PATH, HOME and everything else — a
 * later `process.env.PATH = …` never reached the git child, and the behaviour
 * depended on module import order.
 */
export function gitNoPromptEnv(): NodeJS.ProcessEnv {
  return {
    ...buildSafeParentEnv(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GCM_INTERACTIVE: "Never", // Git Credential Manager's equivalent of GIT_TERMINAL_PROMPT=0
    GIT_SVN_ID: "",
    LC_ALL: "C", // force English git output so stderr string checks work on all locales (#1997)
  };
}
