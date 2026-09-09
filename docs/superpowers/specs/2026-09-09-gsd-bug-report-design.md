# gsd-pi Self-Report — Design

**Date:** 2026-09-09
**Status:** Approved for planning
**Branch:** TBD (`personal/gsd-bug-report` suggested)

## Context

This repository is a CLI-only personal hard fork of `open-gsd/gsd-pi`
(detached from the fork network, customized 2026-09-08/09). See
`docs/superpowers/specs/2026-09-08-strip-to-cli-design.md`.

The owner wants the `gsd` CLI to help maintain itself: whenever the CLI is
driving an agent — on *any* project — and that agent notices a defect in
**gsd-pi itself** (a broken `gsd` command, a workflow-MCP error, wrong CLI
output, an incorrect bundled doc), the CLI should offer to file a GitHub issue
to the fork repo `eagle27272/gsd-pi`. The issue is always drafted first and
filed only after the user approves in that session.

This is a standing capability of the CLI, not a per-repo instruction file. It
must work from a fresh checkout on any machine with no per-project setup.

## Goals

- Make "found a gsd-pi bug → tracked issue" a low-friction, built-in path.
- Draft-then-confirm: no issue is created without explicit in-session approval.
- Deterministic guarantees (dedupe, soft cap, environment capture, graceful
  degradation) live in code, not in model instructions.
- On by default in every session; one env var turns it off.
- Portable: auto-loads from the bundled-extensions directory, no wiring.

## Non-goals

- No automatic (unconfirmed) issue creation.
- No triage, labeling taxonomy, or project-board automation beyond a single
  `bug` (or `bug` + `documentation`) label.
- No telemetry, crash reporter, or background phone-home. The only network call
  is a `gh` invocation made after the user confirms (plus a best-effort
  duplicate search).
- No reporting of defects in the project the CLI is *working on*, or in code
  the agent is writing for the current task.
- No preferences-schema (`/preferences` UI) field in v1 — env var only. The
  fork deliberately trimmed that schema; a UI toggle can come later.
- Not a replacement for `github-sync` (which syncs a project's own issues).

## Behavior summary

### What counts as a reportable gsd-pi defect

- **runtime** — a `gsd` command crashes, hangs, or produces wrong behavior;
  the workflow MCP returns an error or wrong result; auto-mode misbehaves.
- **docs** — a bundled doc, `--help` text, or on-screen guidance is wrong or
  misleading.
- **dx** — a repo script is broken, a build/test harness misbehaves in a way
  that is a genuine defect (not environment misconfig).
- **test** — a genuine bug surfaced by a failing test.

### Explicit non-bugs (never file)

- Bugs in the project the CLI is currently working on.
- Bugs in code the agent is writing/modifying for the current task — fix in
  place.
- The ~23 baseline `pnpm run test:unit` failures on `main` itself: native
  `setMutationBoundaryFaultForTest` tests that need a `--test-fault-injection`
  build the dev environment does not produce.
- The known rotating flaky tests: SIGKILL-convergence, MCP-replay, write-gate
  `CONTEXT.md` (pass in isolation).
- Anything already covered by an existing open or closed issue (dedupe).

### When CWD is the gsd-pi repo itself

Behavior is identical — still draft and offer to file. (The agent may also fix
it in place; that is orthogonal.)

## Architecture

### New bundled extension: `src/resources/extensions/gsd-bug-report/`

Bundled extensions auto-load from `src/resources/extensions/<dir>/` when the
directory contains an `index.ts` entry point or an `extension-manifest.json`
(`src/resource-loader.ts`, `src/loader.ts` — `GSD_BUNDLED_EXTENSION_PATHS`).
No central registration edit is required. The extension therefore loads in
every session: interactive, `gsd auto`, and the Claude Code CLI provider.

Files:

| File | Responsibility |
|---|---|
| `extension-manifest.json` | id `gsd-bug-report`, tier `bundled`, `provides.tools`/`commands`/`hooks` |
| `index.ts` | default `(pi: ExtensionAPI) => void`; registers tool + command + `session_start` handler |
| `config.ts` | `isEnabled()`, `targetRepo()`, `SOFT_CAP` constant — reads env, no I/O |
| `report.ts` | pure core: dedupe matcher, body enrichment, draft rendering, category→label map, guideline text |
| `github.ts` | `gh` wrapper: `searchIssues()`, `createIssue()`, availability probe; never throws for expected failures |
| `session-state.ts` | per-process counter of issues filed this session + reset |
| `tests/` | `report.test.ts`, `config.test.ts`, `github.test.ts`, `registration.test.ts` |

### Components

**1. System-prompt guidance** — supplied as `promptGuidelines: [...]` on the
`pi.registerTool()` call (the idiom used by `search-the-web`, `mac-tools`,
`ask-user-questions`, `bg-shell`, `async-jobs`). ~6 lines covering: the
reportable categories, the explicit non-bugs (including the baseline and flaky
lists verbatim), the "you are working on project X; only report defects in the
gsd-pi CLI itself" boundary, subagent deferral, and "draft title + body and
call `report_gsd_bug` — it shows the user and files only on approval".

**2. Tool `report_gsd_bug`**

Params (TypeBox schema):

- `title: string` — issue title (imperative, specific).
- `body: string` — markdown: what happened, repro, expected vs actual,
  affected files / `path:line`.
- `category: "runtime" | "docs" | "dx" | "test"`.
- `area?: string` — short free text, e.g. `gsd auto`, `workflow-mcp`,
  `install-global`.

Handler pipeline:

1. `isEnabled()` false → return `{ status: "disabled" }` text.
2. `session filed count >= SOFT_CAP (3)` → return a "cap reached — summarize
   any further findings to the user at end of turn; do not call again this
   session" message. Overflow batching is the model's responsibility (matches
   the chosen "dedupe + soft cap" option); no stop hook.
3. **Dedupe**: `github.searchIssues(title)` →
   `gh issue list --repo <repo> --state all --search "<title keywords>" --json number,title,url,state`.
   Strong title-token overlap (Jaccard over lowercased alphanumeric tokens,
   threshold tuned in `report.ts`, default ~0.6, or exact substring) → return
   `{ status: "duplicate", issue: "#N", url }` without filing. Search error →
   treat as no match, mark "duplicate check skipped" in the draft.
4. **Enrich body**: append
   ```
   --- environment ---
   gsd-pi: <GSD_VERSION or package version>
   commit: <git -C <cliDir> rev-parse --short HEAD, if resolvable>
   platform: <process.platform> <process.arch>
   node: <process.version>
   cwd project: <basename of cwd>   # context only; not the target repo
   ```
   plus footer `_Filed via gsd-pi self-report._`
5. **Render draft** (title, labels, enriched body) and **ask for confirmation**
   through the CLI approval UI (shared TUI `Text` prompt, as in
   `ask-user-questions`): `File this issue to <repo>? [y/N]`.
6. **Approved** → `github.createIssue({ repo, title, body, labels })` →
   `gh issue create --repo <repo> --title <t> --body-file <tmp> --label bug`
   (add `documentation` when `category === "docs"`). Increment the session
   counter. Return `{ status: "filed", url }`.
7. **Declined** → return `{ status: "declined" }`. Counter unchanged.
8. **`gh` unavailable / any `gh` non-zero exit** at a GitHub step → return
   `{ status: "manual" }` carrying: the fully rendered draft, a paste-ready
   `gh issue create` command, and a prefilled
   `https://github.com/<repo>/issues/new?title=…&body=…&labels=bug` URL.

**3. Command `/report-gsd-bug`** — registered via `pi.registerCommand`. Same
pipeline as the tool. Accepts an inline title (`/report-gsd-bug <title>`) or
prompts for title/body, then runs dedupe → enrich → confirm → file. Lets the
user file by hand without involving the agent.

**4. `session_start` handler** — resets `session-state.ts` counter to 0 and
re-reads `isEnabled()` so a flag change between sessions in one process is
honored.

### Data flow

```
agent notices gsd-pi defect  (steered by promptGuidelines)
        v
report_gsd_bug(title, body, category, area?)
        |
   isEnabled? --no--> "disabled"
        | yes
   filed < 3 ? --no--> "cap reached; summarize the rest"
        | yes
   gh dedupe search --match--> "duplicate #N <url>"
        | no match (or search failed)
   enrich body (version / commit / platform / node)
        v
   render draft --> USER CONFIRM [y/N] --no--> "declined"
        | yes
   gh issue create --ok--> "filed: <url>"  (counter++)
        | gh unavailable / non-zero
   "manual": draft + paste-ready command + prefilled issues/new URL
```

## Configuration

| Control | Values | Default | Effect |
|---|---|---|---|
| `GSD_BUG_REPORT` env | `off` / `0` / `false` (case-insensitive) disable; else enabled | enabled | `isEnabled()` gate on tool + command |
| `GSD_BUG_REPORT_REPO` env | `owner/repo` | `eagle27272/gsd-pi` | Target repo for search + create |
| `SOFT_CAP` | integer constant in `config.ts` | `3` | Max issues filed per session before overflow message |

Default target repo is a `config.ts` constant, not hard-coded at call sites.

## Error handling

- **`gh` missing / unauthenticated** — `github.ts` probes (`gh --version`
  ENOENT; `gh auth status` non-zero). Any expected failure resolves to the
  `manual` status above; the tool never throws to the agent.
- **Dedupe search failure** — non-fatal; proceed as "no match" and annotate
  the draft. Prefer a possible duplicate over a dropped report.
- **`issue create` fails after confirmation** — return the error text plus the
  paste-ready command; counter not incremented.
- **User declines confirm** — clean `declined` return, no side effects.
- **Extension load failure** — isolated by the bundled-extension loader like
  any other extension; cannot break session startup.
- **Malformed args** — schema rejection with a message naming the missing
  field.
- **Subagent context** — guideline instructs deferral to the parent session;
  the counter is per-process so a subagent shares the parent's cap.

## Testing strategy

Pure unit tests, no live network, following the existing extension-test layout
(`src/resources/extensions/search-the-web/tests`).

- **`report.test.ts`** — dedupe token-overlap matcher (match / near-miss /
  no-match); enrichment block shape; draft rendering; `category`→label map;
  guideline text contains the baseline + flaky exclusion phrases.
- **`config.test.ts`** — `isEnabled()` truth table for `GSD_BUG_REPORT`;
  `targetRepo()` default and `GSD_BUG_REPORT_REPO` override.
- **`github.test.ts`** — `gh` wrapper against a stubbed spawn: success parses
  the issue URL; ENOENT → `unavailable`; non-zero exit → `unavailable` with
  stderr captured; search JSON parsing.
- **`registration.test.ts`** — loading `index.ts` against a fake
  `ExtensionAPI` registers exactly `report_gsd_bug` + `/report-gsd-bug`,
  attaches `promptGuidelines`, wires `session_start`; manifest `provides`
  matches what is registered (mirrors the `search-the-web` contract test).
- **Soft cap** — 4 simulated calls; the 4th returns the cap message and does
  not invoke `github.ts`.
- **Confirm gate** — stubbed approval UI: `yes` → `createIssue` called;
  `no` → not called.

Manual pre-merge checks: one `report_gsd_bug` run with `gh` present, declined
at the confirm prompt; one run with `GSD_BUG_REPORT=off` (tool returns
`disabled`).

## File list

**New**

- `src/resources/extensions/gsd-bug-report/extension-manifest.json`
- `src/resources/extensions/gsd-bug-report/index.ts`
- `src/resources/extensions/gsd-bug-report/config.ts`
- `src/resources/extensions/gsd-bug-report/report.ts`
- `src/resources/extensions/gsd-bug-report/github.ts`
- `src/resources/extensions/gsd-bug-report/session-state.ts`
- `src/resources/extensions/gsd-bug-report/tests/report.test.ts`
- `src/resources/extensions/gsd-bug-report/tests/config.test.ts`
- `src/resources/extensions/gsd-bug-report/tests/github.test.ts`
- `src/resources/extensions/gsd-bug-report/tests/registration.test.ts`

**Modified**

- `README.md` — one line documenting `GSD_BUG_REPORT` / `GSD_BUG_REPORT_REPO`
  and the self-report behavior.
- Any existing test that asserts the exact bundled-extension set or count
  (to be identified during planning; e.g. a `resource-loader` or
  build-script contract test). Adjust the expected set if such a test exists.

**Not changed**

- The `gsd` extension, `src/loader.ts` / `src/resource-loader.ts` discovery
  logic, `package.json`.

## Open questions for planning

- Exact `ExtensionAPI` surface for the confirmation prompt (reuse the
  `shared/tui.ts` `showInterviewRound` / `Text` path used by
  `ask-user-questions`, or a lighter yes/no helper if one exists).
- Whether any bundled-extension-set test needs updating (grep during plan
  step 1).
- Dedupe threshold value and token-normalization rules — settle with a small
  fixture set in `report.test.ts`.
