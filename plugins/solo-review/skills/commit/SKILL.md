---
name: commit
description: Commit finished work on a feature branch, one commit per logical unit (one purpose, builds and passes tests). Use when a unit of work is complete, when a diff mixes several purposes and needs splitting, or when asked to commit.
argument-hint: "[hint for the message]"
disallowed-tools: AskUserQuestion
allowed-tools: Read, Write, Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py *), Bash(git status *), Bash(git diff *), Bash(git log *), Bash(git add *), Bash(git commit *), Bash(git switch *), Bash(git branch *), Bash(git apply *), Bash(git rev-parse *)
---

# solo-review: commit

The goal is a history where every commit can be reverted or bisected on its own. Each commit is one logical unit:
it has one purpose, the project builds and its tests pass, and the message says why the change was made.
Run each git command on its own, never chained with `;` or `&&`. A chained command needs approval for every
part.

**Only in a repo set up for solo-review.** Before anything else, run
`python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py status`. If it prints `"opted_in": false`, the repo has no
`.review/`: it was never set up, and this skill doesn't apply. Stop following it.
- If the user typed `/solo-review:commit` themselves, tell them in one sentence that this repo isn't set up for
  solo-review, and that `/solo-review:setup` sets it up. Do nothing else.
- Otherwise, do what the user asked as if solo-review weren't installed, and don't mention solo-review, its skills,
  REVIEW.md or `.review/`.

Arguments: `$ARGUMENTS`

1. **Branch.** Run `git branch --show-current` and `git status --short`. If you are on the default branch, first
   create a branch named for the task (type is feat, fix, refactor, docs, or chore): `git switch -c
   <type>/<short-name>`. Uncommitted changes move with you. Never commit directly to the default branch.

2. **Read the change.** Run `git diff HEAD --stat`, then read the diff. For a large diff, read it one file at a time.
   Read untracked files that will be committed. Run `git log --oneline -10` and match the project's subject style.

3. **Split it into units.** Group the hunks by purpose:
   - Keep refactors, renames, and formatting separate from behavior changes.
   - Commit tests with the code they test.
   - Commit review fixes on their own, and name the finding ids in the subject (`Fix review findings F-3, F-5`, or
     `Fix review finding F-3` for one). Keep that prefix exactly: review reads it to tell fixes from new work.
   - Leave work that isn't finished uncommitted, and say so.
   If a single file holds hunks from two units, stage only the hunks for one unit: write that partial diff to a
   patch and apply it with `git apply --cached <patch>`. If the hunks can't be cleanly separated, commit them
   together and say so in the body.

4. **Check.** Run the project's check once, before you commit, with `python3
   ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py check`, which only prints the `check` command from REVIEW.md. Run that
   command yourself as its own Bash call; it asks permission unless the user has allowed it, by design, because the
   command comes from the repo. If `ledger.py check` says no check is configured, say so instead of guessing a command. If it
   fails, commit only the units that don't depend on the failure, and report the rest. Never commit a unit that you
   know is broken.

5. **Commit each unit.** Stage it with `git add -- <paths>`, never `git add -A` or `git add .`. Then `git commit`:
   - Subject: imperative mood, 72 characters at most, and states the purpose.
   - Body (when the why isn't obvious): what problem this solves and any decision a future reader would question.
   - Add the attribution trailers your instructions specify.
   Before each commit, check the staged file names. Never stage `.review/`: the ledger stays uncommitted while you
   work, so it follows you across branch switches, and `/solo-review:ship` commits it. Do not commit secrets, `.env` files, build output, or large
   generated files. Never use `--no-verify`, and never amend or rewrite a commit that has already been pushed.

6. **Report.** Give one line per commit (short sha and subject), plus anything you left uncommitted and why.
