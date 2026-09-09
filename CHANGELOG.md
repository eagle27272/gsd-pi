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
