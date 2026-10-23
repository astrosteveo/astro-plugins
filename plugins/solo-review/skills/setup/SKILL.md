---
name: setup
description: Set this project up for solo-review, once per project. Creates REVIEW.md, CLAUDE.md, .review/ and the pull request template (each only if missing), puts the setup on a branch, and opts the project in, which turns on the branch guard and the session rules.
disable-model-invocation: true
disallowed-tools: AskUserQuestion
allowed-tools: Read, Grep, Write, Edit, Agent, Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py *), Bash(git init), Bash(git switch *), Bash(git branch *), Bash(git rev-parse *), Bash(git log *), Bash(git status *), Bash(git diff *), Bash(git add *), Bash(git commit *)
---

# solo-review: setup

This opts the project in: once `.review/` exists, the hooks act here (the branch guard, the session rules, the push
gate), and review and ship have a ledger to write to. Run it once per project. Running it again leaves the files that
exist unchanged.

`L` means `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py`, run from the project (it finds the repo root). Run each
command on its own, never chained with `;`, `&&`, or pipes. Look at files with Read and Grep, not `cat` or `grep`.
Ask the user in plain sentences, never with a question or menu tool.

1. Run `git log -1 --format=%h`. If it fails, the project is not a git repository or has no commits yet: run
   `L init` and go on below. If it works, there is history, so start the setup branch before `L init` writes
   anything. Run `git branch --show-current`; if you are on the default branch, run `git switch -c
   chore/review-setup`: the branch guard blocks edits there from now on, so the setup lands on a branch like any
   other change. Then run `L init`.
   - If it says this is not a git repository, the project is new: run `git init`, then `L init` again. If the
     working directory doesn't look like the project's own folder (your home directory, say), ask the user first.
   - If it says there are no commits yet, stay on the current branch: the setup becomes the first commit (step 5).
2. If REVIEW.md was just created, fill in "What Important means here" with 3 to 5 lines inferred from CLAUDE.md
   and README (read only those two). In a new project that has neither, use what the user has said they are
   building, or leave the section for later and say so.
3. If `L config` shows an empty `check`, find the one command that builds and tests the project and set `check:` in
   REVIEW.md. If there is none, say so.
4. CLAUDE.md steers every session and every review, so check it as carefully as REVIEW.md.
   - If `L init` created it from the template, fill it in from the README, the manifest, and the code. Keep a line
     only if you checked it against a file, command, or pattern. In a new project with no code yet, keep only
     what the user has told you about it, and delete the placeholder lines.
   - If it already existed, launch a fresh `general-purpose` agent with its path and this task: check each line
     against the code, and report false, stale, and unverifiable lines with evidence, plus conventions the code
     depends on that the file lacks. Propose the edits, and apply them only with the user's approval.
5. If `L init` said there are no commits yet, show REVIEW.md and CLAUDE.md, and ask the user to edit them or say
   they are ready. They become the first commit, which has nothing before it to be reviewed against, so the user's
   read is its only review. When the user is ready, run `git add` with every setup file `L init` listed (its
   `.review/` files included, so clones and worktrees have opted in too), then `git commit -m 'Set up
   solo-review'`. Leave everything else uncommitted. Otherwise, show REVIEW.md to the user to edit.
6. Tell the user that the workflow rules apply from now on, in this session too (`L init` prints them when it opts
   the project in), and the hooks give them to every new session. Follow them yourself from here.
