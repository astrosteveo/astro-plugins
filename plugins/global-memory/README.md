# global-memory

Claude keeps project memories on its own, but never a memory that holds in every project. This mod adds one.

Global memories live in `~/.claude/memory/`, one file per fact, with a `MEMORY.md` index. They are separate from your own `~/.claude/CLAUDE.md`, which Claude never edits.

- The index joins the system prompt's memory section at the start of each session.
- When you correct Claude, or state a preference that holds in every repo, it saves a global memory. A fact about one project goes to that project's memory.
- It opens a full memory with `global_memory_read` when an index line looks relevant, and changes memories with `global_memory_write` and `global_memory_delete`. These tools keep the index in step and need no permission prompt.

No setup. Load it with `claude --plugin-dir plugins/global-memory`. Check it with `claude plugin test plugins/global-memory`.
