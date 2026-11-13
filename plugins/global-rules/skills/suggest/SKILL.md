---
name: suggest
description: Propose rules for the user's global ~/.claude/CLAUDE.md from their Claude Code sessions since the last run - corrections and refusals they repeated, lines Claude kept missing, and new global memories - and hand them to /global-rules:claude-md to word, propose and write. Drafts a first global CLAUDE.md when there is none. Use when the user asks to improve, update, tune or start their global CLAUDE.md from their history, habits or past corrections.
argument-hint: "[--since 30d | --since YYYY-MM-DD] [--include-tests]"
allowed-tools: Read, Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/digest.py), Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/digest.py *), Skill(skill:global-rules:claude-md)
---

# Suggest global CLAUDE.md rules from recent sessions

Find what the user's recent sessions show their global CLAUDE.md is missing or getting wrong, and hand it to `/global-rules:claude-md`, which reads Claude Code's guidance, words each rule, proposes it and writes only what the user picks. Each run reads only what happened since the last one, so a rule the user has already seen and turned down isn't proposed again from the same evidence.

This skill was invoked with: `$ARGUMENTS`

## 1. Build the digest

```
python3 ${CLAUDE_SKILL_DIR}/scripts/digest.py $ARGUMENTS
```

It reads the session transcripts since the last run (the last 30 days on a first run, or from `--since`), writes a digest, and prints where, how big it is, the window it read and the global CLAUDE.md's path. If python3 is missing, tell the user the skill needs Python 3.8 or later on the PATH, and stop.

Read the whole digest with the Read tool, in several Reads with offset and limit if it is long, and the global CLAUDE.md if it exists. The digest holds:

- **When each global CLAUDE.md line was put in place**, by line number, worked out from Claude's past edits to the file. `since` is when the line appeared in its current wording. `by` means it was there then and may be older. Times are UTC, as on the refusals and corrections.
- **Global memories** and **project memories** written or changed in the window, or every memory on a first run.
- **Refusals with a reason**: tool calls the user refused, with what they said. **Refusals without a reason**: the tool and its input.
- **Likely corrections**: messages that read like a correction, or came right after an interrupt or a refusal. "Claude before" is what Claude said or ran just before.
- **Said more than once**: the same message, in one project or several.

## 2. Find candidates

Claude Code's memory page says to add to CLAUDE.md when Claude makes the same mistake a second time, or the user types the same correction they typed last session. Propose a rule only on that kind of evidence, and only one that is about how the user works in any repo:

- **The same correction, refusal reason or instruction at least twice** in the window, in different sessions or projects. Read "Claude before" to see what Claude did, and propose the rule that would have stopped it.
- **Once, when a global CLAUDE.md line already covered it**: the line isn't working. Compare the correction's time with the line's time, and quote both.
- **A global memory in the digest** that holds in any repo. A project memory counts only when the same rule shows up in more than one project.

Leave out:

- Anything said or corrected once, unless a line already covered it.
- Facts about one project: its files, commands, stack or decisions.
- One-off task instructions, what Claude Code already does, and generic advice.
- Secrets, tokens and other people's details.

The digest holds everything this needs. Don't search the transcripts or look up file times with shell commands: they aren't in this skill's allowed tools, so each one stops for a permission prompt. If the digest can't settle a point, say so in the candidate.

If nothing meets the test, say the window had nothing new for the global CLAUDE.md, name the window, and stop. The next run starts after this one.

## 3. Hand the candidates to `/global-rules:claude-md`

Invoke the Skill tool with `global-rules:claude-md`, and pass the candidates as its arguments, one per line: what the rule should say, then its evidence (counts, projects, dates, and a short quote or two). With no global CLAUDE.md, say they are the start of a first one. That skill reads Claude Code's current guidance, places and words each candidate, proposes them, and writes only what the user picks, with a backup and a diff. Follow it from its step 1.

If the call is refused, list the candidates with their evidence, and ask the user to run `/global-rules:claude-md` with them.
