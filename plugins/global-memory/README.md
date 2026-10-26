# global-memory

Claude keeps project memories on its own, but never a memory that holds in every project. This mod adds one.

Global memories live in `~/.claude/memory/`, one file per fact, with a `MEMORY.md` index. They are separate from your own `~/.claude/CLAUDE.md`, which Claude never edits.

- The index joins the system prompt's memory section at the start of each session. A memory saved mid-session reaches the next session, so the conversation's prompt cache is kept.
- When you correct Claude, or state a preference that holds in every repo, it saves a global memory. A fact about one project goes to that project's memory.
- It opens a full memory with `global_memory_read` when an index line looks relevant, and changes memories with `global_memory_write` and `global_memory_delete`. These tools keep the index in step.
- Writes and deletes go through Claude Code's permission check like any other tool: your rules and mode decide, and where they ask, you are asked. Reads need no permission. Allow `mcp__global-memory__global_memory_write` in your settings if you would rather not be asked.
- Sessions in other projects share the folder. A lock directory (`~/.claude/memory/.lock`) makes their changes take turns, so no index line is lost; a lock a minute old is taken to be left by a dead session.
- The index holds at most 200 memories. At that point Claude must delete or fold one before it saves another.

Needs a POSIX shell: the lock and delete use `mkdir`, `rmdir`, `find` and `rm`.

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
