# global-memory

Claude keeps project memories on its own, but never a memory that holds in every project. This plugin adds one.

Global memories are the quick path: Claude saves one the moment you correct it. The [global-rules](../global-rules) plugin is the considered one: run its `/global-rules:suggest` now and then to promote the memories that held up, with the rest of your history, into your global `~/.claude/CLAUDE.md`, and drop them from memory.

That skill was `/global-memory:suggest`, part of this plugin, and moved to global-rules in 0.4.0. Install it to keep the skill: `/plugin install global-rules --marketplace astrosteveo/astro-plugins`.

## Global memories

Global memories live in `~/.claude/memory/` (or `$CLAUDE_CONFIG_DIR/memory/` when that is set), one file per fact, with a `MEMORY.md` index. Each file has the frontmatter Claude Code's own memories have, with the time it was written in `metadata.modified`. They are separate from your own `~/.claude/CLAUDE.md`.

- The index reaches Claude the way Claude Code's own `MEMORY.md` does: as an auto-memory file beside your CLAUDE.md files in the context of a conversation's first message. It is loaded when a conversation starts and again after a compaction, so a memory saved mid-session reaches the next session and the conversation's prompt cache is kept. The system prompt only says how to use the global memory, so it reads the same as memories change. Like the project's index, it reaches subagents too.
- When you correct Claude, or state a preference that holds in every repo, it saves a global memory. A fact about one project goes to that project's memory.
- Claude writes a global memory the way Claude Code's own memory instructions, just above the global section in the system prompt, say to write any memory: what to save, the frontmatter, the type and how the body reads. The global section only says where a global memory differs, so the two stay alike as Claude Code changes its instructions.
- It opens a full memory with `global_memory_read` when an index line looks relevant, and changes memories with `global_memory_write` and `global_memory_delete`. These tools keep the index in step.
- Writes and deletes are checked against your permission rules and mode: a rule or mode that denies refuses them. Where they would ask, this mod asks you itself with a plain Allow or Refuse question. It shows what will be stored (the title, the index line, the start of the body, and whether the save replaces a memory). It is not Claude Code's own permission dialog, so PreToolUse hooks and the auto-mode classifier do not see these calls, and it has no "always allow". Allow `mcp__global-memory__global_memory_write` in your settings if you would rather not be asked. Reads need no permission, and a deny rule does not stop them.
- Sessions in other projects share the folder. A lock directory (`~/.claude/memory/.lock`) makes their changes take turns, so no index line is lost. A lock older than 15 seconds is taken to be left by a dead session and broken by one session at a time. A session removes the lock only if it is still its own.
- The index keeps the limits Claude Code keeps for its own memory index, as every line of it is loaded into every session. A memory's index line (title, name and description) may be 150 characters. A session loads the first 200 lines and 25 KB of the index. A save that would take the index past either is refused, so Claude must delete or fold a memory first. From 80% of either, a save or delete tells Claude to compact the index to 70%.
- A memory's file, frontmatter included, may be 4,096 bytes and 200 lines: the most Claude Code's memory recall shows of a memory. A save past either is refused, and from 80% a save tells Claude to keep the memory to one fact under 70%.
- Each file is written to a temp file beside it and moved into place, so another session never reads a half-written index.

No shell is used, but these commands must be on the path: `mkdir`, `mv` and `rm`. Windows is not supported.

## Install

At the prompt of a terminal session:

```
/plugin install global-memory --marketplace astrosteveo/astro-plugins
```

## Test

```
claude plugin validate plugins/global-memory
claude plugin test plugins/global-memory
```
