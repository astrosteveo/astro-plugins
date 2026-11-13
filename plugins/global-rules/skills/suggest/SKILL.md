---
name: suggest
description: Propose additions and changes to the user's global ~/.claude/CLAUDE.md from their Claude Code session history (what they typed, their corrections, the tool calls they refused, their global and project memories), checked against Claude Code's current CLAUDE.md guidance, and write only what they approve. Drafts a first CLAUDE.md when there is none. Use when the user asks to improve, update, tune, audit or start their global CLAUDE.md from their history, habits or past corrections.
argument-hint: "[--since 30d | --since YYYY-MM-DD] [--include-tests] | apply <the items you picked>"
allowed-tools: Read, Edit, Write, WebFetch(domain:code.claude.com), Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/digest.py), Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/digest.py *), Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/claude_md.py *)
---

# Suggest global CLAUDE.md content from session history

Turn what the user said across past sessions into a short list of rules for their global CLAUDE.md, written the way Claude Code's docs say CLAUDE.md files work best. Show the list, then write only the rules they pick. The global CLAUDE.md is loaded into every session in every project, so each line has to earn its place.

This skill was invoked with: `$ARGUMENTS`

If those arguments start with `apply`, the user has picked items from a list this skill proposed earlier in this conversation, or approved its first draft. Skip steps 1 to 4: don't fetch the guidance or build the digest again. Take what follows `apply` as the user's answer, rewordings included, and go to step 5 with it. If there is no such list or draft earlier in the conversation, say so and stop.

## 1. Read Claude Code's CLAUDE.md guidance

Fetch both pages with WebFetch, in the same turn as the digest in step 2. Ask each for what it says about writing CLAUDE.md files, quoted as written:

- [How Claude remembers your project](https://code.claude.com/docs/en/memory.md): how to write instructions Claude follows, how long a file should be, and when a line belongs in a skill, a `~/.claude/rules/` file or a hook instead.
- [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices.md): what to leave out, and which instructions have to hold every time and so need a hook or a permission deny rule.

The pages change as Claude Code does. Judge what makes a good line by what they say now, not by what you remember. They are written mostly for project files, but their advice on writing instructions holds for the global file too. Where they disagree with this skill, follow the pages and say what differed.

If a page fails to load, look up its new address in [the docs index](https://code.claude.com/docs/llms.txt). Fetch only from code.claude.com. If the page is gone or has moved elsewhere, tell the user and go on with the rules in this skill.

## 2. Build the digest

```
python3 ${CLAUDE_SKILL_DIR}/scripts/digest.py $ARGUMENTS
```

It prints where it wrote the digest, how big the digest is, and the path of the global CLAUDE.md and whether it exists. If python3 is missing, tell the user the skill needs Python 3.8 or later on the PATH, and stop.

Read the CLAUDE.md at that path if it exists, and the settings.json in the same folder, with the Read tool: its hooks and permission deny rules show what is already enforced. Then read the whole digest, in several Reads with offset and limit if it is long. It holds:

- **When each global CLAUDE.md line was put in place**, by line number, worked out from Claude's past edits to the file. `since` is when the line appeared in its current wording. `by` means it was there then and may be older. Times are UTC, as on the refusals and corrections.
- **Global memories** and **project memories**: rules Claude already saved, with their type.
- **Refusals with a reason**: tool calls the user refused, with what they said. These are rules in the user's own words.
- **Refusals without a reason**: the tool and its input.
- **Likely corrections**: messages that read like a correction, or came right after an interrupt or a refusal. "Claude before" is what Claude said or ran just before. It shows what the user was correcting.
- **Said in more than one project**, **other messages by project**, and tallies of **short replies and commands**.

## 3. Find candidates

A rule belongs in the global CLAUDE.md only if it is about how the user works, and holds in any repo. Look for:

- Something the user said in more than one project or several sessions, stated as general ("always", "never", "from now on", "in every repo"), or that a global memory already records.
- Strong reactions: capitals, swearing, "how many times". They mark a failure that keeps happening. Read "Claude before" to see what Claude did, and write the rule that would have prevented it.
- The same tool refused again and again. Read the user's next message for why.
- Habits in the tallies, such as "merge it" after every pull request. Propose a rule from a habit only when it clearly implies an instruction.

Leave out:

- Facts about one project: its files, commands, stack or design decisions. A rule from a project memory is global only if it shows up across projects.
- One-off task instructions, such as "add a settings screen".
- What Claude Code already does, and generic advice such as "write clean code".
- Anything else the guidance from step 1 says to leave out.
- Secrets, tokens and other people's details.

Word and place each candidate as the guidance says:

- Make it specific enough to check, in plain words. Don't add IMPORTANT or capitals for emphasis.
- A multi-step procedure belongs in a skill. A line that only matters for some files, such as one language's, belongs in a `~/.claude/rules/` file. An instruction that has to hold every time belongs in a hook or a permission deny rule. Don't put these in CLAUDE.md. Note them for the end of the list.

Check each candidate against the current CLAUDE.md. To tell whether a correction came after a line was in place, compare the correction's time with the line's time in the digest. The digest holds everything this check needs. Don't search the transcripts or look up file times with shell commands: they aren't in this skill's allowed tools, so each one stops for a permission prompt. If the digest can't settle it, say so in the item.

- **Already there, and nothing in the history shows Claude breaking it**: skip it.
- **Already there, but the user corrected Claude on it after the rule was in place**: the rule is not working. Propose sharper wording. Quote the old line and the correction. If it has to hold every time, keep the line and note the hook or deny rule that would enforce it.
- **Contradicted by later history**: propose a change. Newer evidence wins. Quote both, with dates.
- **Reversed by the user**: propose removing the line.

Then check the lines already in the file against the guidance, even with nothing in the history behind them. Propose rewording a vague or emphasized line, and removing one that tells Claude what it does anyway. For a line that belongs in a skill, a rules file, a hook or a deny rule, add a note. Propose removing that line only once its replacement exists, such as a matching hook or deny rule in settings.json. Until then the line is all that carries the instruction. If the file is longer than the guidance recommends, propose cuts.

Check two things in settings.json too, and note what you find:

- If the file sets commit or pull request rules, Claude Code's own git instructions compete with them. `includeGitInstructions: false` turns those off, and the git status snapshot with them; `attribution` sets the text Claude Code adds to commits and pull requests. Note the setting that would stop the conflict, unless it is already set.
- A hook that enforces only a preference, not a rule that can't have exceptions: the guidance says to delete such a hook and let Claude decide.

## 4. Propose

Show a numbered list of at most 12 items: first the ones the history backs, strongest evidence first, then the ones from the guidance alone. For each item give:

- **Add**, **Change** or **Remove**, and the section.
- The exact text, in the file's own voice: the same heading and bullet style and the same short, direct lines. Give the why only when it is not obvious.
- One line of evidence: counts, projects, dates, and a short quote or two. For an item that comes from the guidance alone, name the page and quote its exact words.

Put a new rule under an existing heading. Add a heading only when nothing fits.

**When there is no CLAUDE.md**, draft a whole first file instead of a list. Keep it under 40 lines. That is stricter than the pages ask on purpose, not a disagreement with them. Include only sections the history gives evidence for, such as: about the user (OS, shell, stacks and tools seen in their projects), how to work with them, replies, code, verification and git. Show the full draft, then a short list of the evidence behind each section.

End with notes, one line each, that this skill does not write:

- For each project where something project-specific stood out, what belongs in that project's CLAUDE.md.
- For each line that belongs in a skill, a `~/.claude/rules/` file, a hook or a deny rule, what it would do, hold, run or block.
- Each settings.json change from the check above: the git setting to set, or the hook that enforces only a preference and could go.

Then ask which to apply. Ask in plain text, not with AskUserQuestion: a list holds every item and lets the user reword one in the same reply. Tell the user to answer with the command `/global-rules:suggest apply 1, 3`: numbers, "all", or an item reworded ("apply 2, but say …"). For a first draft, they answer `/global-rules:suggest apply` to approve it, or ask for changes. Write nothing until the user answers.

This skill's allowed tools hold only for the turn that invokes it, and the user's answer starts a new turn. The command invokes the skill again, so the backup, the edits and the diff run without a permission prompt. If the user answers with items in plain words instead, invoke this skill again yourself before you write anything: the Skill tool with `global-rules:suggest` and `apply` followed by their whole answer. That call may need the user's permission. If it is refused, ask them to type the command, and write nothing. An answer of "none", or one that asks for changes to the list or draft, writes nothing and needs no new invocation.

## 5. Write

1. Back up the file: `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/claude_md.py backup <path>`. It prints the backup's path, or says there is no file yet. Use the script, not `cp`: Claude Code asks before `cp` or `diff` touches a path outside the session's working folders, which the global CLAUDE.md always is. If the backup fails, stop and write nothing. Never make a backup any other way, such as with Write from an earlier read.
2. Apply each approved item with Edit, keeping the file's order and style. For a first CLAUDE.md, use Write.
3. Show what changed: `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/claude_md.py diff <backup> <path>`, or the new file in full. Give the backup's path.
4. If an approved rule came from a global memory, say so. When the global-memory plugin's `global_memory_delete` tool is available, offer to delete that memory, so the rule is not loaded twice. Delete it with that tool, never with `rm`: the tool also clears its line from the `MEMORY.md` index, which every session loads. Without the tool, the global-memory plugin is not installed: name the memory's file and its line in `MEMORY.md`, so the user can remove both.
5. Suggest the user run `/doctor prompt-audit`. It checks the file against their rules, skills, commands, subagents and output styles for instructions that are outdated or contradict each other, which this skill does not read.
