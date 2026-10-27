# worktrees

Switch it on, and each Claude Code session works in a git worktree of its own. When the session ends, the mod removes the worktree if nothing in it would be lost. You never choose "keep or remove".

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

**Entering.** On the first prompt you type in a git repository, the mod cuts a worktree under `.claude/worktrees/<words-from-your-prompt>-<id>` on a branch `wt/<same name>`, then moves the session into it. It cuts from `main` (or `master`), or from `origin/main` when your local `main` is behind it.

It does nothing when the session is already in a worktree, is outside a repository, is headless (`claude -p`), or when the prompt is a slash command. If git or the move fails, you get a note and the prompt runs in the main checkout.

**Leaving.** When the session ends, the mod removes the worktree and its branch only if both hold:

- the tree has no uncommitted or untracked files, and
- every commit in it is already in `main` or `origin/main`.

Otherwise it stays, marked with the reason. The next time you start Claude in that repository, a note lists what was left. Once you merge the branch and clean the tree, the next start removes it.

A `/clear` or a resume ends nothing. A session that dies without a goodbye is cleaned up by the next one; the mod treats a worktree as abandoned after a week.

## Limits

- A branch merged by squash looks unmerged to git, so its worktree stays until you run `/worktrees discard NAME`.
- Your uncommitted changes in the main checkout stay there. The worktree starts from the last commit.
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
