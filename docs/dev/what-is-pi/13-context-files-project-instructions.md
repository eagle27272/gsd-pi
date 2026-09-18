# Context Files — Project Instructions

Pi loads instruction files automatically at startup:

### AGENTS.md (or CLAUDE.md)

Pi loads, in order:
1. `~/.claude/CLAUDE.md` — Claude Code's user memory file. Set `CLAUDE_CONFIG_DIR` to relocate it.
2. `AGENTS.md` or `CLAUDE.md` from every parent directory from the filesystem root down to cwd, including cwd itself. Within a directory, `AGENTS.md` wins.

All matching files are concatenated and included in the system prompt. Use these for project conventions, common commands, architectural notes.

### @-references

A context file can pull in another file with `@path`, the same way Claude Code does:

```markdown
@RTK.md
@~/notes/style-guide.md
@../shared/conventions.md
```

Relative paths resolve against the directory of the file containing the reference. Each imported file joins the system prompt as its own labelled section, directly after the file that referenced it. Imports nest up to five levels deep; cycles and repeats load once. References inside fenced code blocks or inline code spans are left alone, as is any reference that does not point at a readable file.

### System Prompt Override

Replace the default system prompt entirely:
- `.gsd/SYSTEM.md` (project)
- `~/.gsd/agent/SYSTEM.md` (global)

Append to it instead:
- `.gsd/APPEND_SYSTEM.md` (project)
- `~/.gsd/agent/APPEND_SYSTEM.md` (global)

### File Arguments

Include files directly in prompts from the CLI:

```bash
pi @prompt.md "Answer this"
pi -p @screenshot.png "What's in this image?"
pi @code.ts @test.ts "Review these files"
```

---
