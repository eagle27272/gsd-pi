<!-- GSD Pi - Personal CLI fork -->

# GSD Pi

Personal fork of [open-gsd/gsd-pi](https://github.com/open-gsd/gsd-pi), customized for CLI-only use. The web UI, VS Code extension, standalone MCP server surface, Discord/remote integrations, and several bundled extensions have been removed. What remains is the terminal agent, the `.gsd/` project workflow (milestones, slices, tasks, auto mode), worktree-aware Git automation, and multi-provider model routing.

See [CHANGELOG.md](./CHANGELOG.md) for the fork baseline.

## Build from source

```bash
pnpm install
pnpm run build:core   # `build` is an alias for `build:core`
```

## Run

Dev entry point (no global install needed):

```bash
node scripts/dev-cli.js
```

Or link the `gsd` binary globally:

```bash
pnpm run install-global     # symlinks gsd + gsd-cli into `npm prefix -g`/bin
pnpm run uninstall-global   # removes them
```

The symlinks point at `dist/bootstrap.js` in this checkout, so a later
`git pull && pnpm run build:core` updates the global `gsd` in place — no re-link
needed. If the target bin directory is not on your `PATH`, the script prints the
`export PATH=...` line to add. Override the destination with `--bin-dir <path>`
or `GSD_GLOBAL_BIN_DIR`.

Then run `gsd` in any project directory. GSD stores project planning and runtime
state under `.gsd/`, with gitignored sibling runtime directories such as
`.gsd-backups/` for migration snapshots.

## Common Session Commands

Start a session, then use slash commands inside it:

```text
/gsd config
/gsd auto
/gsd quick "Describe the task"
/gsd status
```

For automation, quick tasks have a non-interactive entry point with a structured
result and a meaningful exit code:

```bash
node scripts/dev-cli.js quick --output-format json "Describe the task"
```

### Reporting gsd-pi bugs

- **Self-report (`GSD_BUG_REPORT`)** — when the agent finds a defect in the gsd-pi CLI itself, it drafts a GitHub issue and, after you approve it in-session, files it to `eagle27272/gsd-pi` (override with `GSD_BUG_REPORT_REPO`). Set `GSD_BUG_REPORT=off` to disable. Run `/report-gsd-bug` to file one by hand.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `src/` | Core runtime resources and bundled extensions |
| `packages/` | Workspace packages used by the CLI, agent, TUI, RPC, native bridge, and workflow MCP |
| `native/` | Native engine packaging and platform binaries |
| `docs/` | User and developer documentation |
| `scripts/` | Build, migration, and maintenance scripts |

## Docs

- [`docs/`](./docs/) — user and developer documentation
- [`VISION.md`](./VISION.md) — project vision
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — development workflow

## License

MIT
