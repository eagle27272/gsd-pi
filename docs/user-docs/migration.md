# Migration from v1

If you have projects with `.planning` directories from Git Ship Done v1 (now continued by the community as [gsd-core](https://github.com/open-gsd/gsd-core)), you can migrate them to gsd-pi's `.gsd` format.

## Post-Migration

After migrating, verify the output with:

```
/gsd doctor
```

This checks database and projection integrity and flags any structural issues. Use `/gsd inspect` when you need database diagnostics.

If an existing project has legacy markdown artifacts that you explicitly want to import into a missing or damaged database, start GSD once so the database opens, then run:

```
/gsd recover
# Then re-run with the exact --preview=<sha256> printed by the command.
```

`/gsd recover` fingerprints the legacy source and current database and prints an exact Preview hash. Re-run it with `--preview=<sha256>` to create and independently verify a retained backup, apply that unchanged preview through one atomic Import Application, and assess the safe next action. It updates only modeled preview targets; database rows absent from markdown are not cleared. The command prints the Application ID and retained backup path.

If assessment recommends restoring the pre-import database, rerun the command with the exact `--application`, `--restore`, and evidence-bound `--consent` values it printed. Restore is available only while that Import Application remains the canonical operation head. Any later canonical write or Authority Epoch cutover closes the restore window permanently; use the printed `--forward-repair` route instead. Forward Repair preserves later accepted work and asks for explicit `--choice` evidence only when imported and later canonical changes genuinely overlap.

Normal runtime never derives authority from markdown implicitly. Use `/gsd rebuild markdown` for ordinary database-to-markdown realignment.
