---
name: suggest
description: Propose additions and changes to the user's global ~/.claude/CLAUDE.md from their Claude Code session history (what they typed, their corrections, the tool calls they refused, their global and project memories), and write only what they approve. Drafts a first CLAUDE.md when there is none. Use when the user asks to improve, update, tune, audit or start their global CLAUDE.md from their history, habits or past corrections.
argument-hint: "[--since 30d | --since YYYY-MM-DD] [--include-tests]"
allowed-tools: Read, Edit, Write, Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/digest.py), Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/digest.py *), Bash(cp *), Bash(diff *)
---

# Suggest global CLAUDE.md content from session history

Turn what the user said across past sessions into a short list of rules for their global CLAUDE.md. Show the list, then write only the rules they pick. The global CLAUDE.md is loaded into every session in every project, so each line has to earn its place.

## 1. Build the digest

```
python3 ${CLAUDE_SKILL_DIR}/scripts/digest.py $ARGUMENTS
```

It prints where it wrote the digest, how big the digest is, and the path of the global CLAUDE.md and whether it exists. If python3 is missing, tell the user the skill needs Python 3.8 or later on the PATH, and stop.

Read the CLAUDE.md at that path if it exists. Then read the whole digest, in several Reads with offset and limit if it is long. It holds:

- **Global memories** and **project memories**: rules Claude already saved, with their type.
- **Refusals with a reason**: tool calls the user refused, with what they said. These are rules in the user's own words.
- **Refusals without a reason**: the tool and its input.
- **Likely corrections**: messages that read like a correction, or came right after an interrupt or a refusal. "Claude before" is what Claude said or ran just before. It shows what the user was correcting.
- **Said in more than one project**, **other messages by project**, and tallies of **short replies and commands**.

## 2. Find candidates

A rule belongs in the global CLAUDE.md only if it is about how the user works, and holds in any repo. Look for:

- Something the user said in more than one project or several sessions, stated as general ("always", "never", "from now on", "in every repo"), or that a global memory already records.
- Strong reactions: capitals, swearing, "how many times". They mark a failure that keeps happening. Read "Claude before" to see what Claude did, and write the rule that would have prevented it.
- The same tool refused again and again. Read the user's next message for why.
- Habits in the tallies, such as "merge it" after every pull request. Propose a rule from a habit only when it clearly implies an instruction.

Leave out:

- Facts about one project: its files, commands, stack or design decisions. A rule from a project memory is global only if it shows up across projects.
- One-off task instructions, such as "add a settings screen".
- What Claude Code already does, and generic advice such as "write clean code".
- Secrets, tokens and other people's details.

Check each candidate against the current CLAUDE.md:

- **Already there, and nothing in the history shows Claude breaking it**: skip it.
- **Already there, but the user corrected Claude on it after the rule was in place**: the rule is not working. Propose sharper wording. Quote the old line and the correction.
- **Contradicted by later history**: propose a change. Newer evidence wins. Quote both, with dates.
- **Reversed by the user**: propose removing the line.

## 3. Propose

Show a numbered list, strongest evidence first, of at most 12 items. For each item give:

- **Add**, **Change** or **Remove**, and the section.
- The exact text, in the file's own voice: the same heading and bullet style and the same short, direct lines. Give the why only when it is not obvious.
- One line of evidence: counts, projects, dates, and a short quote or two.

Put a new rule under an existing heading. Add a heading only when nothing fits.

**When there is no CLAUDE.md**, draft a whole first file instead of a list. Keep it under 40 lines. Include only sections the history gives evidence for, such as: about the user (OS, shell, stacks and tools seen in their projects), how to work with them, replies, code, verification and git. Show the full draft, then a short list of the evidence behind each section.

If something project-specific stood out, end with one line per project on what belongs in that project's CLAUDE.md. Do not write those.

Then ask which to apply. The user replies with numbers ("1, 3, 5"), "all" or "none", and may reword an item ("2, but say …"). For a first draft, the user approves it or asks for changes. Ask in plain text, not with AskUserQuestion: a list holds every item and lets the user reword one in the same reply. Write nothing until the user answers.

## 4. Write

1. If the file exists, copy it first to `<path>.bak-<today as YYYY-MM-DD>`, using `cp`.
2. Apply each approved item with Edit, keeping the file's order and style. For a first CLAUDE.md, use Write.
3. Show what changed: `diff -u <backup> <path>`, or the new file in full. Give the backup's path.
4. If an approved rule came from a global memory, say so. Offer to delete that memory, so the rule is not loaded twice.
