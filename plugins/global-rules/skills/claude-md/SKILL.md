---
name: claude-md
description: Use before you propose, draft, recommend or make any change to a Claude Code instruction file - the global ~/.claude/CLAUDE.md or ~/.claude/rules/, or a project's CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md, AGENTS.md or .claude/rules/ - including adding a line the user asks for, starting a global CLAUDE.md, or checking a file. Loads Claude Code's current guidance on writing these files, puts each line where it belongs (a CLAUDE.md, a rules file, a skill, a hook or deny rule, or nowhere), words it the way the docs recommend, and writes only what the user approves, with a backup and a diff.
argument-hint: "[a change to make, or a file to check] | apply <the items you picked>"
allowed-tools: Read, Edit, Write, WebFetch(domain:code.claude.com), Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/guidance.py), Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/guidance.py *), Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/claude_md.py *)
---

# Write Claude Code's instruction files

CLAUDE.md, CLAUDE.local.md, AGENTS.md and rules files load into Claude's context: the global ones in every session in every project, a project's in every session there. Every line takes a little of Claude's attention on every task, so each line has to earn its place and be worded so Claude follows it. This skill reads Claude Code's current guidance first, then places and words each change, and writes only what the user approves.

This skill was invoked with: `$ARGUMENTS`

If the arguments start with `apply`, the user has picked items from a list this skill proposed earlier in this conversation, or approved its draft. Go to step 5 with what follows `apply` as their answer, rewordings included. If there is no such list or draft earlier in the conversation, say so and stop.

## 1. Read the guidance and the files

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/guidance.py
```

It prints the sections of Claude Code's memory and best-practices pages on writing these files, fetched at most once a day, then lists the instruction files that exist, globally and in the repo the session runs in. Read all of it before you propose or write anything. Judge each line by what the docs say now, not by what you remember, and where they disagree with this skill, follow the docs and say what differed. If it names a page or a section it couldn't read, read that page with WebFetch. Look up a page that moved in [the docs index](https://code.claude.com/docs/llms.txt), and fetch only from code.claude.com.

Then read, with the Read tool, the files the request touches, the settings.json beside them (its hooks and permission deny rules show what's already enforced), and the global memory index if the list has one.

## 2. Pick what to do

- **The arguments or the conversation name a change**, such as "always use uv" or "drop the line about tabs": place and word it (step 3).
- **No global CLAUDE.md yet, and the user wants one**: draft it. Ask what Claude can't see on its own, such as how they work, their tools, and their rules for replies, code, checks and git. Ask in plain text, not with AskUserQuestion, at most four questions at a time, each with a suggestion from their global memories and settings so they can answer with a yes. Hold the draft to what they said or confirmed, and keep it short: it loads into every session.
- **A project with no CLAUDE.md**: offer `/init`, which starts one from the codebase, instead of drafting one here.
- **No request**: check a file against the guidance (step 3): the global CLAUDE.md, or the project file the user names.

## 3. Place and word each change

Put each line where the guidance says it belongs:

| What it is | Where it goes |
| --- | --- |
| How the user works, in any repo | the global CLAUDE.md |
| What one project needs | that project's CLAUDE.md, or its CLAUDE.local.md if it's only the user's |
| A rule for some files only, such as one language's | a rules file with `paths:`, in `~/.claude/rules/` or the project's `.claude/rules/` |
| A procedure with several steps | a skill |
| Something that must hold every time, with no exceptions | a hook or a permission deny rule |
| What Claude does anyway, can read from the code, or generic advice | nowhere |

This skill writes instruction files only. A skill, hook or deny rule comes back as a note saying what it would do: don't edit settings.json. Leave out secrets and other people's details.

Word each line the way the guidance says: specific enough to check, in plain words, with no IMPORTANT or capitals for emphasis. Match the file's own voice: its headings, its bullet style, its short direct lines. Put a line under an existing heading, and add a heading only when nothing fits. Give the why only when it isn't obvious.

Check each change against the files that already load:

- **Already there**: skip it, unless the user says Claude keeps missing it. Then propose sharper wording, or a hook if it can't have exceptions.
- **Contradicts a line**: propose one change that settles it, quoting both.
- **Repeats a global memory**: say so, so the memory can go once the line is in (step 5).

When checking a file, go through each line. Reword a vague or emphasized one. Remove one that tells Claude what it does anyway or can read from the code. Note one that belongs elsewhere, and propose removing it only once its replacement exists: until then the line is all that carries the instruction. If the file is longer than the guidance recommends, propose cuts. In settings.json, note a commit or pull request rule in the file that competes with Claude Code's own (`includeGitInstructions` turns those off, and `attribution` sets the text Claude Code adds), and a hook that enforces only a preference. Leave conflicts across files and references to things that no longer exist to `/doctor prompt-audit`.

## 4. Propose

Show a numbered list of at most 12 items. For each, give:

- **Add**, **Change** or **Remove**, with the file and the section.
- The exact text.
- One line of why: what the user said, or, for an item that comes from the guidance alone, the guidance's own words.

For a first file, show the whole draft instead. End with notes, one line each, for what this skill doesn't write: a skill, a hook, a deny rule or a settings change.

Then ask which to apply, in plain text, not with AskUserQuestion. Tell the user to answer with the command `/global-rules:claude-md apply 1, 3`: numbers, "all", or an item reworded ("apply 2, but say …"). For a draft, they answer `/global-rules:claude-md apply`, or ask for changes. Write nothing until the user answers.

This skill's allowed tools hold only for the turn that invokes it, and the user's answer starts a new turn. The command invokes the skill again, so the backup, the edits and the diff run without a permission prompt. If the user answers in plain words instead, invoke this skill yourself before you write anything: the Skill tool with `global-rules:claude-md` and `apply` followed by their whole answer. If that call is refused, ask them to type the command, and write nothing. An answer of "none", or one that asks for changes, writes nothing.

## 5. Write

1. Back up each file you'll change: `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/claude_md.py backup PATH`. It prints the backup's path, under `~/.claude/global-rules/backups/`, or says there is no file yet. Use the script, not `cp`: Claude Code asks before `cp` or `diff` touches a path outside the session's working folders, which the global files always are. If a backup fails, stop and write nothing.
2. Apply each approved item with Edit, keeping the file's order and style. Make a new file with Write.
3. Show what changed: `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/claude_md.py diff BACKUP PATH`, or a new file in full. Give each backup's path.
4. If an approved line repeats a global memory, say so. When the global-memory plugin's `global_memory_delete` tool is available, offer to delete that memory, so it isn't loaded twice. Delete it with that tool, never with `rm`: the tool also clears its line from the `MEMORY.md` index that every session loads. Without the tool, the global-memory plugin is not installed: name the memory's file and its line in `MEMORY.md`, so the user can remove both.
5. Suggest `/doctor prompt-audit`, which checks the instruction files, skills, subagents and output styles together for lines that are outdated or contradict each other.
