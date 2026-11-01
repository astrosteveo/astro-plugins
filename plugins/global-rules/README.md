# global-rules

`/global-rules:suggest` reads your Claude Code session history and proposes rules for your global `~/.claude/CLAUDE.md`. Each rule comes with the evidence behind it. Nothing is written until you pick which to apply. If you have no global CLAUDE.md, it drafts a first one.

## What it reads

A script, `skills/suggest/scripts/digest.py`, goes through `~/.claude/projects/*/*.jsonl` and writes a Markdown digest to `~/.claude/global-rules/digest.md`. Claude reads that digest, not the raw transcripts. The digest holds:

- What you typed: tool output, skill text and reminders the harness injected are left out. A paste is replaced by its size.
- The tool calls you refused, with the reason you gave.
- Likely corrections: messages that read like one, or came right after an interrupt or refusal, each with Claude's last words before it.
- Messages you sent in more than one project, and tallies of short replies and commands.
- Your global memories (`~/.claude/memory`) and project memories.

It leaves out subagent transcripts, scripted (SDK) sessions and sessions run under `/tmp`. Pass `--include-tests` to keep the last two. A resumed session repeats the records it was resumed from, so messages are counted once, by id.

```
/global-rules:suggest                    # all history
/global-rules:suggest --since 30d        # the last 30 days
/global-rules:suggest --since 2026-10-01
```

## What it writes

Only the rules you approve, in your CLAUDE.md's own style. It backs the file up first to `CLAUDE.md.bak-<date>` and shows you the diff. It never edits project CLAUDE.md files or project memories. It names project-specific findings so you can add them yourself. When an approved rule came from a global memory, it offers to delete that memory, so the rule isn't loaded twice.

Needs `python3` (3.8 or later) on the PATH. It uses no packages beyond the standard library. It honours `CLAUDE_CONFIG_DIR`.

## Install

```
/plugin install global-rules --marketplace astrosteveo/astro-plugins
```

## Test

```
claude plugin validate plugins/global-rules
python3 -m unittest discover -s plugins/global-rules/tests
```
