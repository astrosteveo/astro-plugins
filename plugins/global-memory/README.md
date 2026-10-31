# global-memory

Claude keeps project memories on its own, but never a memory that holds in every project. This mod adds one.

Global memories live in `~/.claude/memory/`, one file per fact, with a `MEMORY.md` index. They are separate from your own `~/.claude/CLAUDE.md`.

- The index joins the system prompt's memory section at the start of each session. A memory saved mid-session reaches the next session, so the conversation's prompt cache is kept. A compaction reads the index again.
- When you correct Claude, or state a preference that holds in every repo, it saves a global memory. A fact about one project goes to that project's memory.
- It opens a full memory with `global_memory_read` when an index line looks relevant, and changes memories with `global_memory_write` and `global_memory_delete`. These tools keep the index in step.
- Writes and deletes are checked against your permission rules and mode: a rule or mode that denies refuses them. Where they would ask, this mod asks you itself with a plain Allow or Refuse question. It shows what will be stored (the title, the index line, the start of the body, and whether the save replaces a memory). It is not Claude Code's own permission dialog, so PreToolUse hooks and the auto-mode classifier do not see these calls, and it has no "always allow". Allow `mcp__global-memory__global_memory_write` in your settings if you would rather not be asked. Reads need no permission, and a deny rule does not stop them.
- Sessions in other projects share the folder. A lock directory (`~/.claude/memory/.lock`) makes their changes take turns, so no index line is lost. A lock older than 15 seconds is taken to be left by a dead session and broken by one session at a time. A session removes the lock only if it is still its own.
- The index holds at most 200 memories. At that point Claude must delete or fold one before it saves another. A title may be 80 characters, an index line's description 400 and a body 20,000, as every index line joins every session's system prompt.
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
