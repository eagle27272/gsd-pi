/**
 * Env overlay for git child processes.
 *
 * Strips the parent-process vars that silently redirect git at a different
 * repository or index — an agent started from a git hook or from a shell that
 * pre-set GIT_DIR would otherwise report that repo's branch instead of the
 * one it was pointed at.
 *
 * Local to this package: it has no runtime dependency that could host a shared
 * copy. Keep in sync with src/resources/extensions/gsd/git-constants.ts.
 */

const LEAKING_GIT_ENV_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
];

function buildSafeParentEnv(): NodeJS.ProcessEnv {
	const safe: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (!LEAKING_GIT_ENV_VARS.includes(k)) safe[k] = v;
	}
	return safe;
}

/** Rebuilt per call so a runtime PATH or HOME change still reaches git. */
export function gitNoPromptEnv(): NodeJS.ProcessEnv {
	return {
		...buildSafeParentEnv(),
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "",
		GCM_INTERACTIVE: "Never",
	};
}
