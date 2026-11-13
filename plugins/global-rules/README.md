# global-rules

Keeps your CLAUDE.md files short, current and worded the way Claude Code's docs recommend.

```
/plugin install global-rules --marketplace astrosteveo/astro-plugins
```

## Change an instruction file

```
/global-rules:claude-md                          # check your global CLAUDE.md against the guidance
/global-rules:claude-md always use uv for Python # add a rule
/global-rules:claude-md ./CLAUDE.md              # check a project's file
```

Or ask in plain words, such as "add to my CLAUDE.md that I use zsh". It covers the global `~/.claude/CLAUDE.md` and `~/.claude/rules/`, and a project's CLAUDE.md, CLAUDE.local.md, AGENTS.md and `.claude/rules/`.

1. `scripts/guidance.py` prints the sections of [How Claude remembers your project](https://code.claude.com/docs/en/memory.md) and [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices.md) about writing these files, fetched at most once a day, and lists the instruction files you have.
2. Each line goes where the docs say it belongs: the global file, a project's file, a rules file with `paths:`, a skill, a hook or deny rule, or nowhere. It writes only instruction files; the rest come back as notes.
3. Each line is worded as the docs say, in the file's own style, and checked against the lines already there.
4. It proposes a numbered list and writes what you pick (`/global-rules:claude-md apply 1, 3`), with a backup in `~/.claude/global-rules/backups/` and a diff. An exact line you asked for, which the guidance leaves as it is, it writes straight away.

It never edits `settings.json`. For a project with no CLAUDE.md it offers `/init`, and it leaves conflicts across files to `/doctor prompt-audit`.

### Edits wait for the guidance

Claude Code's docs say Claude treats CLAUDE.md and skills as context it may skip, and that a hook is how to make something hold every time. So a hook refuses Edit and Write on an instruction file until `/global-rules:claude-md` has been loaded in the conversation, and adds a line to `/init` telling it to load the skill first. If the hook's check fails, the edit goes ahead. Writes through the shell aren't checked.

## Suggest rules from this session

```
/global-rules:suggest
```

Run it at the end of a session where you had to correct Claude. It looks back over the session for:

- a line your global CLAUDE.md already has, which Claude broke, so the line isn't working;
- a correction a memory already records, which makes this the second time;
- something you said should hold everywhere.

A correction given once stays in memory: Claude Code's memory and the global-memory plugin keep those between sessions. What it finds goes to `/global-rules:claude-md` to word, propose and write. If nothing qualifies, it says so.

## Test

```
claude plugin validate plugins/global-rules
python3 -m unittest discover -s plugins/global-rules/tests
claude plugin test plugins/global-rules
```
