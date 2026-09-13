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
