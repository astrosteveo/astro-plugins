---
name: commit
description: Commit finished work on the current branch as logical units (one purpose each, building and passing its checks). Use when a piece of work is complete, when a diff mixes several purposes and needs splitting, or when asked to commit.
argument-hint: "[hint for the message]"
allowed-tools: Read, Write, Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py *), Bash(git status *), Bash(git diff *), Bash(git log *), Bash(git add *), Bash(git commit *), Bash(git apply *), Bash(git rev-parse *)
---

# solo-review: commit

The goal is a history where every commit can be reverted or bisected on its own. Each commit is one logical unit: it
has one purpose, the project builds and its checks pass, and the message says why the change was made. Commit on the
branch you're on; `/solo-review:ship` moves work off the default branch when it opens a PR.
Run each git command as its own Bash call, never chained with `;` or `&&`.

Arguments: `$ARGUMENTS`

1. **Read the change.**
   - Run `git status --short` and `git diff HEAD --stat`, then read the diff, one file at a time if it is large.
   - Read untracked files that will be committed.
   - Run `git log --oneline -10` and match the project's subject style.
2. **Split it into units.** Group the hunks by purpose:
   - Keep refactors, renames and formatting apart from behavior changes.
   - Commit tests with the code they test.
   - Commit review fixes on their own, subject `Fix review findings F-3, F-5` (`Fix review finding F-3` for one).
   - Leave unfinished work uncommitted, and say so.

   If one file holds hunks from two units, write the hunks for one unit as a patch in `.solo-review/` (excluded
   from git) and stage it with `git apply --cached <patch>`. If they can't be separated cleanly, commit them together
   and say so in the body.
3. **Check once.** Run `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py check`, which prints the project's check
   command, then run that command as its own Bash call. It asks permission unless the user allowed it, by design. If
   no check is configured, say so instead of guessing one. If it fails, commit only the units that don't depend on
   the failure, and report the rest. Never commit a unit you know is broken.
4. **Commit each unit.** Stage it with `git add -- <paths>`, never `git add -A` or `git add .`, and check the staged
   names before committing.
   - Subject: imperative mood, 72 characters at most, stating the purpose.
   - Body, when the why isn't obvious: the problem it solves, and any decision a future reader would question.
   - Add the attribution your instructions specify.
   - Never commit secrets, `.env` files, build output or large generated files.
   - Never use `--no-verify`, and never amend or rewrite a commit that has been pushed.
5. **Report.** One line per commit (short sha and subject), plus anything left uncommitted and why.
