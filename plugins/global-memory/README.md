# global-memory

Claude keeps project memories on its own, but never a memory that holds in every project. This plugin adds one.

Global memories are the quick path: Claude saves one the moment you correct it. The [global-rules](../global-rules) plugin is the considered one: run its `/global-rules:suggest` at the end of a session, and a correction that a memory already records becomes a rule in your global `~/.claude/CLAUDE.md`, and the memory can go.

That skill was `/global-memory:suggest`, part of this plugin, and moved to global-rules in 0.4.0. Install it to keep the skill: `/plugin install global-rules --marketplace astrosteveo/astro-plugins`.

## Global memories

Global memories live in `~/.claude/memory/` (or `$CLAUDE_CONFIG_DIR/memory/` when that is set), one file per fact, with a `MEMORY.md` index. Each file has the frontmatter Claude Code's own memories have, with the time it was written in `metadata.modified`. They are separate from your own `~/.claude/CLAUDE.md`.

- The index reaches Claude the way Claude Code's own `MEMORY.md` does: as an auto-memory file beside your CLAUDE.md files in the context of a conversation's first message. It is loaded when a conversation starts and again after a compaction, so a memory saved mid-session reaches the next session and the conversation's prompt cache is kept. The system prompt only says how to use the global memory, so it reads the same as memories change. Like the project's index, it reaches subagents too.
- When you correct Claude, or state a preference that holds in every repo, it saves a global memory. A fact about one project goes to that project's memory.
- Claude writes a global memory the way Claude Code's own memory instructions, just above the global section in the system prompt, say to write any memory: what to save, the frontmatter, the type and how the body reads. The global section only says where a global memory differs, so the two stay alike as Claude Code changes its instructions.
- It opens a full memory with `global_memory_read` when an index line looks relevant, and changes memories with `global_memory_write` and `global_memory_delete`. These tools keep the index in step.
- Writes and deletes are checked against your permission rules and mode: a rule or mode that denies refuses them. Where they would ask, this mod asks you itself with a plain Allow or Refuse question. It shows what will be stored (the title, the index line, the start of the body, and whether the save replaces a memory). It is not Claude Code's own permission dialog, so PreToolUse hooks and the auto-mode classifier do not see these calls, and it has no "always allow". Allow `mcp__global-memory__global_memory_write` in your settings if you would rather not be asked. Reads need no permission, and a deny rule does not stop them.
- Sessions in other projects share the folder. A lock directory (`~/.claude/memory/.lock`) makes their changes take turns, so no index line is lost. A lock older than 15 seconds is taken to be left by a dead session and broken by one session at a time. A session removes the lock only if it is still its own.
- The index keeps the limits Claude Code keeps for its own memory index, as every line of it is loaded into every session. A memory's index line (title, name and description) is at most 150 characters: a longer description is cut at a word, ending in `…`, and the memory file keeps it whole. A title that leaves the description fewer than 40 characters is refused. A session loads the first 200 lines and 25 KB of the index. A save that would take the index past either is refused, so Claude must delete or fold a memory first. From 80% of either, a save or delete tells Claude to compact the index to 70%.
- A memory's file, frontmatter included, may be 4,096 bytes and 200 lines: the most Claude Code's memory recall shows of a memory. A save past either is refused, and from 80% a save tells Claude to keep the memory to one fact under 70%.
- Each file is written to a temp file beside it and moved into place, so another session never reads a half-written index.

No shell is used, but these commands must be on the path: `mkdir`, `mv` and `rm`. Windows is not supported.

## Manage them: /global-memory

`/global-memory` opens a menu of your global memories in a pane that takes the keys. Esc closes it.

- The list shows each memory the index names, in its order, as its title and index line. A line whose file is gone says so. Files in the folder that the index doesn't name come last, since no session loads them. Above the list: how many memories there are, and how much of the index's 200-line and 25 KB read limits they take.
- Arrows or Tab move between rows, and Enter opens one. It shows the memory's type, when it was saved (UTC), its path and its whole body. A long body scrolls with PageUp and PageDown.
- `b` goes back to the list, `d` deletes. Delete asks first (`y` deletes, `n` cancels), then removes the file and its index line under the same lock as `global_memory_delete`. Your press is the permission, so no permission rule is checked.

Editing a memory stays with Claude: ask it to change one, and it rewrites the memory with `global_memory_write`.

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
