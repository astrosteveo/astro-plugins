---
name: review
description: Review the current change and fix what the review finds, by itself, in rounds of fresh-context agents (find, verify, fix, re-review) until a round is clean or three rounds have run. Records every finding and outcome in the project's review ledger. Run it whenever a task is finished, before opening a PR.
argument-hint: "[quick|standard|deep] [--base REF | --range A..B] [--force | --until-clean] [--fresh] | resolve <ids> <outcome> [reason] | open | backlog"
disallowed-tools: AskUserQuestion
allowed-tools: Read, Grep, Write, Agent, mcp__solo-review__record, mcp__solo-review__check_record, mcp__solo-review__resolve, Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py *), Bash(git switch *), Bash(git branch *), Bash(git rev-parse *), Bash(git log *), Bash(git status *), Bash(git diff *), Bash(git add *), Bash(git commit *)
---

# solo-review: review

A solo developer has no second reviewer, so fresh-context agents review and fix. This skill runs the whole loop by
itself: finders look for defects, verifiers try to refute them, a fixer fixes what survives, and the next round
re-reviews what changed. The developer comes in only when the loop can't finish, and reads the evidence in the PR.
Every finding and outcome goes into the ledger, which `/solo-review:review-learn` uses to tune REVIEW.md.

`L` means `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py`, run from the project (it finds the repo root).
- Run each command on its own, never chained with `;`, `&&`, or pipes: a chained command needs approval for every
  part, and gets blocked.
- Look at files with Read and Grep, not `cat` or `grep`.

The ledger tools `mcp__solo-review__record`, `mcp__solo-review__check_record` and `mcp__solo-review__resolve` (from the
plugin's hooks module) record a round, a check result and an outcome from typed input, with no temp file and nothing on
a command line. If they aren't in your tool list (the module didn't load), use the `L` command each step gives instead.

Arguments: `$ARGUMENTS`

## Subcommands
- `open`: run `L open` and show the output. Stop.
- `backlog`: run `L backlog` and show the deferred pre-existing findings. Stop.
- `resolve <ids> <outcome> [reason]`: call `resolve` with those `ids`, `outcome` and `reason`, and `by: "user"`
  (without the tool: `L resolve <ids> --as <outcome> --reason "<reason>"`). Stop.
- `init`: setup is `/solo-review:setup` now. Tell the user to run it, and stop.
- Anything else runs a review.

## Review
First work out a 1 to 3 sentence INTENT for the agents' prompts: what the change does, and anything deliberately
unusual about it. Take it from this conversation, or from `git log --format=%s <base>..` if the conversation doesn't
say. The change is already made, so describe it in the present tense, drafts included ("Adds X so that Y"), never as
a plan ("I'll add X"): the user may see your reasoning, and a plan there reads as work still to come.

A cycle is one review-and-fix loop. It ends on a clean round, and new work other than fix commits starts a new cycle
at round 1, so the round cap applies to fixes that don't converge, not to new features. Run rounds until one is clean
or the cap stops you. Each round:

1. **Scope.** Run `L scope`. In the first round only, pass on what the user gave: `--depth <d>`, `--base`, `--range`,
   `--force` (one round past the cap), `--until-clean` (no cap for the rest of the cycle; scope remembers it), or
   `--fresh` (review the whole change again, not only what changed since the last round). It prints JSON. If `stop`
   is true, go to **Finish** with its `message`. Don't read the diff yourself; the agents do. After the first round,
   the scope is only what changed since the last reviewed snapshot.

2. **Find.** Launch the finders (`subagent_type: "solo-review:finder"`) in parallel, in one message. Each prompt has
   `LENS: <lens>`, `INTENT`, `SCOPE:` (the scope JSON's diff_cmd, change_diff_cmd, read_files, files, review_md,
   checklist, claude_md, the lens's entry in min_tool_uses as `min_tool_uses`, security flag, and security_hint),
   `PRIOR:` (prior_findings, one per line), and
   `MAX_NITS: <max_nits>`.
   Each finder returns `checked` (what it found for each checklist line), `read` (the files it read beyond the
   diff), and `findings`.
   - quick: one finder, lens `all`.
   - standard and deep: lenses `change` and `system`, plus `security` if the scope's security flag is true. Scope
     sets it whenever a High-risk path is touched, whatever REVIEW.md's `security` says.

   At standard and deep depth, an empty `findings` is suspect when `checked` has fewer entries than `checklist`,
   `read` names no file the finder read (a grep or a diff hunk doesn't count), or the Agent result shows fewer tool
   uses than the lens's entry in the scope's `min_tool_uses` (the diff, REVIEW.md, and one changed file; subagents
   already have the root CLAUDE.md). The `security` lens when `security_hint` is false is the exception: with no sink
   in the added lines it has nothing to read, so its floor is the diff and REVIEW.md, and an empty `read` is not
   suspect. Launch a suspect lens once more, at most once per round, with the same prompt plus a `RETRY:` line that
   names each gap in numbers and paths, never just "be thorough":
   - the checklist numbers missing from `checked`;
   - the tool uses the first pass made, and the lens's `min_tool_uses`;
   - the changed files (from `files`) that `read` doesn't name, to read whole (not for that `security` exception).
   Use the second result, judged by the same test. If it is suspect too, list the lens in `thin` in step 4.

3. **Verify.** Merge the finders' `findings` into one numbered candidate list and drop exact duplicates. Each verifier
   (`subagent_type: "solo-review:verifier"`) prompt has `SCOPE:` (the finders' block), `CANDIDATES:` (the list), and
   `RECHECK:` (the scope's open_to_recheck).
   - In CANDIDATES, give each candidate only `n`, file, line, severity, category, and title. Leave out `evidence`
     and `fix`: a verifier that reads the finder's argument checks the argument, not the code, and repeats its
     misreadings. Keep the full fields for recording in step 4.
   - quick: keep only `important` candidates. If any are left or RECHECK has items, launch one verifier. A
     candidate survives if voted real and still `important`, since quick rounds report Important findings only. A
     small change can still bring a false alarm, and the fixer would act on it. A quick round with no candidates
     and nothing to recheck launches no verifier.
   - standard: one verifier. A candidate survives if voted real; use the verifier's severity.
   - deep: three verifiers in parallel with the same prompt and `model: "sonnet"`. A candidate survives with 2 or 3
     real votes; use the most common severity, and record `votes` as `"2/3"` or `"3/3"`.
   - No candidates and no RECHECK items: skip verification.

   Then keep at most max_nits nits and 2 pre-existing findings.

4. **Check, then record.**
   - Run `L check`. It only prints REVIEW.md's `check` command. If it says none is configured, skip to recording.
   - Run that command yourself, as its own Bash call. It asks the user's permission unless they allowed it, by
     design: the command comes from the repo.
   - Call `check_record` with its exit `status` and a one-line `summary` of its output. A failing check is not a
     finding; report it in **Finish**. Without the tool: write the summary to `.review/.check.txt` with the Write
     tool, then run `L check --record --status <exit code> --file .review/.check.txt`. Never put the summary on a
     command line, because the repo controls that output.
   - Call `record` with this input:
     ```
     {"candidates": <count before verification>, "findings": [<surviving findings, same fields as the finders'>],
      "resolved_by_change": [<RECHECK ids voted present:false>],
      "nits_found": <nits among the survivors before the nit cap>, "rejected": <candidates voted false>,
      "rejected_guide": <false votes marked "guide": true>, "thin": [<lenses still suspect after their retry>]}
     ```
     Give each surviving finding a `verified` field: the `why` of a vote that called it real, so the PR shows the
     path the verifier traced as well as the finder's evidence. Without the tool: write that JSON to
     `.review/.record.json` with the Write tool, then run `L record --file .review/.record.json` (it deletes the
     file after reading it).
   - `record` prints the round's summary. If it recorded no Important findings and no nits, the round is clean: defer
     any pre-existing findings as in step 5, without a fixer, and go to **Finish**.

5. **Fix.** Never fix anything yourself: your context holds the assumptions that produced these bugs.
   - Pre-existing findings are not fixed in this loop; old code is what kept review from converging. Call `resolve`
     with their `ids`, `outcome: "deferred"`, `by: "agent"` and `reason: "pre-existing; outside this change"` (without
     the tool: `L resolve <ids> --as deferred --by agent --reason "pre-existing; outside this change"`). They stay in
     `L backlog`.
   - Launch one `solo-review:fixer` with:
     - `INTENT`.
     - `FINDINGS`: every Important finding and nit from this round, plus the "Still open from earlier rounds" that
       `record` printed (each with id, file, line, severity and fix). Nits are fixed too: an open nit blocks the
       merge like any other finding.
     - `CHECK`: exactly `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py check`. The fixer runs the command it
       prints. Don't record its result: `record` already closed this round, and the next round's step 4 runs and
       records the check again.
   - Commit its changes as one commit, following `/solo-review:commit`, with the subject `Fix review findings F-1, F-4`
     (`Fix review finding F-1` for one).
     Leave `.review/` out; ship commits the ledger. Then call `resolve` with the `ids` it fixed, `outcome: "fixed"`,
     `by: "agent"` and `commit: "<sha>"` (without the tool: `L resolve <ids> --as fixed --by agent --commit <sha>`).
   - Findings it returns as `not_fixed` stay open and block ship. If it fixed nothing, go to **Finish**; otherwise
     start the next round.

## Finish
Send the user one message:
- The rounds run, the findings fixed (one line per id), and the last check result.
- Every Important finding and nit still open on this branch (run `L open`), each with the fixer's reason if it gave
  one, and a recommended answer: a fix to send to a fixer, or an outcome with a reason. These are the only decisions
  the loop leaves to the user.
- If the round cap stopped the loop: the scope JSON's `summary` unchanged, in a code block, then one line naming the
  problem that kept coming back, and one recommendation (rethink the approach if the same problem keeps returning,
  or else the shortcut that fits best). Then wait for the user; don't ship.
- If `record` reported thin lenses, name them and say the round covered less than its result shows.
- If the last round was clean and nothing is open, say so. When this review finishes a task, run `L config`: with
  `workflow: auto`, go on to `/solo-review:ship`; with `manual`, say the branch is ready for `/solo-review:ship` and
  stop, since the user asks for ship themselves.

When the user answers an open finding, call `resolve` with its `ids`, the `outcome`, their `reason` and `by: "user"`
(without the tool: `L resolve <ids> --as <outcome> --reason "..." --by user`), and send any fix they want to a fixer
as in step 5.

## Rules
- Never record `wrong`, `intentional`, `wontfix`, or `merged-past` on your own judgment. Apart from the pre-existing
  rule in step 5, a finding closes only by a fix, by a later round finding it gone, or by the user.
- Style and cleanup are dropped on purpose; `/simplify` handles them separately.
- With `gate: push` in REVIEW.md, pushing is blocked while any finding is open, nits included.
