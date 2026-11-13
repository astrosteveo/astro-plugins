---
name: suggest
description: Look back over this session for rules the user's global ~/.claude/CLAUDE.md should gain or change - a line Claude broke, a correction a memory already records, something the user said should hold everywhere - and hand them to /global-rules:claude-md to word, propose and write. Use when the user asks what this session should add to their global CLAUDE.md, or to turn their corrections into rules for every project.
allowed-tools: Skill(skill:global-rules:claude-md)
---

# Suggest global CLAUDE.md rules from this session

Memory keeps a correction the first time Claude gets it. The global CLAUDE.md is for what has to hold in every project, and Claude Code's memory page says a line belongs there once Claude makes the same mistake a second time. Look back over this conversation for those, and hand them on.

## 1. Find candidates

What you need is in context: this conversation, the global CLAUDE.md, and the memory indexes loaded when it started. Read a memory in full when its index line looks related.

Propose a rule when something in this session:

- **Broke a line the global CLAUDE.md already has**: the user corrected Claude for what the line already says. The line isn't working. Quote it and the correction.
- **Repeats a correction a memory already records**: this is the second time. Name the memory.
- **Was said to hold everywhere**, such as "always", "never", "from now on" or "in every project".

Each must be about how the user works in any repo. Leave out:

- A correction given once, with no memory of it before: memory is the place for that.
- Facts about this project, one-off task instructions, and what Claude Code does anyway.
- Secrets and other people's details.

If nothing qualifies, say so in one line and stop.

## 2. Hand them to /global-rules:claude-md

Invoke the Skill tool with `global-rules:claude-md`, passing the candidates as its arguments, one per line: what the rule should say, then its evidence (the user's words from this session, and the line or memory it repeats). That skill reads Claude Code's guidance, words each one, proposes them and writes only what the user picks. Follow it from its step 1.

If the call is refused, list the candidates with their evidence, and ask the user to run `/global-rules:claude-md` with them.
