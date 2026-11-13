# global-rules

Writes and maintains Claude Code's instruction files, so they stay short, current and worded the way Claude Code's docs recommend. Two skills:

- `/global-rules:claude-md` makes any change to a CLAUDE.md, global or a project's, and to rules files and AGENTS.md. It reads Claude Code's current guidance before it proposes anything, and Claude loads it whenever one of these files comes up, so "add this to my CLAUDE.md" goes through it too.
- `/global-rules:suggest` does for your global `~/.claude/CLAUDE.md` what `/init` does for a project's. It reads your Claude Code session history and proposes rules for the file, each with the evidence behind it. If you have no global CLAUDE.md, it drafts a first one.

Neither writes anything until you pick what to apply.

This plugin started as `global-rules`, was folded into global-memory, where its skill was `/global-memory:suggest`, and is its own plugin again. global-memory now keeps only the global memories. Install this one to keep the skill. With both installed, the skill reads your global memories as evidence and offers to delete one once its rule is in CLAUDE.md.

```
/global-rules:suggest                    # all history
/global-rules:suggest --since 30d        # the last 30 days
/global-rules:suggest --since 2026-10-01
```

## Change an instruction file

```
/global-rules:claude-md                          # check your global CLAUDE.md against the guidance
/global-rules:claude-md always use uv for Python # add a rule
/global-rules:claude-md ./CLAUDE.md              # check a project's file
```

Or ask in plain words, such as "add to my CLAUDE.md that I use zsh": the skill's description has Claude load it before it proposes or makes any change to one of these files.

1. It runs `scripts/guidance.py`, which prints the sections of [How Claude remembers your project](https://code.claude.com/docs/en/memory.md) and [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices.md) about writing these files, about a quarter of the two pages. It fetches them at most once a day and keeps them in `~/.claude/global-rules/guidance.md`. Offline, it uses the kept copy and says how old it is. A section the pages no longer have is named, so Claude reads the page instead. Then it lists the instruction files that exist, globally and in the repo you're in.
2. It puts each line where the guidance says it belongs: the global file for how you work anywhere, a project's file for one project, a rules file with `paths:` for some files only, a skill for a procedure, a hook or deny rule for what must hold every time, or nowhere for what Claude does anyway. It writes only instruction files. Skills, hooks and deny rules come back as notes.
3. It words each line as the docs say (specific enough to check, plain words, no IMPORTANT) in the file's own style, and checks it against the lines already there.
4. It proposes a numbered list and writes what you pick, `/global-rules:claude-md apply 1, 3`, with a backup and a diff.

For a project with no CLAUDE.md, it offers `/init`. It leaves conflicts across files to `/doctor prompt-audit`.

## Suggest rules from your history

### What it reads

First, Claude Code's own guidance on CLAUDE.md files: [How Claude remembers your project](https://code.claude.com/docs/en/memory.md) and [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices.md), fetched on each run. It words every rule the way those pages recommend. It also checks the lines already in your file against them, so it can propose rewording or removing a line even when your history says nothing about it. A line that belongs in a skill, a `~/.claude/rules/` file, a hook or a deny rule gets a note saying so. It stays in your CLAUDE.md until that replacement exists. If the pages can't be fetched, it says so and carries on without them.

It also reads your `settings.json`. If your CLAUDE.md sets commit or pull request rules, it checks `includeGitInstructions` and `attribution`, as Claude Code's own git instructions compete with those rules. It looks for hooks that enforce only a preference, which the pages say to delete.

Then a script, `skills/suggest/scripts/digest.py`, goes through `~/.claude/projects/*/*.jsonl` and writes a Markdown digest to `~/.claude/global-rules/digest.md`. Claude reads that digest, not the raw transcripts. The digest holds:

- What you typed: tool output, skill text and reminders the harness injected are left out. A paste is replaced by its size.
- The tool calls you refused, with the reason you gave.
- Likely corrections: messages that read like one, or came right after an interrupt or refusal, each with Claude's last words before it.
- Messages you sent in more than one project, and tallies of short replies and commands.
- Your global memories (from `~/.claude/memory`, which the global-memory plugin keeps) and project memories.
- When each line of your global CLAUDE.md was put in place, worked out from the file's text before and after each of Claude's edits to it. Refusals and corrections carry a time of day too, so Claude can tell whether you corrected it after a line was already there without searching your transcripts. Times are UTC.

It leaves out subagent transcripts, scripted (SDK) sessions and sessions run under `/tmp`. Pass `--include-tests` to keep the last two. A resumed session repeats the records it was resumed from, so messages are counted once, by id.

### What it writes

Only the rules you approve, in your CLAUDE.md's own style. You pick items by answering with `/global-rules:suggest apply 1, 3`, which runs the skill again so its pre-approved tools hold for the turn that writes. It backs the file up first to `~/.claude/global-rules/backups/`, named for the file's path and the date (with a `-2` suffix if that exists), and shows you the diff. The backup and the diff come from a small script, `scripts/claude_md.py`, because Claude Code asks before `cp` or `diff` touches a file outside the session's working folders. It never edits project CLAUDE.md files or project memories. It names project-specific findings so you can add them yourself. When an approved rule came from a global memory, it offers to delete that memory with global-memory's `global_memory_delete` tool, so the rule isn't loaded twice. Without that plugin, it names the memory's file and index line for you to remove.

It never edits `settings.json`: the git setting to change and the hooks that could go come back as notes. It ends by suggesting `/doctor prompt-audit`, which checks your rules, skills, commands, subagents and output styles against the file for conflicts.

It needs `python3` (3.8 or later) on the PATH. It uses no packages beyond the standard library. It honours `CLAUDE_CONFIG_DIR`.

## Install

At the prompt of a terminal session:

```
/plugin install global-rules --marketplace astrosteveo/astro-plugins
```

## Test

```
claude plugin validate plugins/global-rules
python3 -m unittest discover -s plugins/global-rules/tests
```

`tests/test_digest.py` reads its sample memory file from `plugins/global-memory/tests/memory-file.fixture.ts`, the sample global-memory's own test checks its writer against, so a change to the memory file format breaks one of the two.
