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
5. Commit the setup yourself, as soon as steps 2 to 4 are done. Don't leave the files for the user to edit first:
   you filled them in from the code, and the user corrects them later like any other change. Stage only the setup
   files you created or edited, by path, and leave everything else uncommitted. If you proposed edits to an
   existing CLAUDE.md, commit the rest now, and commit those edits on their own once the user approves them.
   - If `L init` said there are no commits yet, run `git add` with every setup file it listed (its `.review/` files
     included, so clones and worktrees have opted in too), then `git commit -m 'Set up solo-review'`. This first
     commit has nothing before it to be reviewed against, so say that the user's read of REVIEW.md and CLAUDE.md is
     its only review, and that corrections go on a branch.
   - Otherwise, stage REVIEW.md, CLAUDE.md and the pull request template, never `.review/` (`/solo-review:ship`
     commits it), and commit them as `Set up solo-review`, with a body naming what you filled in and the `check`.
     The review and ship of this branch review them like any other change.
   Then tell the user, in a few lines, what you put in "What Important means here", the `check`, and CLAUDE.md.
6. Tell the user that the workflow rules apply from now on, in this session too (`L init` prints them when it opts
   the project in), and the hooks give them to every new session. Follow them yourself from here.
