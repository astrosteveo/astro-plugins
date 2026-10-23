---
name: learn
description: Make the reviewer better from its own record. Log a bug that slipped past review as an eval case, replay the eval cases to score REVIEW.md, spot-check the agents' own decisions, or propose evidence-backed edits to REVIEW.md and CLAUDE.md.
argument-hint: "[escape <fix-commit> [summary] | eval [N] [--clean M] | spotcheck [N]]"
disable-model-invocation: true
disallowed-tools: AskUserQuestion
allowed-tools: Read, Grep, Edit, Agent, Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py *), Bash(git log *), Bash(git show *), Bash(git blame *), Bash(git rev-parse *), Bash(git switch *)
---

# solo-review: learn

The ledger records what the reviewer flagged and how each finding was answered. This turns that record into changes
to REVIEW.md, and checks that they helped. Priorities, in order: catch real bugs, then cut noise and review rounds.

`L` means `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py`. Run each command as its own Bash call, never chained.
Read files with Read and Grep.

Arguments: `$ARGUMENTS`

## `escape <fix-commit> [summary]`: a bug got past review
1. Run `git show --stat <fix-commit>` and `git show <fix-commit>` to see what was fixed. Find the commit that
   introduced it with `git blame <fix-commit>^ -L <start>,<end> -- <file>` on the lines the fix changed.
2. Run `L reasons --outcomes wrong,intentional,wontfix,merged-past` and `L open --all`, and check whether a finding
   flagged this bug in the same file.
3. Confirm the one-line summary and the introducing commit with the user, then run
   `L escape --commit <sha> --fix <fix-commit> --file <file> --summary "<summary>"`, adding `--finding F-<n>` if one
   flagged it.
4. Propose one "Always check" line for REVIEW.md that would have caught it, phrased as a bug class rather than this
   instance. If the class can be prevented at the source, by a test, a type, a lint rule or a CLAUDE.md convention,
   propose that first. Apply only what the user approves.

## `eval [N] [--clean M]`: score the current reviewer
- **Escapes are the recall check.** The article: "the reviewer runs against that set".
- **Sampled commits are the false-alarm check.** The article: "we also run the reviewer on PRs we know are clean and
  count how often it reports something". `clean-sample` only knows a commit was never reverted or tied to an escape,
  so the user labels each finding on one.
- **Cost:** each case costs about three agent runs, plus a question per finding on a sampled commit. Tell the user N,
  M and the rough cost first. The defaults are N = 3 escapes, newest first, and M = 0.

1. Run `L evals` for the escape cases, and `L clean-sample --n <M>` if M > 0.
2. For each case, run `L scope --range <commit>^..<commit> --force --fresh --depth standard`. `--fresh` matters: an
   escape's patch was reviewed clean once, and without it scope says there's nothing new.
3. Run the review skill's find and verify steps: lenses `change` and `system`, one verifier, INTENT = the commit
   message. Record nothing.
4. Score the cases:
   - An escape is caught if a surviving Important finding names the same defect in the same file.
   - For each surviving Important finding on a sampled commit, show its file, line, title and evidence, and ask the
     user whether it is real. It is a false alarm only if they say it isn't. A real one is a bug the sample missed:
     offer to log it with `escape` once fixed.
5. Report `caught/total`, the cases missed, false alarms per sampled commit, and any real bugs found.
6. Run `L learned --eval-only --rev-before <rev from L config> --summary "eval" --eval "<caught>/<total> escapes
   caught; <F> false alarms in <M> sampled"`.

## `spotcheck [N]`: check the agents' own decisions
Fixes and deferrals recorded `--by agent` are Claude grading its own work, and spot-checks keep that honest.
1. Run `L spotcheck --n <N, default 3>`. It lists dismissals first, then fixes.
2. For each one, show the finding, the agent's decision and the fix commit, and ask one question: was the finding
   real, and was the call right?
3. Record the answer even when it matches: `L resolve <id> --as <outcome> --by user --reason "<reason>"`. `L stats`
   reports the agreement rate.

## Default: tune REVIEW.md
1. **Gather.** Run `L stats`, `L reasons`, `L evals` and `L config`, and read REVIEW.md. If agent decisions are
   unconfirmed, run a spot-check of 3 first: it is cheap and makes the data trustworthy.
2. **Enough data?** With fewer than 10 findings resolved since the last tuning, say there isn't enough data yet,
   handle any escapes, and stop.
3. **Check the last tuning.** In "By REVIEW.md version", compare the newest version with the one before. If useful%
   dropped, noise% rose, or an eval caught fewer escapes, propose reverting that edit.
4. **Propose edits**, each backed by the finding ids that justify it. Labels decided `by user` are evidence; `auto`
   (a later round found it gone) is good evidence; `by agent` is weak, so never base a "Do not report" line on it.
   - **Noisy pattern** (at least 4 resolved findings, mostly wrong or wontfix): a precise "Do not report" line,
     quoting the reasons. Never mute a whole category that has fixed findings.
   - **Repeated `intentional`**: an "Intentional" line with the reason. A project convention belongs in CLAUDE.md
     instead, so propose that.
   - **Repeated `fixed` in one category** (3 or more): the same bug keeps being written. First propose preventing it
     at the source; add an "Always check" line only if nothing can enforce it.
   - **Escapes**: each one needs an "Always check" line covering its class.
   - **Dismissed but real** (an escape linked to a finding resolved as wrong, wontfix or merged-past): tell the user
     directly that the reviewer was right. Never add a rule that would hide it.
   - **Compliance**: findings in skipped paths, or runs over the nit cap, mean the guide is being ignored. Make the
     wording more concrete.
   - **Convergence**: if many cycles hit the round cap, look at what the late rounds flagged. Pre-existing or
     repeated findings point at the reviewer, not the code.
5. **Keep it short.** If the body passes about 40 lines, merge or drop stale lines in the same edit. Short guides get
   followed.
6. **Apply and score.** Show the diff and apply it only once the user approves. If there are escapes, run `eval` on
   the edited REVIEW.md, with the same sampled commits as the last eval if it used any. Keep the edit only if it
   catches no fewer escapes and raises no more false alarms than the last eval (`L evals` shows it); otherwise revert
   it and say which case got worse. Then run `L learned --rev-before <rev from step 1> --summary "<one line>" --eval
   "<score>"`.
7. **Plugin-wide lessons.** If a lesson applies to any project, list it separately as a candidate change to
   solo-review's own finder or verifier prompts. Don't edit the plugin.

Edits to REVIEW.md and CLAUDE.md are ordinary changes: they go through review and ship like any other. Before the
first edit, run `L where`; if `on_default` is true, start a branch with `git switch -c 'chore/review-tuning'` (another
name if that one exists).
