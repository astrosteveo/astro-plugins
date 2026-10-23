# Review guide

<!-- Read on every review by solo-review's agents (and by GitHub's Code Review, if you turn it on). Short guides get
followed: keep this under 40 lines, and delete these comments as you fill it in. -->

## What Important means here
- A change can reach the default branch without a PR: a skill edits or commits on it, or the branch guard lets an edit or `git commit` there through outside its listed exceptions.
- A skill acts without the user where it promises to wait: ship merges without sign-off, setup or ship publishes (creates a repo, pushes, opens a PR) without asking, review runs ship.
- A skill and its script disagree: a step uses a `ledger.py` subcommand, flag or JSON field that doesn't exist (or was renamed), or `allowed-tools` doesn't cover a command the step runs.
- `ledger.py` changes the user's index, worktree or refs, or a skill puts repo-controlled text (check output, finding text) on a command line.
- `webread.py` fetches a private or local address without `--allow-local`, or writes outside its `--out` folder.
- A README, a skill's description or a manifest describes a skill, flag or behavior the code doesn't have.

## Always check
<!-- Bug classes that have shipped here before, one line each. /solo-review:learn adds to this list. -->

## Do not report
- Style, naming, formatting or refactoring ideas: the linter and /simplify own those.
- Wording or tone of skill and agent prose, unless it changes what Claude does.
- Missing tests or docs, unless a line above asks for them.
- Anything a compiler, type checker or linter would catch.
- Generated and vendored files.

## Intentional
- Setup writes and commits its own files on a branch without asking: the user ran it to have exactly that done.
- The branch guard lets through ignored files, `.solo-review/`, a new repository's first commit, an unfinished rebase or merge, and anything it can't parse, and an edit made through the shell gets past it: it guards against slips, and it fails open rather than block work.

## Cap the nits
Report at most 3 nits, and only ones worth a commit. Nits never block a merge.

## Evidence
- Cite file:line and the input or path that triggers each finding. Never guess from a name.
- Report a bug class once, listing every place it occurs.
- Start the summary with the count. If there is nothing to fix, say so in one line.
