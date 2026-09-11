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
