# worktrees

Switch it on, and the work you give Claude Code goes into a git worktree of its own, named for the task. When the work is merged or the session ends, the mod removes the worktree if nothing in it would be lost. You never choose "keep or remove".

```
/worktrees          toggle on or off
/worktrees on
/worktrees off
/worktrees status   this session's worktree, and any left behind
/worktrees clean    remove the safe ones now
/worktrees discard NAME   throw one ended worktree away, changes and all
```

The setting is kept between sessions. Turn it on once.

## What it does

**Entering.** The mod waits until Claude has something to change. Claude is offered a `start` tool and told to call it once, before its first edit or its first command that writes, with a short name for the task. The mod then cuts a worktree under `.claude/worktrees/<task-words>-<id>` on a branch `wt/<same name>` and moves the session into it. It cuts from `main` (or `master`), or from `origin/main` when your local `main` is behind it.

If Claude forgets, its first change (a Write, an Edit, a NotebookEdit, or a command the engine does not call read-only) is refused once, with a note that tells it to call `start`. A session that only reads or answers questions never makes a worktree.

Claude reads the main checkout before the move. When that checkout is on another commit than the base, or has uncommitted changes, `start` says so, and tells Claude to read a file again before it edits one.

It does nothing when the session is already in a worktree, is outside a repository, or is headless (`claude -p`). If git or the move fails, you get a note, Claude carries on in the main checkout, and nothing is refused again.

**Leaving.** When the session ends, the mod removes the worktree and its branch only if both hold:

- the tree has no uncommitted or untracked files, and
- every commit in it is already in `main` or `origin/main`.

Otherwise it stays, marked with the reason. The next time you start Claude in that repository, a note lists what was left. Once you merge the branch and clean the tree, the next start removes it.

**Back on main.** After each turn, if the session has committed work in its worktree, that work is now in `main` or `origin/main`, and the tree is clean, the mod steps the session back out to the main checkout and removes the worktree and its branch. The next task begins with a `start` of its own, so each task has a worktree of its own. A fresh worktree with no commits is never stepped out of, however "merged" it looks.

A `/clear` or a resume ends nothing. A session that dies without a goodbye is cleaned up by the next one; the mod treats a worktree as abandoned after a week.

## Limits

- A branch merged by squash looks unmerged to git, so its worktree stays until you run `/worktrees discard NAME`.
- Your uncommitted changes in the main checkout stay there. The worktree starts from the last commit.
- A subagent's commands run before `start`; its file changes are refused until the session has a worktree.
- A command that writes but that the engine calls read-only lands in the main checkout.
- Files git ignores (`.env`, `node_modules`, build output) do not come into the worktree, so the first build or test run there may need setup.
- A session started in a subdirectory lands at the root of the worktree.
- A session that crashes leaves its worktree for up to a week before the next start takes it for abandoned.
- The mod adds `/.claude/worktrees/` to the repository's `.git/info/exclude`, so the folder does not clutter `git status`. Nothing is committed.
- Removal never uses `--force`. Only `/worktrees discard` does, and only for a worktree whose session has ended.

## Check it

```
claude plugin validate plugins/worktrees
claude plugin test plugins/worktrees
```
