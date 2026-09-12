# Switching between gsd-core and gsd-pi

Both `@opengsd/gsd-core` and `@opengsd/gsd-pi` use the same `.gsd/` directory, but they do not share an authority model. Switching requires an explicit handoff when modeled markdown changes. This doc explains that workflow and what to do when the two tools disagree.

## The shared contract

gsd-core treats `.gsd/*.md` files as the source of truth. gsd-pi treats its SQLite database as canonical and uses those files only as projections. It never imports modeled markdown — not during startup, not during `/gsd sync`, not on demand. Every change has to go through gsd-pi's planning and reopen tools; if the database itself is missing or damaged, restore it with `/gsd db restore-backup` rather than expecting markdown to repopulate it.

## Recommended workflow: commit before switching

Git is the integration layer. Before switching tools, commit:

```bash
git add .gsd/
git commit -m "wip: switching to gsd-pi"
```

Then open the other tool. The commit preserves reviewable markdown edits, but it does not back up gsd-pi's gitignored database — and committed markdown cannot be imported back into it. Do not use `git reset --hard` as database recovery; use `/gsd db restore-backup` when database recovery is required.

## What gsd-pi does on startup

When you open a project in gsd-pi, it runs a reconciliation pass that:

1. Compares every `.gsd/*.md` file against its recorded baseline in `.gsd/.compat.json`.
2. Preserves externally edited modeled files under `.gsd/quarantine/projections/` instead of importing or overwriting their bytes.
3. Re-projects markdown from the DB while valid database-backed work continues.
4. Updates `.gsd/.compat.json` after a successful projection.

This is automatic. Projection drift does not become workflow authority or block otherwise valid work; review the preserved copy if you need to recover an external edit.

## `/gsd sync` — mid-session switch

If you switch tools while gsd-pi is running (e.g., a teammate edits `.gsd/plan.md` via gsd-core and pushes), run:

```
/gsd sync
```

This checks projections against the database. Modeled drift is preserved under `.gsd/quarantine/projections/` without being imported, then sync re-projects from the database. Safe `.planning/` passthrough changes only refresh their checksums. Workflow-state blockers can still stop sync. Use `--dry-run` to list projection edits that would be preserved without repairs, projection, or marker writes:

```
/gsd sync --dry-run
```

## `/gsd doctor` — check compat health

`/gsd doctor` includes a compat-health line that tells you whether the marker is present and whether any files have drifted:

```
Compat health:      OK
```

or

```
Compat health:      2 file(s) drifted — run /gsd sync
```

## What gsd-core sees

gsd-core is unaware of gsd-pi. It sees `.gsd/*.md` as ordinary markdown and edits them directly. gsd-pi's `.gsd/.compat.json` and `gsd.db` files are ignored by gsd-core (it preserves unknown files, so they won't be deleted).

## `.planning/` projects

If your project uses gsd-core's `.planning/` layout (flat `phases/NN-name/` directories, root `ROADMAP.md` / `STATE.md`), gsd-pi **observes** it but cannot adopt it. The bulk `.planning/` → database import was removed; there is no command that turns a gsd-core tree into gsd-pi state. To move a `.planning/` project to gsd-pi, re-enter its milestones, slices, and tasks through gsd-pi's planning commands.

- gsd-pi detects `.planning/` edits as drift and reports them. It will not import them, and `/gsd sync` preserves them under `.gsd/quarantine/projections/` rather than adopting them.
- Once `.gsd/.compat.json` records a layout, gsd-pi projects canonical DB state back to `.planning/` on every projection. Cancelled slices and tasks are omitted, and obsolete tracked phase plan files are removed.
- `/gsd doctor` reports `.planning/` drift separately from `.gsd/` drift.

**Un-modeled docs** (phase `DISCUSSION-LOG.md`, `PATTERNS.md`, `REVIEWS.md`, `codebase/`, `research/`) are pass-through: gsd-pi detects edits to them but never overwrites them. They are gsd-core-owned.

**Limitation:** only the `flat-phases` layout is supported for round-trip projection. `multi-milestone` and `legacy-milestone-dir` layouts are not projected back.

## Conflicts: same entity edited in both

If both tools edit the *same* entity, gsd-pi does not choose a last writer: `/gsd sync` keeps the database authoritative, preserves the edited modeled file under `.gsd/quarantine/projections/`, and restores the database-backed projection. Re-apply the change through the matching gsd-pi planning or reopen tool — the preserved copy is there to read from, never a source gsd-pi will import. Git review remains the final safety net — that's why the "commit before switching" workflow matters.

## Troubleshooting

**`gsd doctor` says "no baseline"**: run `/gsd sync` once to establish the marker.

**`.gsd/.compat.json.bad-*` files appear**: gsd-pi quarantined a malformed marker and started fresh. Safe to delete the `.bad-*` file after reviewing it.

**`/gsd sync` reports drift every time you open the project**: this means gsd-pi's projection isn't idempotent — a real bug. The round-trip property test suite in CI catches most of these; report the fixture if you hit one in the wild.
