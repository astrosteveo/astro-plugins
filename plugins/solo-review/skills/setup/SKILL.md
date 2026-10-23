---
name: setup
description: Set solo-review up in this project, start to finish, in a new folder, a brownfield repo or one that used solo-review v1. Creates whatever is missing (the git repo, a first commit, CLAUDE.md, REVIEW.md, settings, a PR template), commits it, and offers to put the project on GitHub.
disable-model-invocation: true
disallowed-tools: AskUserQuestion
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py *), Bash(git init), Bash(git init *), Bash(git status *), Bash(git log *), Bash(git ls-files *), Bash(git add *), Bash(git restore *), Bash(git commit *), Bash(git rm *), Bash(rm -rf .review), Bash(git push *), Bash(git remote *), Bash(gh auth status), Bash(gh repo create *), Bash(gh repo view *)
---

# solo-review: setup

The user ran this to have solo-review set up, so set it up. Respecting their time is the point of the plugin.
- **Do the whole job in one pass.** When something setup needs is missing, make it. Never tell the user to go and
  make it themselves.
- **Don't stop to ask "should I?".** Everything up to the commit is local and reversible, so do it, then report.
- **Stop only for these**, each asked as one plain sentence with your recommendation:
  - publishing: creating a GitHub repo, or pushing
  - a secret or personal email that would be published
  - making a git repository of the home folder or `/`
- **Talk in plain text.** Never use a question or menu tool.
- **Keep messages short:** what you did, not how.

`L` means `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py`. Run each command as its own Bash call.

## 1. Look
- Run `L setup-info`. It works before the folder is a git repository.
  - If `unsafe_root` is true, ask before anything else, and wait.
  - If `config` and `review_md` are both true and `v1` is null, the project is already set up: go to
    **Running it again**.
- Read the README, CLAUDE.md, the manifests and the CI files (`ci_files`), and glance at the layout. You need to know
  what this project does, and what a bad bug in it looks like.
- If it has history, run `git log --oneline -100`. Look for fix commits that keep coming back to the same kind of bug.
- **Find the check**, the one command that proves the project works. Look in this order:
  1. what CI runs
  2. what CLAUDE.md or the README says to run
  3. `inferred_check`
  4. the best that exists: a build, a type check, a compile, or a smoke run like `--help`

  Run it once, as its own Bash call. A failing check doesn't stop setup: note what failed, and report it. A slow
  check can run in the background while you do step 2, but the report waits for it: never send one that says the
  check is still running.

## 2. Make it
**Never touch the user's work in progress.** `uncommitted` lists it.
- Commit only the files setup wrote, by path.
- If setup has to change a file that is already in `uncommitted` (an edited CLAUDE.md or `.gitignore`), make the
  change, leave that file out of the commit, and say so.

Then, in this order:
1. **Git.** If `is_repo` is false, run `git init`.
2. **Ignore.** Add each `ignore_gaps` pattern to `.gitignore`, creating the file if needed.
3. **First commit.** If `has_commits` is false, the project's files become the starting point, so reviews begin from
   the code as it is.
   - Run `git add -A`, then `git status --short`.
   - Unstage anything that shouldn't be committed (secrets, build output, very large files) with
     `git restore --staged`, and add it to `.gitignore`.
   - Commit it as `Initial commit`.
4. **Moving from v1** (`v1` is not null). This project used solo-review v1.
   - If `ledger_events` is above 0, run `L import-v1` to keep the review history.
   - Take the settings from `v1.settings`.
   - Write `v1.review_md` as REVIEW.md: v1's guide with the settings block removed and the headings renamed.
   - Run `git rm -r -q .review`, then `rm -rf .review` for the untracked leftovers.
   - If `pr_template_v1` is set, replace it with the plugin's template.
   - Delete the lines in `claude_md_worktree_lines` from CLAUDE.md.
5. **CLAUDE.md.**
   - **If there is none, create it.** Keep it under about 40 lines, every line something you can point to in the
     repo:
     - one line on what the project is
     - the main folders, one line each
     - the conventions the code really follows, citing their config (formatter, linter, test layout)
     - the Verify section from `verify-section.md`, with the real check and commands

     No aspirational rules.
   - **If `claude_md_has_verify` is false**, append the Verify section with the real commands.
   - **If it has one**, leave it. Add one line asking for the output to be shown, if it doesn't already.
6. **REVIEW.md.**
   - **If there is none, fill the template:**
     - "What Important means here": 3 to 5 failures a user of this project would hit. Take them from what the README
       promises, how the code handles errors, and the bugs past fix commits fixed.
     - "Always check": only the bug classes the history shows recurring.
     - "Cap the nits": the max_nits number.
     - Delete the comment in each section you filled.
   - **If one exists** (and isn't v1's), leave it alone. If it lists no failures for the finders to check, add a
     "What Important means here" section.
7. **Settings**, `.claude/solo-review.json`. Keep any values already there, and add what's missing:
   - `check`: the command from step 1.
   - `high`: the code where one missed bug is expensive (auth, billing, data migrations, release or install
     scripts), from `candidate_high` and what you read. CI, manifests, Claude config and secrets are already
     High-risk, built in.
   - `skip`: tracked generated or vendored paths.
   - Globs work like git's: `*` stays in one folder, so write `**/` for any depth.
8. **PR template.** If `pr_template` is null (or was v1's), write the plugin's template, unchanged, as
   `.github/pull_request_template.md`. It is ready for when the project is on GitHub.
9. **Commit.**
   - Run `git add -- <the files setup wrote or removed>`.
   - Then run `git commit -m "Set up solo-review" -- <the same paths>` (`"Move solo-review to v2"` after a
     migration). The paths matter: they keep anything the user had staged out of the commit.
   - On a feature branch, commit there.

## 3. Report
One short message.
1. **First line:** `solo-review is set up in <name> (commit <short sha>).`
2. **What it set up**, one line each, in plain words:
   - **The check:** `Check: <command>, passes now.` Or `fails right now: <what>. Reviews stop at a red check until
     it passes.`
   - **What reviews watch for:** a few words per line of "What Important means here".
   - **Extra care:** each `high` path, and why.
   - **What it created or added:** CLAUDE.md, the Verify section, the `.gitignore` lines, the first commit, the PR
     template.
   - **After a migration:** the review history kept (`<n>` events), and the v1 settings dropped
     (`dropped_keys`): v2 has no push gate, branch rule or auto-run.
   - **What it left alone:** the user's uncommitted work, and any file it changed but didn't commit.
3. **How to use it here**, in three lines:
   - With a remote:
     1. Make a change, committed or not.
     2. `/solo-review:review` checks it and fixes what matters.
     3. `/solo-review:ship` opens the PR, and merges when you say.
   - Without a remote:
     1. Make a change, and don't commit yet.
     2. `/solo-review:review`.
     3. Commit when it's clean.
   - If `unpushed` was above 0, add: "Your first review will cover the `<n>` commits not pushed yet."
   - Add: "Tell me anything you'd put differently, and I'll change it."
4. **At most one question**, last:
   - **No remote:** "This project isn't on GitHub, and ship needs that. Want me to create a private repo for it and
     push it?" If `gh` is false, say it needs the GitHub CLI and how to install it.
   - **A GitHub remote, on the default branch:** "Want me to push the setup commit? Otherwise your next review
     includes these files."

## 4. When they say yes
- **To creating a GitHub repo:**
  1. Run `gh auth status`. If they aren't logged in, ask them to run `! gh auth login`, and wait.
  2. Run `L publish-scan`. If it isn't `clean`, or it lists personal `emails` or `commit_emails`, tell them what a
     push would publish: the kind of secret and the file (never the value), and the addresses. Recommend a fix, do
     what they choose, and scan again. Removing something from history means rewriting commits before the first push,
     which changes their hashes; say so.
  3. Run `gh repo create <name> --private --source=. --remote=origin --push`, public only if they asked for it.
  4. Report the URL, and that `/solo-review:ship` works now.
- **To pushing:** run `git push`.

## Running it again
The project is already set up, so don't redo it.
1. Run the check.
2. Report in a few lines: the check and whether it passes, the settings, and how many reviews have run
   (`ledger_runs`).
3. Report anything that has drifted:
   - a check that fails or no longer exists
   - `candidate_high` paths the settings don't cover
   - CLAUDE.md without a Verify section
   - recent fix commits of a kind "Always check" doesn't name
4. Fix the drift the same way (one pass, one commit), and report what changed.
