---
name: ship
description: Open the pull request for a reviewed feature branch. Checks that it is reviewed and committed, rebases onto the latest default branch, reruns checks, opens a PR from the repo's template with the review results, and waits for CI. Lands a Low-risk change by itself; merges, lands, and cleans up anything else only when the user says to merge. Run it after a clean review when a task is finished.
argument-hint: "[merge] [--skip-review]"
allowed-tools: Read, Grep, Write, Agent, ExitWorktree, Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py *), Bash(git *), Bash(gh pr *), Bash(gh run view *)
---

# solo-review: ship

This is the solo version of a merge queue. A branch lands only when every finding is answered and the
latest review covers its final code. Checks run again on the latest default branch with the change applied, so two
changes that each passed can't combine into a broken main. On GitHub, the branch lands through a pull request, so CI
runs on it and the review results stay with the change. Opening the PR is automatic. Merging a Medium- or High-risk
change is the user's call, because the user reads the evidence and owns what ships. A Low-risk change, one whose
every file matches the `low` globs in the default branch's REVIEW.md, lands on a clean review and passing checks
without them, like the article's Low tier: "None required once automated review and security checks are green".

`L` below means `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py`. Run each command on its own, never chained with
`;`, `&&`, or pipes. A chained command needs approval for every part, and gets blocked. Use Read and Grep to look
at files, not `cat` or `grep`. Single-quote every value you substitute for `<branch>` or `<default>` in a command
(ship-check flags branch names with unusual characters, but quote anyway).

Arguments: `$ARGUMENTS`

1. **Readiness.** Run `L ship-check`, which prints JSON. Handle each entry in `problems`:
   - Uncommitted changes: run `/solo-review:commit` first.
   - Open findings (Important findings and nits alike: "a PR can't merge while any finding is still open"): resolve
     them through `/solo-review:review`. Do not ship around them.
   - `duplicate_ids` is not a problem, and there is nothing to fix: reviews in two clones each gave those ids to a
     different finding before either could see the other's ledger. `L pr-summary` names them in the PR; tell the
     user too.
   - "Never reviewed" or "changes since the last review round": run `/solo-review:review`. A later round reviews
     only the new changes, so it is cheap. If the user passed `--skip-review`, tell them once what is unreviewed,
     then continue.
     If review stops at the round cap instead of finishing, do not loop: tell the user, and offer three choices, one
     final `/solo-review:review --force` round over the unreviewed fixes, `/solo-review:review --until-clean` to run
     rounds until one is clean, or `/solo-review:ship --skip-review`.
   - `ledger_only: true` (on the default branch, and the only changes are review ledger entries): commit them and
     stop. Stage only the paths in `ledger_files` and commit with a pathspec so nothing else is swept in:
     `git commit -m 'Update review ledger' -- <ledger_files>`; if `ledger_files` is
     empty, an earlier ledger commit only needs pushing. If `upstream` is set, `git push`. If the push is rejected
     because the remote moved, run `git pull --rebase` (the ledger merges with `merge=union`) and push again; if it
     is rejected because the branch is protected, follow step 9's fallback. Then run `git status --short` and
     report that the tree is clean, or what is left.
   - Not on a feature branch, no default branch to land on, no commits, or git status failing: stop and say so.
   - An unsafe branch name (the branch or the default branch has characters outside `[A-Za-z0-9._/-]`): stop and
     say so.

2. **Commit the ledger.** If `git status --short .review` shows changes, commit them on the branch as their own
   commit (rebasing needs a clean tree), `Update review ledger`. Stage only `.review/ledger.jsonl`, plus
   `.review/.gitignore` and `.review/.gitattributes` if they changed. Never `git add .review`, which would commit
   the stale `.pr-body.md`. Run `L init` first so `.pr-body.md` is ignored in older projects. The ledger has `merge=union` set, so ledgers that
   diverged on two branches merge by keeping both sides' lines.

3. **Catch up.** If `local_default` is false (the default branch exists only as `origin/<default>`), run
   `git branch '<default>' 'origin/<default>'` to create it with tracking, then treat `upstream` as `origin/<default>`.
   If `upstream` is set, run `git fetch origin '<default>:<default>'`, which fetches and fast-forwards the local
   default branch; if git refuses because that isn't a fast-forward, stop and tell the user. When `default_worktree`
   is set, git won't update a branch checked out in another worktree: run `git fetch` instead, and rebase onto
   `'origin/<default>'` instead of `'<default>'` below. Then run
   `git rebase '<default>'` on the branch, even if it looks up to date: the default branch may have just moved, and
   the rebase does nothing when there is nothing to catch up on. On conflicts, resolve them so that both sides' intent
   survives, then `git rebase --continue`. If a conflict is about intent rather than text, stop and ask the user.

4. **Check on top of the latest default branch.** Run `L check`, which only prints REVIEW.md's `check` command. Run that command
   yourself as its own Bash call; it asks permission unless the user has allowed it, by design, because the command
   comes from the repo. If `L check` says no check is configured, say so in the PR's Testing section. If it
   fails, have a `solo-review:fixer` fix it (give it `CHECK: python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py check`),
   commit, and run the check again. Never land a red branch.

5. **Open the pull request** (when ship-check says `github` is true; otherwise skip to step 7, then go on through step 9).
   - `git push -u origin <branch>`.
   - Build the PR body from the repo's pull request template, which ship-check names in `pr_template`. Read it, and
     keep its headings, order, and checklist exactly. Replace each section's HTML comment with real content and
     leave nothing as a placeholder:
     - **Summary**: what the branch does and why, in two or three sentences.
     - **Changes**: one line per commit, oldest first, as `` `sha` subject ``.
     - **Review**: the output of `L pr-summary`, unchanged.
     - **Testing**: the checks you ran in step 4 and their results.
     - **Risk and rollback**: what could break, and which commit to revert for each risk. Then what the checks and
       the review would not catch in this change, so the user knows what to read themselves.
     - **Checklist**: tick each box that is true. Leave a box unticked if it isn't true, and say why under it.
     Put the risk tier above the first heading, from ship-check's `tier` and `waits_for_user`: for `high`,
     "Risk: High. Needs a person: this change touches High-risk paths", followed by `high_files`; for `medium`,
     "Risk: Medium. It merges when you say so."; for `low` with `waits_for_user` null, "Risk: Low. It merges on a
     clean review and passing checks, without waiting for you."; for `low` otherwise, "Risk: Low, but it waits for
     you:" followed by `waits_for_user`. If the repo uses its own template with different sections,
     fill those sections in the same spirit. If
     `pr_template` is null, run `L init` to install the plugin's template, commit it, and use it. End the body
     with the attribution your instructions specify for pull requests. Write it to `.review/.pr-body.md` with the
     Write tool.
   - `gh pr create --base <default> --head <branch> --title '<one-line summary>' --body-file .review/.pr-body.md`.
     Pass the title single-quoted, with any single quote inside it written as `'\''`, so `$()` and backticks
     copied from commit subjects don't expand.
     If a PR already exists for the branch, `gh pr edit <branch> --body-file .review/.pr-body.md` instead.
   - Go on to step 6, but stop after it unless the user said to merge (the `merge` argument, or asking for it in
     the conversation) or ship-check's `waits_for_user` is null, which marks a Low-risk change that lands without
     them. Otherwise the user reads the PR and owns the merge.

6. **Wait for CI.** Run `gh pr checks <branch> --watch` in the background (the Bash tool's `run_in_background`),
   so it doesn't hold a foreground call until the timeout, and do nothing else until it exits: you are told when it
   does. Then read its output and exit status as you would a foreground run. Where background runs aren't available,
   run it in the foreground. If it reports no checks, continue. If a check fails, read its log (`gh pr checks <branch>` shows the link; `gh run view <id> --log-failed`), have a `solo-review:fixer` fix
   it, commit, push, and wait again. Never land a red PR. If the user hasn't said to merge and `waits_for_user` is
   set, report the PR URL, the check results, anything open, and `waits_for_user`, then stop.

7. **Re-check the exact commit you will land.** "An approval covers one specific commit." Steps 4 and 6 can add
   commits after the review and after the user said to merge. Run `L ship-check` again.
   - If it reports "changes since the last review round", run `/solo-review:review` over them (a round over only
     those commits, usually quick), push any fixes it commits, and wait for CI again (step 6). If review stops at
     the round cap, ask the user as in step 1.
   - If any commit was added after the user said to merge, tell them the new head SHA (`git rev-parse --short HEAD`)
     and what changed, and wait for them to confirm before landing.
   - If you are landing a Low-risk change without the user, land it only if this ship-check still reports
     `waits_for_user` null. A commit added since (a fix for CI, say) can raise the tier, and then the change waits:
     report the PR URL, the new `tier` and `waits_for_user`, and stop as in step 6.
   - If ship-check lists `high_files`, a merge the user authorized before seeing the PR is not enough. "Some
     paths always need a person." Name the files and wait for the user to say they have read them.
   - Land only when ship-check reports no problems.

   A review round here appends to the tracked ledger, so if `git status --short .review` shows changes, commit them
   as their own `Update review ledger` commit, staging only the ledger files as in step 2, push it (`git push` if
   the branch was pushed), and wait for CI again (step 6). A ledger-only commit is bookkeeping: ship-check ignores
   `.review/` changes when it decides whether there are changes since the review, so the approved code is
   unchanged.

8. **Land it**, using `merge` from the ship-check output. Run each command separately.
   - `rebase` (the default): `git switch <default>`, then `git merge --ff-only <branch>`, then `git push`. On GitHub
     this marks the PR as merged and keeps the exact commits, so the fix commits recorded in the ledger stay valid.
     Before `git switch <default>`, run `git status --short` (it must be empty, with no exceptions) and `git rev-parse <default>`, and
     note the commit. If the push is rejected for any reason other than branch protection, stop and report. If it
     is rejected because the branch is protected, put local `<default>` back without `reset --hard`: `git switch
     <branch>`, then `git branch -f <default> <noted commit>`, then `gh pr merge <branch> --rebase`, then `git switch
     <default>`, then `git pull --ff-only`. This fallback rewrites the SHAs on GitHub, so the ledger's fix-commit
     SHAs refer to the branch's commits, not the landed ones.
   - `squash`: on GitHub, `gh pr merge <branch> --squash`, then `git switch <default>`, then `git pull --ff-only`.
     Without GitHub: `git switch <default>`, then `git merge --squash <branch>`, then `git commit` with one message
     that summarizes the units.
   - `merge`: on GitHub, `gh pr merge <branch> --merge`, then `git switch <default>`, then `git pull --ff-only`.
     Without GitHub: `git switch <default>`, then `git merge --no-ff <branch>`.
   Without GitHub, push the default branch afterwards if it has an upstream.

   **From a worktree.** If ship-check's `default_worktree` is set or `linked_worktree` is true, never check
   `<default>` out here. Another worktree holds it, so `git switch` fails, or this worktree would hold it and keep
   the main checkout from switching to it. Land without it instead:
   - `rebase`: run `git status --short` (it must be empty), then, if `upstream` is set,
     `git push origin '<branch>:<default>'`. The remote takes only a fast-forward, so this keeps the exact commits
     like the push above. If it is rejected because the branch is protected, run `gh pr merge <branch> --rebase`
     (with the same SHA caveat); if it is rejected for any other reason, stop and report.
   - `squash` or `merge` on GitHub: the `gh pr merge` command above, without the `git switch` and `git pull`.
   - `squash` or `merge` without GitHub needs a checkout of `<default>` to commit in: stop, and tell the user to
     run ship from the checkout at `default_worktree` (or from the main checkout).

   Then catch the local `<default>` up to what landed, which is `origin/<default>`, or `<branch>` with no upstream:
   - If `default_worktree` is null, run `git fetch origin '<default>:<default>'`, or `git fetch . '<branch>:<default>'`
     with no upstream. Git takes only a fast-forward.
   - If `default_worktree` is set, that is the user's checkout. With an upstream, run `git fetch` first. Then run
     `git -C '<default_worktree>' status --short`. If it is empty, run
     `git -C '<default_worktree>' merge --ff-only '<landed>'`. If it isn't empty, don't touch that checkout: give the
     user the command to run there, and say why. If the command is refused (a worktree-isolated session can't run
     git in another checkout), step 9 runs it after leaving the worktree.

9. **Clean up.** If you landed from a worktree (step 8), the branch is still checked out here, so first run
   `git switch --detach '<landed>'` (what landed, as in step 8, since the local `<default>` may not have been caught
   up). Delete the local branch with `git branch -d <branch>`. After a squash landing the branch tip is not
   an ancestor of the squash commit, so `-d` refuses. Once you have confirmed the squash commit is on the default
   branch, use `git branch -D <branch>` instead. If the branch was pushed, run `git push origin --delete <branch>`
   (it may already be gone if GitHub deleted it).

   Then leave the tree clean: the user should see nothing uncommitted after a ship. Run `git status --short`. If
   only `.review/` ledger files show changes (written after the branch's last ledger commit), commit them on
   `<default>` as their own `Update review ledger` commit, staging only the ledger files as in step 2, and push it if
   `<default>` has an upstream. A ledger-only commit is bookkeeping, so it needs no review round. If you landed
   from a worktree, you can't commit on `<default>` here: on GitHub, take the `chore/review-ledger` route below from
   the detached HEAD, skipping `git branch -f`. Once its PR has merged, in place of its `git switch <default>` and
   `git pull --ff-only`, catch `<default>` up as in step 8, run `git fetch`, and run `git switch --detach 'origin/<default>'` (the local
   `<default>` may be stale), then delete the branch as the route says. Without GitHub, tell the user. If the push is
   rejected because the branch is protected, move the commit to a branch instead: `git switch -c chore/review-ledger`,
   then `git branch -f <default> origin/<default>`, then `git push -u origin chore/review-ledger`, then
   `gh pr create --base <default> --head chore/review-ledger --title 'Update review ledger' --body 'Ledger-only bookkeeping.'`,
   then `gh pr checks chore/review-ledger --watch`, in the background as in step 6 (continue if it reports no
   checks), then
   `gh pr merge chore/review-ledger --rebase --delete-branch`. If a check fails or the merge is refused, stop, keep
   the branch, and give the user the PR URL. Once the PR has merged, run `git switch <default>`, then
   `git pull --ff-only`, then `git branch -D chore/review-ledger` only if the branch still exists
   (`--delete-branch` may already have switched to `<default>` and deleted it, which is not a failure). If anything outside `.review/` is uncommitted,
   don't touch it: tell the user.

   Last, if you landed from a worktree under `.claude/worktrees/`, remove it, so a finished branch leaves nothing
   behind:
   - If this session entered it with EnterWorktree, run ExitWorktree with `keep`. That returns the session to the
     checkout it started in and doesn't delete a worktree entered by path. Then run
     `git worktree remove '<worktree path>'`. Git refuses while anything uncommitted is left in it: then keep it and
     tell the user what is there.
   - If step 8 couldn't catch up the checkout at `default_worktree` because the command was refused, and the session
     is now in that checkout, run `git status --short`. If it is empty, run `git merge --ff-only 'origin/<default>'`
     (`'<landed>'` with no upstream).
   - If this session started inside the worktree (ExitWorktree says no worktree session is active), leave it detached
     and give the user the `git worktree remove` command.

   Report the PR URL, the commits that landed, the check results, and the new HEAD, confirm the tree is clean, and
   say which branch each remaining checkout is on. If it landed without the user, say so first: it was Low risk, and
   which files made it so.
