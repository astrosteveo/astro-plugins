---
name: review-learn
description: Tune this project's REVIEW.md from the review ledger. Log a bug that slipped past review, replay past escapes as evals, or propose evidence-backed edits to the review guide.
argument-hint: "[escape <fix-commit> [summary] | eval [N] [--clean M] | spotcheck [N]]"
disable-model-invocation: true
allowed-tools: Read, Grep, Edit, Agent, mcp__solo-review__resolve, Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py *), Bash(git log *), Bash(git show *), Bash(git blame *), Bash(git switch *), Bash(git rev-parse *)
---

# solo-review: learn

The review ledger records what the reviewer flagged and what the developer did about it. This skill turns that
record into changes to REVIEW.md, and checks whether those changes helped. Priorities, in order: catch real bugs,
then cut noise and review rounds.

`L` below means `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py`. Run each command on its own, never chained with `;`, `&&`, or pipes. A chained command needs approval for
every part, and gets blocked. Use Read and Grep to look at files, not `cat` or `grep`.

Edits to REVIEW.md or CLAUDE.md go on a branch, since the branch guard blocks edits on the default branch. Before the
first edit, if the session is on the default branch, run `git switch -c chore/review-tuning` (another name if that
branch exists). A kept edit then goes through the session's usual workflow: commit, review, and ship.

Arguments: `$ARGUMENTS`

## `escape <fix-commit> [summary]`: a bug got past review
1. Run `git show --stat <fix-commit>` and `git show <fix-commit>` to see what was fixed. Find the commit that
   introduced the bug with `git blame <fix-commit>^ -L <start>,<end> -- <file>` on the lines the fix changed.
2. Run `L reasons --outcomes wrong,intentional,wontfix,merged-past` and `L open --all`. Check whether an earlier finding flagged
   this bug in the same file.
3. Confirm the one-line summary and the introducing commit with the user. Then run
   `L escape --commit <sha> --fix <fix-commit> --file <file> --summary "..." [--finding F-n]`.
4. Propose one line for REVIEW.md "Always check" that would have caught it, phrased as a bug class rather than this
   one instance. If the bug class can be prevented at the source, say how: a test, a type, a lint rule, or a
   CLAUDE.md convention. Prefer that to a review rule. Apply the change only with the user's approval.

## `eval [N] [--clean M]`: score the current reviewer
Escapes are the recall check: "the reviewer runs against that set". Sampled commits are the false-alarm check: "we
also run the reviewer on PRs we know are clean and count how often it reports something". `clean-sample` only knows
that a commit was never reverted or tied to an escape, not that it is bug-free, so the user labels what the reviewer
finds on one. Each case costs about three agent runs, plus a question per finding on a sampled commit, so tell the
user N, M, and the rough cost first. The defaults are N = 3 escapes, newest first, and M = 0 sampled commits.
1. Run `L evals` to list the escape cases, and `L clean-sample --n <M>` for sampled ones if M > 0.
2. For each case, run `L scope --range <commit>^..<commit> --force --depth standard`. Then run the review skill's
   find and verify steps (finder lenses `change` and `system`, one verifier). INTENT is the commit message. Do not
   record anything to the ledger.
3. An escape is caught if a surviving Important finding names the same defect in the same file. For each surviving
   Important finding on a sampled commit, show the user its file, line, title, and evidence, and ask whether it is
   real. It is a false alarm only if the user says it isn't. A real one is a bug the sample missed, not noise: leave
   it out of the false alarms, and offer to log it with `escape` once it is fixed. Report `caught/total`, the cases
   missed, the false alarms per sampled commit, and any real bugs found on them.
4. Run `L learned --eval-only --rev-before <current rev> --summary "eval only" --eval "<caught>/<total> escapes
   caught; <F> false alarms in <M> sampled"`. `--eval-only` keeps it from counting as a tuning in `L stats`.

## `spotcheck [N]`: check the agent's own decisions
Auto-fixes, and any triage done without the user, are recorded `--by agent`. That is Claude grading its own code. A
few spot-checks keep the agent honest, and keep the user from drifting into rubber-stamping.
1. Run `L spotcheck --n <N, default 3>`. It lists dismissals first, then fixes.
2. For each one, show the finding, the agent's decision, and the fix commit if there is one. Ask the user one
   question: was the finding real, and was the agent's call right?
3. Record the user's answer, even when it matches: call `mcp__solo-review__resolve` with the `ids`, the `outcome`,
   their `reason` and `by: "user"` (if the tool isn't in your tool list, run
   `L resolve <id> --as <outcome> --reason "..." --by user`). A matching answer confirms the decision; a different one
   corrects the label. `L stats` reports the agreement rate.

## Default: tune REVIEW.md
1. Gather data. Run `L stats`, `L reasons`, `L evals`, and `L config` (for the current rev). Read REVIEW.md. If
   there are agent decisions the user hasn't confirmed, run a spot-check of 3 first. It's cheap, and it makes the
   data more reliable.
2. If fewer than 10 findings have been resolved since the last tuning, say there is not enough data yet. Then only
   handle escapes, and stop.
3. Check the last tuning first. In "By REVIEW.md version", compare the newest version against the one before it. If
   useful% dropped or noise% rose, or an eval caught fewer escapes, propose reverting that edit. Keep a change only
   if the score went up.
4. Weigh the labels by who decided them. Decisions recorded `by user` are evidence. `auto` (a re-review found the
   finding gone) is good evidence the finding was real. `by agent` is weak evidence, so never base a "Don't flag"
   line on it. If spot-check agreement is below about 80%, the agents are fixing findings that weren't worth
   it. Propose "Don't flag" or "Always check" lines that would have changed those findings, and say which
   spot-checks disagreed.
   Then propose edits, each one backed by the finding ids that justify it:
   - **Noisy category or pattern** (most of its resolved findings are wrong or wontfix, and there are at least 4 of
     them): add a "Don't flag" line that names the pattern precisely. Quote from the reasons. Never mute a whole
     category that has fixed findings.
   - **Repeated `intentional`**: add an "Intentional patterns" line with the reason. If it is a project convention,
     it belongs in CLAUDE.md instead. Propose that.
   - **Repeated `fixed` in one category** (3 or more): the same bug keeps getting written. First propose preventing
     it at the source (a test, a type, a lint rule, or a CLAUDE.md convention). Add an "Always check" line only if
     nothing can enforce it.
   - **Escapes**: make sure each one has an "Always check" line that covers its class.
   - **Dismissed but real** (an escape linked to a finding resolved as wrong, wontfix, or merged-past): a reviewer finding was
     right and got waved off. Tell the user this directly. Do not add a "Don't flag" rule that would hide it.
   - **Compliance**: findings in skip paths, or runs over the nit cap, mean the guide is being ignored. Make the
     wording more concrete, or report it as a problem with the reviewer prompts.
   - **Convergence**: if many changes hit the round cap, look at what the late rounds flagged. Pre-existing or
     repeated findings point at the reviewer, not the code.
5. Keep REVIEW.md short. If its body passes about 50 lines, propose merging or deleting stale lines in the same edit.
   Short guides get followed.
6. Show the proposed diff. Apply it only after the user approves. If there are escapes, score the edit before
   keeping it: "every change to the reviewer is scored against all of it." Run `eval` on the edited REVIEW.md, with
   the same sampled commits as the last eval if it used any. Keep the edit only if no fewer escapes are caught and no
   more false alarms are raised than in the last eval (`L evals` shows it). Otherwise revert the edit and say which
   case got worse. Then run `L learned --rev-before <rev from step 1> --summary "<one line>" --eval "<score>"`.
7. If a lesson would apply to any project, rather than just this one, list it separately as a candidate change to the
   solo-review plugin's own finder or verifier prompts. Do not edit the plugin.
