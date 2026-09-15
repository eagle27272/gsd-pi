# CodeGraph integration: a read-only bundled extension

Design for integrating [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)
into gsd-pi, so the agent reaches for a symbol graph instead of grep when a project
has one.

## What codegraph is

A SQLite knowledge graph of a codebase's symbols, edges and files, built by a CLI
(`codegraph init`, then a background daemon keeps it synced) and stored in a
`.codegraph/` directory at the project root. Its value to an agent is `explore`:
one call returns the verbatim, line-numbered source of the symbols relevant to a
question *plus* the call paths between them, including dynamic-dispatch hops that
grep cannot follow. That replaces a grep → read → grep loop with one round trip.

The CLI is already installed on this machine and the main gsd-pi checkout is
already indexed. Upstream ships an MCP server and a `codegraph install` command
targeting Claude Code, Cursor, Codex CLI, opencode, Hermes, Gemini CLI,
Antigravity, Kiro and Copilot — gsd-pi is not among them.

## Why an extension rather than MCP

gsd-pi already has an `mcp-client` extension, so registering codegraph's MCP
server in `~/.gsd/mcp.json` would be near-zero work. It was rejected for two
reasons:

- The agent reaches MCP tools through `mcp_discover` / `mcp_call` indirection.
  There is no first-class tool name in the schema, so the model has to decide to
  go looking before it can decide to use it.
- There is no seam for prompt guidance, so nothing can tell the model to prefer
  the graph over grep — which is the entire point of the integration.

A bundled extension gets real tool names, per-tool prompt guidelines, and the
ability to disappear entirely when it cannot help.

## Shape

A new bundled extension at `src/resources/extensions/codegraph/`, following the
pattern established by `herdr` (hard no-op when its environment is absent) and
`mac-tools` (wraps an external binary, registers tools).

| File | Purpose |
|---|---|
| `extension-manifest.json` | `id: "codegraph"`, tier `bundled`, `provides.tools` |
| `detect.ts` | binary lookup and index discovery — the whole gate |
| `cli.ts` | `execFile` wrapper: argv build, abort signal, timeout, exit mapping |
| `tools.ts` | the two `pi.registerTool` definitions |
| `index.ts` | default export: detect, then bail or register |
| `tests/` | unit tests against a faked exec seam |

Extension discovery is a directory scan plus manifest read
(`src/extension-registry.ts`), and a fresh registry treats every bundled
extension as enabled. So no registration list needs editing, and
`gsd extensions disable codegraph` works without any extra code.

## The gate

`export default function (pi: ExtensionAPI)` returns before registering anything
— no tools, no hooks, no prompt text — unless all three hold:

1. `GSD_CODEGRAPH_DISABLED` is unset or falsy, mirroring `GSD_RTK_DISABLED_ENV`
   in `src/rtk-shared.ts`.
2. A `codegraph` binary resolves: `GSD_CODEGRAPH_PATH` if set, otherwise a PATH
   lookup. Resolution is cached for the session.
3. A `.codegraph/` directory exists at, or above, the session's cwd. The walk
   stops at `$HOME` and at the filesystem root, so a stray index in a parent
   directory of your home cannot capture unrelated projects.

Failing the gate is not an error state. Nothing is logged, nothing is surfaced,
and the tool schemas cost no tokens.

### Worktrees are deliberately excluded

gsd-pi sessions overwhelmingly run in git worktrees under `~/.claude/worktrees/`,
which are never indexed — `codegraph status` in one reports "Not initialized"
even when the main checkout is fully indexed.

Falling back to the main checkout via `git rev-parse --git-common-dir` is trivial
and was rejected. The main checkout's index describes the main checkout's files:
a different branch, different line numbers, sometimes different function bodies.
Serving that source to an agent that is about to edit a worktree is the same
class of trap as gsd-pi's dist being loaded from the main checkout while you edit
a worktree — confidently wrong, and wrong in a way the agent cannot detect.

The cost is real and accepted: codegraph is unavailable in the worktrees where
most work happens, until the user indexes them. That is the user's call to make,
consistent with the read-only stance below.

## Read-only, always

The extension never runs `init`, `index`, or `sync`, and never writes to the
repository. Whether a project is indexed is the user's decision; keeping the
index fresh is the codegraph daemon's job. This keeps the extension
side-effect-free and means a stale or broken index is never gsd-pi's doing.

## Tool contract

Two tools, mirroring exactly what codegraph's own MCP server exposes. They
subsume `query`, `context`, `callers` and `callees` in practice, and everything
else in the CLI stays reachable through bash. Each additional tool schema is paid
for on every request, which is why the surface stops here.

```
codegraph_explore(query: string, maxFiles?: number)
  → codegraph --no-color explore -p <root> [--max-files N] <query...>

codegraph_node(name?: string, file?: string, offset?: number,
               limit?: number, symbolsOnly?: boolean)
  → codegraph --no-color node -p <root> [-f <file>] [--offset N]
       [--limit N] [--symbols-only] [<name>]
```

`codegraph_node` requires at least one of `name` or `file`; a call with neither
returns an `isError` result explaining that, without spawning a process.

Stdout passes through verbatim — it is already line-numbered and formatted for a
model — truncated with the `truncateHead` and `DEFAULT_MAX_BYTES` helpers
exported from `@gsd/pi-coding-agent`, as the `mcp-client` extension does.
`--no-color` is always passed so no ANSI escapes reach the transcript.

Every invocation forwards the tool's `AbortSignal` to `execFile` and sets a hard
timeout, so a wedged index cannot consume a turn.

## Steering the agent

Carried entirely by each tool's `promptSnippet` and `promptGuidelines` — the same
fields the core tools use (`packages/pi-coding-agent/src/core/tools/grep.ts`,
`.../edit.ts`). The wording is adapted from the user's global CLAUDE.md: reach
for `codegraph_explore` before grep or find when locating or understanding code;
name a file or symbol in the query to get its current line-numbered source.

No `before_agent_start` hook is needed. Because registration is already
conditional on the gate, the guidance is automatically absent in unindexed repos
and present in indexed ones — which is the desired behaviour, reached with less
machinery.

## Failure modes

| Condition | Behaviour |
|---|---|
| No binary, no index, or disabled | Not an error. Nothing registers. |
| Index removed mid-session | Per-call re-check against the memoised root; `isError` with a one-line explanation. |
| Nonzero exit | `isError` carrying the tail of codegraph's stderr. |
| Timeout or abort | `isError` naming the timeout; the child is killed. |
| Stale lock file | Codegraph prints its own guidance; passed through unmodified. |

Nothing in the extension throws into the agent loop, and nothing writes to the
repository, so no failure here can corrupt a session or a working tree.

## Testing

Unit tests in `src/resources/extensions/codegraph/tests/`, using an injected exec
seam so no test spawns the real binary:

- Index discovery finds a `.codegraph/` in a parent directory, stops at `$HOME`,
  and does not consult the git common dir.
- `GSD_CODEGRAPH_DISABLED` and a missing binary each prevent registration.
- Argv construction for both tools, including optional-flag omission and the
  `codegraph_node` neither-name-nor-file rejection.
- Output truncation at the byte cap.
- Nonzero exit, timeout, and abort each map to `isError` rather than a throw.

The test glob must be added to both `test:unit:compiled` and
`test:coverage:unit` in `package.json`. Those scripts enumerate extension test
directories explicitly, one path per extension, so a new `tests/` directory runs
nowhere in CI unless it is added — the failure is silent and looks like passing.

## Out of scope

Deliberately excluded, to be revisited only if real sessions show the need:

- `impact` and `affected` tools, and wiring `affected` into the GSD verification
  gate to pick a test subset.
- Routing the built-in `grep` / `find` / `read` tools through the graph, or a
  `bash-interceptor` rule for them.
- Any index management: `init` prompts, `sync` on session start, staleness
  checks.
- Injecting `codegraph context` output at session start.
- The worktree fallback described and rejected above.
- Upstreaming a `codegraph install --agent gsd` target.
