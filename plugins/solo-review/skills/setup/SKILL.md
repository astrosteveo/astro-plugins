---
name: setup
description: Set solo-review up in this project, start to finish, in a new folder, a brownfield repo or one that used solo-review v1. Creates whatever is missing (the git repo, a first commit, CLAUDE.md, REVIEW.md, settings, a PR template), commits it on a branch, turns on the guard that keeps changes off the default branch until they go through a PR, and offers to open the setup's own PR.
disable-model-invocation: true
disallowed-tools: AskUserQuestion
allowed-tools: Read, Grep, Glob, Write, Edit, Skill, Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py *), Bash(git init), Bash(git init *), Bash(git status *), Bash(git log *), Bash(git ls-files *), Bash(git branch *), Bash(git switch *), Bash(git add *), Bash(git restore *), Bash(git commit *), Bash(git rm *), Bash(rm -rf .review)
---

# solo-review: setup

The user ran this to have solo-review set up, so set it up. Respecting their time is the point of the plugin.
- **Do the whole job in one pass.** When something setup needs is missing, make it. Never tell the user to go and
  make it themselves.
- **Don't stop to ask "should I?".** Everything up to the commit is local and reversible, so do it, then report.
- **Changes reach the default branch only through a reviewed PR,** and that includes the setup itself. Only a brand-new
  repository's first commit goes straight onto it: there is nothing yet to open a PR against.
- **Stop only for these**, each asked as one plain sentence with your recommendation:
  - publishing: creating a GitHub repo, pushing, or opening a PR
  - making a git repository of the home folder or `/`
- **Talk in plain text.** Never use a question or menu tool.
- **Keep messages short:** what you did, not how.

`L` means `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py`. Run each command as its own Bash call.

## 1. Look
- Run `L setup-info`. It works before the folder is a git repository.
  - If `unsafe_root` is true, ask before anything else, and wait.
  - If `config` and `review_md` are both true and `v1` is null, the project is already set up: go to
    **Running it again**.
- If `git branch --list 'chore/solo-review-setup'` shows that branch, setup already ran and is waiting to land. Say
  so, and offer to open its PR (see **4. When they say yes**) instead of doing it again.
- Read the README, CLAUDE.md, the manifests and the CI files (`ci_files`), and glance at the layout. You need to know
  what this project does, and what a bad bug in it looks like.
- If it has history, run `git log --oneline -100`. Look for fix commits that keep coming back to the same kind of bug.
- **Find the check**, the one command that proves the project works. Look in this order:
  1. what CI runs
  2. what CLAUDE.md or the README says to run
  3. `inferred_check`
  4. the best that exists: a build, a type check, a compile, or a smoke run like `--help`

  Run it once, as its own Bash call. It asks the user's permission unless they allowed it, by design: the command
  comes from the repo. That prompt is the one expected pause.
  - If the user declines, the check is unverified, not failing: report `Check: <command>, not run (permission
    declined).` and carry on.
  - A failing check doesn't stop setup: note what failed, and report it.
  - A slow check can run in the background while you do step 2, but the report waits for it: never send one that says
    the check is still running.

## 2. Make it
**Never touch the user's work in progress.** `uncommitted` lists it.
- Commit only the files setup wrote, by path. Uncommitted changes come along when you switch branches, and stay
  uncommitted.
- If setup has to change a file that is already in `uncommitted` (an edited CLAUDE.md or `.gitignore`), make the
  change, leave that file out of the commit, and say so.

Then, in this order:
1. **Git.** If `is_repo` is false, run `git init`.
2. **First commit**, only if `has_commits` is false. The project's files become the starting point, so reviews begin
   from the code as it is.
   - Add each `ignore_gaps` pattern to `.gitignore` first, creating the file if needed.
   - Run `git add -A`, then `git status --short`.
   - Unstage anything that shouldn't be committed (secrets, build output, very large files) with
     `git restore --staged`, and add it to `.gitignore`.
   - Commit it as `Initial commit`, on the default branch.
3. **Branch.** Run `L where`.
   - If `on_default` is true, start the setup's branch:
     - If `unpushed` is above 0, start it from origin's copy, so the commits on `<default>` that were never pushed
       stay out of the setup PR: `git switch -c 'chore/solo-review-setup' '<origin_default>'`. If git refuses because
       uncommitted changes would be overwritten, start it from where you are instead, and say the setup PR will
       include those commits.
     - Otherwise, run `git switch -c 'chore/solo-review-setup'`.
   - On another branch, stay there: the setup rides along with that branch's PR.
   - Then run `L enable`. From now on, edits and commits on the default branch are refused here until a branch is
     started.
4. **Ignore**, if the repository already had commits: add each `ignore_gaps` pattern to `.gitignore`.
5. **Moving from v1** (`v1` is not null). This project used solo-review v1.
   - If `ledger_events` is above 0, run `L import-v1` to keep the review history.
   - Take the settings from `v1.settings`.
   - Write `v1.review_md` as REVIEW.md: v1's guide with the settings block removed and the headings renamed.
   - Run `git rm -r -q .review`, then `rm -rf .review` for the untracked leftovers.
   - If `pr_template_v1` is set, replace it with the plugin's template.
   - Delete the lines in `claude_md_worktree_lines` from CLAUDE.md.
6. **CLAUDE.md.**
   - **If there is none, create it.** Keep it under about 40 lines, every line something you can point to in the
     repo:
     - one line on what the project is
     - the main folders, one line each
     - the conventions the code really follows, citing their config (formatter, linter, test layout)
     - the Verify section from `verify-section.md`, with the real check and commands
     - the Git section from `git-section.md`, with the real default branch name

     No aspirational rules.
   - **If `claude_md_has_verify` is false**, append the Verify section with the real commands. **If it has one**,
     leave it. Add one line asking for the output to be shown, if it doesn't already.
   - **If `claude_md_has_git` is false**, append the Git section. If it says something else about branches or PRs,
     leave that alone unless it contradicts "a branch per change, merged through a PR"; then say so in the report.
7. **REVIEW.md.**
   - **If there is none, fill the template:**
     - "What Important means here": 3 to 5 failures a user of this project would hit. Take them from what the README
       promises, how the code handles errors, and the bugs past fix commits fixed.
     - "Always check": only the bug classes the history shows recurring.
     - "Cap the nits": the max_nits number.
     - Delete the comment in each section you filled.
   - **If one exists** (and isn't v1's), leave it alone. If it lists no failures for the finders to check, add a
     "What Important means here" section.
8. **Settings**, `.claude/solo-review.json`. Keep any values already there, and add what's missing:
   - `check`: the command from step 1.
   - `high`: the code where one missed bug is expensive (auth, billing, data migrations, release or install
     scripts), from `candidate_high` and what you read. CI, manifests, Claude config and secrets are already
     High-risk, built in.
   - `skip`: tracked generated or vendored paths.
   - Globs work like git's: `*` stays in one folder, so write `**/` for any depth.
9. **PR template.** If `pr_template` is null (or was v1's), write the plugin's template, unchanged, as
   `.github/pull_request_template.md`.
10. **Commit.**
    - Run `git add -- <the files setup wrote or removed>`.
    - Then run `git commit -m "Set up solo-review" -- <the same paths>` (`"Move solo-review to v2"` after a
      migration). The paths matter: they keep anything the user had staged out of the commit.

## 3. Report
One short message.
1. **First line:** `solo-review is set up in <name>, on branch <branch> (commit <short sha>).`
2. **What it set up**, one line each, in plain words:
   - **The check:** `Check: <command>, passes now.` Or `fails right now: <what>. Reviews stop at a red check until
     it passes.`
   - **What reviews watch for:** a few words per line of "What Important means here".
   - **Extra care:** each `high` path, and why.
   - **What it created or added:** CLAUDE.md and its sections, the `.gitignore` lines, the first commit, the PR
     template.
   - **The guard:** "Claude can't edit or commit on `<default>` here any more: each change gets a branch and lands
     through a PR."
   - **After a migration:** the review history kept (`<n>` events), and the v1 settings dropped
     (`dropped_keys`): v2 has no push gate or auto-run, and branches are plain branches, never worktrees.
   - **What it left alone:** the user's uncommitted work, and any file it changed but didn't commit.
3. **How to use it here**, in three lines:
   1. Ask for a change. Claude starts a branch for it.
   2. `/solo-review:review` checks it and fixes what matters.
   3. `/solo-review:ship` opens the PR, and merges when you say. Without a GitHub remote, it offers to create one
      first.
   - Add: "Tell me anything you'd put differently, and I'll change it."
4. **At most one question**, last:
   - **On `chore/solo-review-setup`, with a GitHub remote:** "Want me to open the setup PR now?"
   - **On `chore/solo-review-setup`, with no remote:** "This project isn't on GitHub yet, and changes land through
     PRs there. Want me to create a private repo, push `<default>` as it is, and open the setup PR?" If `gh` is
     false, say it needs the GitHub CLI (https://cli.github.com) instead of asking.
   - **With an `origin` that isn't GitHub:** no question. Say ship opens GitHub PRs only, so the setup branch waits
     for a pull or merge request opened on that host. Never suggest merging it onto the default branch another way.
   - **On another branch:** no question. Say the setup commit rides along with that branch's PR.

## 4. When they say yes
1. Be on the branch setup committed to (`chore/solo-review-setup`, or `chore/solo-review-tune` after a re-run): run
   `git switch '<that branch>'` if you aren't.
2. Invoke the `solo-review:ship` skill with the arguments `--skip-review --committed-only`.
   - `--skip-review`: the setup's files are for the user to read in the PR. The PR says so.
   - `--committed-only`: the user's uncommitted work stays out of the setup PR.
   - Ship does the rest: creating the GitHub repo if there is none, after scanning for secrets and personal emails,
     then the PR, CI, and the merge when the user says to.

On no, say the setup waits on `chore/solo-review-setup`, and `/solo-review:ship` opens it whenever they're ready.

## Running it again
The project is already set up, so don't redo it.
1. Run `L enable` (it does nothing if the guard is already on), then run the check.
2. Report in a few lines: the check and whether it passes, the settings, and how many reviews have run
   (`ledger_runs`).
3. Report anything that has drifted:
   - a check that fails or no longer exists
   - `candidate_high` paths the settings don't cover
   - CLAUDE.md without a Verify or Git section
   - recent fix commits of a kind "Always check" doesn't name
4. Fix the drift the same way, on a branch (`git switch -c 'chore/solo-review-tune'` when `L where` says `on_default`),
   in one commit, and report what changed. Offer its PR as in **4. When they say yes**.
