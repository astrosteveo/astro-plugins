# global-memory

Claude keeps project memories on its own, but never a memory that holds in every project. This plugin adds one, and a skill, `/global-memory:suggest`, that turns those memories and your session history into rules for your global `~/.claude/CLAUDE.md`.

Global memories are the quick path: Claude saves one the moment you correct it. The skill is the considered one: run it now and then to promote the memories that held up, with the rest of your history, into CLAUDE.md, and drop them from memory.

This plugin was `global-memory` and `global-rules`. The marketplace renames `global-rules` to `global-memory`, so an install of `global-rules` moves over on its own; `/global-rules:suggest` is now `/global-memory:suggest`.

## Global memories

Global memories live in `~/.claude/memory/` (or `$CLAUDE_CONFIG_DIR/memory/` when that is set), one file per fact, with a `MEMORY.md` index. Each file has the frontmatter Claude Code's own memories have, with the time it was written in `metadata.modified`. They are separate from your own `~/.claude/CLAUDE.md`.

- The index joins the system prompt's memory section at the start of each session. A memory saved mid-session reaches the next session, so the conversation's prompt cache is kept. A compaction reads the index again.
- When you correct Claude, or state a preference that holds in every repo, it saves a global memory. A fact about one project goes to that project's memory.
- It opens a full memory with `global_memory_read` when an index line looks relevant, and changes memories with `global_memory_write` and `global_memory_delete`. These tools keep the index in step.
- Writes and deletes are checked against your permission rules and mode: a rule or mode that denies refuses them. Where they would ask, this mod asks you itself with a plain Allow or Refuse question. It shows what will be stored (the title, the index line, the start of the body, and whether the save replaces a memory). It is not Claude Code's own permission dialog, so PreToolUse hooks and the auto-mode classifier do not see these calls, and it has no "always allow". Allow `mcp__global-memory__global_memory_write` in your settings if you would rather not be asked. Reads need no permission, and a deny rule does not stop them.
- Sessions in other projects share the folder. A lock directory (`~/.claude/memory/.lock`) makes their changes take turns, so no index line is lost. A lock older than 15 seconds is taken to be left by a dead session and broken by one session at a time. A session removes the lock only if it is still its own.
- The index holds at most 200 memories. At that point Claude must delete or fold one before it saves another. A title may be 80 characters, an index line's description 400 and a body 20,000, as every index line joins every session's system prompt.
- Each file is written to a temp file beside it and moved into place, so another session never reads a half-written index.

No shell is used, but these commands must be on the path: `mkdir`, `mv` and `rm`. Windows is not supported.

## Suggest rules for your global CLAUDE.md

`/global-memory:suggest` does for your global `~/.claude/CLAUDE.md` what `/init` does for a project's. It reads your Claude Code session history and proposes rules for the file. Each rule comes with the evidence behind it. Nothing is written until you pick which to apply. If you have no global CLAUDE.md, it drafts a first one.

```
/global-memory:suggest                    # all history
/global-memory:suggest --since 30d        # the last 30 days
/global-memory:suggest --since 2026-10-01
```

### What it reads

First, Claude Code's own guidance on CLAUDE.md files: [How Claude remembers your project](https://code.claude.com/docs/en/memory.md) and [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices.md), fetched on each run. It words every rule the way those pages recommend. It also checks the lines already in your file against them, so it can propose rewording or removing a line even when your history says nothing about it. A line that belongs in a skill, a `~/.claude/rules/` file, a hook or a deny rule gets a note saying so. It stays in your CLAUDE.md until that replacement exists. If the pages can't be fetched, it says so and carries on without them.

Then a script, `skills/suggest/scripts/digest.py`, goes through `~/.claude/projects/*/*.jsonl` and writes a Markdown digest to `~/.claude/global-memory/digest.md`. Claude reads that digest, not the raw transcripts. The digest holds:

- What you typed: tool output, skill text and reminders the harness injected are left out. A paste is replaced by its size.
- The tool calls you refused, with the reason you gave.
- Likely corrections: messages that read like one, or came right after an interrupt or refusal, each with Claude's last words before it.
- Messages you sent in more than one project, and tallies of short replies and commands.
- Your global memories and project memories.
- When each line of your global CLAUDE.md was put in place, worked out from the file's text before and after each of Claude's edits to it. Refusals and corrections carry a time of day too, so Claude can tell whether you corrected it after a line was already there without searching your transcripts. Times are UTC.

It leaves out subagent transcripts, scripted (SDK) sessions and sessions run under `/tmp`. Pass `--include-tests` to keep the last two. A resumed session repeats the records it was resumed from, so messages are counted once, by id.

### What it writes

Only the rules you approve, in your CLAUDE.md's own style. It backs the file up first to `CLAUDE.md.bak-<date>` and shows you the diff. It never edits project CLAUDE.md files or project memories. It names project-specific findings so you can add them yourself. When an approved rule came from a global memory, it offers to delete that memory with `global_memory_delete`, so the rule isn't loaded twice.

It needs `python3` (3.8 or later) on the PATH. It uses no packages beyond the standard library. It honours `CLAUDE_CONFIG_DIR`.

## Install

At the prompt of a terminal session:

```
/plugin install global-memory --marketplace astrosteveo/astro-plugins
```

## Test

```
claude plugin validate plugins/global-memory
claude plugin test plugins/global-memory
python3 -m unittest discover -s plugins/global-memory/tests
```
