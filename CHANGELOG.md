# Changelog

Personal fork of [open-gsd/gsd-pi](https://github.com/open-gsd/gsd-pi), detached at
upstream **v1.18.0**. Later changes are tracked in this repository's git history.

## [Unreleased]

### Added

- Bundled `herdr` extension: when GSD runs inside a [Herdr](https://github.com/herdrdev/herdr)
  pane it reports lifecycle state (working/idle/blocked), native session identity, and
  auto-mode context (milestone/slice/task + phase) as the pane title, and routes blocked
  notifications through Herdr. No-op outside Herdr. Opt out via the `herdr` preferences
  block or `gsd extensions disable herdr`.
- `/gsd doctor` check `artifact_phase_dir_split`: flags a milestone whose artifact rows are
  spread over two `.gsd/phases/NN-*` directories, a state that was previously invisible
  because every row path still pointed at a file that existed
  ([#2](https://github.com/eagle27272/gsd-pi/issues/2)).

### Removed

- The obsolete migration surfaces, in four waves. Nothing imports markdown into the
  database any more, and nothing converts an old on-disk layout:
  - **Telemetry and alias shims** — the legacy telemetry counters and the in-process
    MCP tool aliases, along with the `GSD_ADVERTISE_TOOL_ALIASES` switch that
    registered them. The packaged `gsd-workflow` MCP server keeps its own
    `GSD_MCP_ADVERTISE_ALIASES` switch.
  - **`/gsd migrate`** — the `.planning/` → `.gsd/` import command. gsd-pi still
    observes `.planning/` edits as drift and still projects database state back to a
    recorded `.planning/` layout, but it cannot adopt one.
  - **The legacy-import kernel** (38 modules), the no-argument `/gsd recover`
    markdown-import form, and the `gsd headless recover` entrypoint. `/gsd recover
    <recoveryActionId>` — Task recovery resume — is unaffected. The canonical-JSON
    primitives the kernel owned now live in `canonical-json.ts`.
  - **Pathing and relocation** — `flat-phase-migration.ts`, `migrate-external.ts`
    (the in-repo `.gsd/` → `~/.gsd/projects/<hash>/` relocation), and `paths.ts`'s
    pre-flat-phase resolver branches. A real in-repo `.gsd/` directory is a supported
    layout and is no longer moved. In its place, `legacy-layout-guard.ts` refuses to
    start on a content-bearing `.gsd/milestones/<MID>/`; **v1.18.0 is the last
    release that can convert that layout to `.gsd/phases/`.**

### Fixed

- Slice-parallel worktree setup no longer deletes outside the worktrees container. The
  `rmSync` that clears a stale slice worktree ran on a path built by interpolating the
  milestone and slice ids into a worktree name, with no containment check — a `../` in
  either id pointed it anywhere under the project's parent. `createWorktree`'s own name
  validation does run, but only after the delete. Both ids are now rejected up front if
  they carry a path separator or `..`, and the delete is gated on `isInsideWorktreesDir`,
  matching the five other destructive worktree sites
  ([#21](https://github.com/eagle27272/gsd-pi/issues/21)).
- A crafted `milestoneId` can no longer redirect workflow tool writes into another
  checkout. The MCP server joins the id onto the worktree container and lets the result
  *replace* the validated `projectDir`; the two `existsSync` gates blocked traversal to
  nonexistent paths but not to a live sibling repository, whose `.gsd/` would then receive
  every subsequent write. The id must now match the artifact-id alphabet, and the
  replacement path has to clear a realpath-based containment check against the project's
  own worktree containers rather than inheriting the project root's trust. The check is
  unconditional: `validateProjectDir` confines paths only when
  `GSD_WORKFLOW_PROJECT_ROOT` is set, which the standalone server often runs without, so
  on its own it would have left a symlinked container entry free to redirect writes. The
  no-milestone-id fallback that adopts a sole live worktree goes through the same gate
  ([#21](https://github.com/eagle27272/gsd-pi/issues/21)).
- Three task-scoped artifacts no longer collide between sibling slices that reuse a task
  id. In the flat-phase layout every slice in a milestone resolves to the same phase
  directory, so a listing of it mixes all of their files together. The reactive-execute
  verification gate counted any `T##-SUMMARY.md` in that directory and passed a slice on
  another slice's evidence; escalation and reopen-reason artifacts were written as bare
  `T##-ESCALATION.json` / `T##-REOPEN.json` and overwrote each other, so dispatch could
  inject the wrong diagnosis. The gate now filters the listing by slice, and both JSON
  artifacts are written slice-qualified (`S##-T##-…`). An artifact already on disk under
  the bare name keeps it, so nothing in flight is orphaned
  ([#5](https://github.com/eagle27272/gsd-pi/issues/5)).
- Renaming a milestone no longer splits its artifacts between two `phases/NN-slug/`
  directories. The on-disk rename used a project path reconstructed from the database path,
  which is wrong whenever `.gsd` is a symlink into the external state directory, so the
  directory never moved while the artifact rows were re-keyed to the new title's slug
  anyway. Artifact rows are now keyed to the phase directory that actually exists
  ([#2](https://github.com/eagle27272/gsd-pi/issues/2)).
- Unit tool surfaces advertised `gsd_capture_thought`, which only the `gsd-workflow` MCP
  server registers — on a native session the host registers `capture_thought`, so
  execute-task, execute-task-simple, and complete-slice each cost a failed call and a
  retry to record a memory. The advertised names are now resolved to the spelling the
  session's transport actually presents ([#28](https://github.com/eagle27272/gsd-pi/issues/28)).
