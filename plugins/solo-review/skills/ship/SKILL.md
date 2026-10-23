---
name: ship
description: Open a GitHub pull request for the reviewed change. Commits what's left, moves work off the default branch, rebases onto the latest default branch, reruns the check, opens the PR from the repo's template with the review results, and watches CI. Merges only when the user says to. Run it when the user asks to ship, open a PR, or merge.
argument-hint: "[merge] [--skip-review]"
allowed-tools: Read, Grep, Write, Agent, Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py *), Bash(git status *), Bash(git diff *), Bash(git log *), Bash(git add *), Bash(git commit *), Bash(git fetch *), Bash(git rebase *), Bash(git switch *), Bash(git branch *), Bash(git push *), Bash(git pull *), Bash(git rev-parse *), Bash(gh pr *), Bash(gh run view *)
---

# solo-review: ship

This is the solo version of the article's merge path.
- The change is re-checked on the latest default branch, so two changes that each passed can't combine into a
  broken main.
- It lands through a pull request, so CI runs on it and the review results stay with it.
- Opening the PR is automatic. The merge is the user's call: they read the evidence and own what ships.

`L` means `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py`.
- Run each command as its own Bash call, never chained with `;`, `&&` or a pipe.
- Single-quote every branch name you put in a command.

Arguments: `$ARGUMENTS`

## Open the PR
1. **Ready?** Run `L ship-check`, which prints JSON.
   - Stop if `github` or `gh` is false: ship opens GitHub PRs, and this repo has no GitHub `origin` or the `gh` CLI
     is missing. Say which.
   - Stop if `origin_default` is null: the default branch was never pushed. Tell the user to push it first.
   - Stop on any other problem except the review ones, which step 4 handles.
2. **Commit what's left.** If `uncommitted` lists files, commit them as logical units following
   `/solo-review:commit`, on the current branch.
3. **Get off the default branch.** If `on_default` is true:
   - Name a branch for the change, `<type>/<short-name>` (feat, fix, refactor, docs or chore).
   - Run `git switch -c '<branch>'`, then `git branch -f '<default>' '<origin_default>'`. The commits stay on the
     new branch, and the local default branch goes back to origin's.
   - Run `L ship-check` again. The review done on the default branch still counts, since it is matched by content.
4. **Review state.**
   - `reviewed` is `never` or `stale`: stop, say what is unreviewed (`changed_since_review`), and suggest
     `/solo-review:review`. With `--skip-review`, go on, and say "Not reviewed" in the PR's Review section.
   - `open_important` is not empty: stop, list them, and point to `/solo-review:review open` to fix or answer them.
   - `open_nits` is not empty: ask once whether to fix them first (as `/solo-review:review` does) or ship as-is. As-is
     means running `L resolve <ids> --as merged-past --by user --reason "shipped as is"`.
5. **Catch up.** Run `git fetch origin`, then `git rebase '<origin_default>'`.
   - Resolve a conflict about text so that both sides' intent survives, then `git add -- <files>` and
     `git rebase --continue`.
   - If a conflict is about intent, stop and ask the user (`git rebase --abort` backs out).
   - Run `L ship-check` again. `reviewed` should be `current` or `rebased`. If it says `stale`, the conflict fixes
     changed the code: say so, and offer one `/solo-review:review quick` round over them before going on.
6. **Check on top of the latest default branch.** Run `L check`, then run the command it prints as its own Bash call.
   - If it fails, stop, show the failing output, and offer a `solo-review:fixer`. Commit its fix and check again.
     Never open a PR on a red check.
   - Keep the command and a trimmed copy of its real output for the Testing section.
7. **Push and open the PR.**
   - Run `git push -u origin '<branch>'`, or `git push --force-with-lease origin '<branch>'` if the branch was
     pushed before the rebase.
   - Build the body from `pr_template`. If that is null, use `${CLAUDE_PLUGIN_ROOT}/templates/pull_request_template.md`
     and suggest `/solo-review:setup` to add it to the repo.
   - Keep the template's headings and order, and replace each comment with real content:
     - **What and why**: two or three sentences.
     - **Testing**: the check command and its trimmed output from step 6. Say that CI results are on the PR.
     - **Risk**: first line `Risk: <High|Medium|Low>.`, from `tier`, plus what set it: the `high_files`, "docs only",
       or "code, no High-risk paths". Then what could break, and specifically what the review and the check would
       not catch in this change (a path no test covers, behavior only a person can judge). Mention `security_hint`
       if it is true.
     - **How to revert**: `git revert` of the merge or of each commit, and anything a revert won't undo.
     - **Review**: the output of `L pr-summary --run <review_run>`, unchanged. Use "Not reviewed (shipped with
       --skip-review)" if that applies.
   - Leave the sign-off box unticked. Only the user ticks it.
   - Fill a repo's own template's sections in the same spirit.
   - Write the body to `.solo-review/pr-body.md` with the Write tool.
   - Run `gh pr view '<branch>' --json url`. If a PR exists, run
     `gh pr edit '<branch>' --body-file .solo-review/pr-body.md`. Otherwise run
     `gh pr create --base '<default>' --head '<branch>' --title '<one-line summary>' --body-file .solo-review/pr-body.md`.
     Keep the title single-quoted, writing any `'` inside it as `'\''`.
8. **Watch CI.** Run `gh pr checks '<branch>' --watch` with the Bash tool's `run_in_background`, and wait until you
   are told it finished. No checks is fine. If a check fails, read its log
   (`gh run view <id> --log-failed`), summarize it, and offer a `solo-review:fixer`. Never merge a red PR.
9. **Hand over.** Report:
   - the PR URL, the risk tier, CI's result, and the head commit (`head`, short)
   - for High risk, the `high_files` to read themselves before merging
   - any open nits

   Then say: tick the sign-off box in the PR, or tell me you've read it, and say merge. Stop here.

## Merge (only on `merge`, or when the user says to merge)
1. Run `L ship-check`. If `head` differs from the commit you reported, show `git log --oneline <reported>..<head>` and
   ask the user to confirm: an approval covers one specific commit.
2. Run `gh pr view '<branch>' --json body`. If the sign-off box is unticked, ask the user to confirm they read the
   evidence. Once they confirm, tick it in the body, with " (signed off in chat)" after it, and update the PR as in
   step 7. For High risk, the user must also say they read the `high_files`.
3. Run `gh pr merge '<branch>' --<merge> --delete-branch --match-head-commit <head>`, with `merge` from ship-check
   (rebase, squash or merge).
4. Run `git switch '<default>'`, then `git pull --ff-only`. If `git branch --list '<branch>'` still shows the branch,
   run `git branch -D '<branch>'`; it is merged on GitHub.
5. Report what landed, and that the local default branch is up to date.
