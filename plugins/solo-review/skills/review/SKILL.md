---
name: review
description: Review the current change in fresh-context agents (find bugs, verify each one, fix the Important ones, re-review only what the fixes changed) for up to three rounds, and record every finding and how it was answered. Run it only when the user asks for a review.
argument-hint: "[quick|standard|deep] [--base REF | --range A..B] [--force] [--fresh] | open | backlog | resolve <ids> <outcome> <reason>"
disallowed-tools: AskUserQuestion
allowed-tools: Read, Grep, Glob, Write, Agent, Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py *), Bash(git status *), Bash(git diff *), Bash(git log *), Bash(git add *), Bash(git commit *), Bash(git rev-parse *), Bash(git switch *)
---

# solo-review: review

You have no second engineer, so fresh-context agents play that part. Finders look for defects. A verifier tries to
refute each one from the code alone. A fixer fixes the Important ones that survive, and the next round re-reviews
only what the fix changed. You come in when the loop can't finish, and to answer nits.

`L` means `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py`. It finds the repo root itself.
- Run each command as its own Bash call, never chained with `;`, `&&` or a pipe: chained commands lose the skill's
  permission.
- Read files with Read and Grep, not `cat` or `grep`.

Arguments: `$ARGUMENTS`

## Subcommands
- `open`: run `L open` and show the output. Stop.
- `backlog`: run `L backlog` and show the deferred pre-existing findings. Stop.
- `resolve <ids> <outcome> <reason>`: run `L resolve <ids> --as <outcome> --by user --reason "<reason>"`. Outcomes:
  fixed, wrong, intentional, wontfix, deferred, merged-past. Stop.
- Anything else runs a review, passing on `quick|standard|deep` as `--depth`, and `--base`, `--range`, `--force` and
  `--fresh` as given.

Before round 1:
- **Be on a branch.** Run `L where`. If `on_default` is true and there is work to review (`uncommitted` or `unpushed`
  above 0), start a branch named for the change first: `git switch -c '<type>/<short-name>'` (feat, fix, refactor,
  docs or chore). Uncommitted changes come with you, and commits not yet on origin count as part of the branch's
  change. The fixes get committed there, and the branch goes up as a PR: nothing reaches the default branch any other
  way. Say so in one line in **Finish**.
- **Intent.** Write a 1 to 3 sentence INTENT for the agents: what the change does, and anything deliberately unusual
  about it. Take it from this conversation, or from the commit subjects if the conversation doesn't say. Describe the
  change as done ("Adds X so that Y"), never as a plan.

## Each round
1. **Scope.** Run `L scope` with the arguments (only in round 1). It prints JSON. If `stop` is true, go to **Finish**
   with its `message`, and its `summary` in a code block if there is one. Don't read the diff yourself; the agents
   do.

2. **Check first** (round 1 only). Run `L check`. If it prints a command, run that command as its own Bash call,
   which asks the user's permission unless they allowed it (by design: the command comes from the repo).
   - If it fails, stop before any agent runs: a review of code that doesn't build or pass its tests is wasted.
     Show the failing part of the output, and offer to send it to a `solo-review:fixer`. Go on only if the user says
     to, and say in **Finish** that the check was red.
   - If `L check` says none is configured, go on, and say so in **Finish**.
   - Keep a one-line result for the record: `passed: <summary>` or `failed (exit N): <summary>`.

3. **Find.** Launch the finders (`subagent_type: "solo-review:finder"`) in parallel, in one message. Each prompt has:
   - `LENS: <lens>` and `INTENT: <intent>`
   - `SCOPE:` the scope JSON's diff_cmd, change_diff_cmd, read_files, files, review_md, checklist, claude_md and
     security_hint
   - `PRIOR:` prior_findings, one per line
   - `MAX_NITS: <max_nits>`

   Lenses by depth:
   - quick: one finder, lens `all`.
   - standard: `change` and `system`, plus `security` when the scope's `security` is true.
   - deep: `change`, `system` and `security`, each with `model: "opus"`.

   Each finder returns `checked` (what it found for each checklist line), `read` and `findings`. At standard and
   deep, a finder that returns no findings while `checked` has fewer entries than `checklist` skipped part of the
   guide. Launch it once more with the same prompt plus `RETRY: checklist lines <numbers> have no entry in checked`.
   If the second pass skips them too, list the lens under `thin` in step 5.

4. **Verify.** Merge the findings into one numbered candidate list and drop exact duplicates. Each verifier
   (`subagent_type: "solo-review:verifier"`) gets `SCOPE:` (as for the finders), `CANDIDATES:` and `RECHECK:` (the
   scope's open_to_recheck).
   - In CANDIDATES give each candidate only `n`, file, line, severity, category and title. Leave out `evidence` and
     `fix`: a verifier that reads the finder's argument checks the argument, not the code, and repeats its misreading.
     Keep the full fields for step 5.
   - quick: keep only `important` candidates. Launch one verifier if any are left or RECHECK has items.
   - standard: one verifier. A candidate survives if voted real; use the verifier's severity.
   - deep: three verifiers in parallel with the same prompt. A candidate survives with 2 or 3 real votes; use the most
     common severity, and record `votes` as `"2/3"` or `"3/3"`.
   - No candidates and nothing to recheck: skip this step.

   Keep at most max_nits nits and 2 pre-existing findings.

5. **Record.** Write this JSON to `.solo-review/record.json` with the Write tool, then run
   `L record --file .solo-review/record.json`. The script reads and deletes it, and `.solo-review/` is excluded from
   git.
   ```
   {"candidates": <count before verification>,
    "findings": [<surviving findings with the finders' fields, plus "verified": the why of a real vote, and "votes" at deep>],
    "resolved_by_change": [<RECHECK ids voted present:false>],
    "nits_found": <nits among the survivors before the cap>, "rejected": <candidates voted false>,
    "rejected_guide": <false votes marked "guide": true>, "thin": [<lenses still thin after their retry>],
    "check": "<the check's one-line result from round 1, or the fixer's from the last round>"}
   ```
   `record` prints the round. When it says the round is clean (no Important findings), go to **Finish**.

6. **Fix the Important findings.** Never fix anything yourself: your context holds the assumptions that produced
   these bugs.
   - Defer the pre-existing findings: `L resolve <ids> --as deferred --by agent --reason "pre-existing; outside this
     change"`. Old code is what kept review from converging, so they wait in `L backlog`.
   - Run `git status --short`, then launch one `solo-review:fixer` with INTENT, `FINDINGS:` (every open Important
     finding, from this round and from "Still open from earlier rounds", each with id, file, line, evidence and fix),
     and `CHECK:` (the command `L check` printed, or `none`). Nits are not sent: they wait for the user.
   - If `git status` showed a clean tree before the fixer ran, the change under review is committed, so commit the
     fix the same way. Stage the files the fixer lists with `git add -- <files>`, then commit with the subject
     `Fix review findings F-1, F-4` (`Fix review finding F-1` for one). If the tree wasn't clean, leave the fix
     uncommitted with the rest of the change.
   - Run `L resolve <ids it fixed> --as fixed --by agent`, adding `--commit <sha>` if you committed. Do this before
     the next scope: it records the tree the fix left, which is how the next round tells fixes from new work.
   - Findings the fixer returns as `not_fixed` stay open. If it fixed nothing, go to **Finish**; otherwise start the
     next round.

## Finish
Send one message:
1. A count line first: `2 Important fixed · 1 nit open · 1 pre-existing deferred`, or `Nothing to fix.`
2. The check result, or that no check is configured.
3. Every Important finding still open (`L open --important`), each with the fixer's reason if it gave one, and a
   recommended answer: a fix to send to a fixer, or an outcome with a reason.
4. Each open nit with its one-line fix. Say the user can have them fixed ("fix the nits") or answer them with
   `/solo-review:review resolve`, and that open nits don't block shipping.
5. If the round cap stopped the loop: the summary, then one line naming the problem that kept coming back, and one
   recommendation (usually: rethink the approach rather than patch again).
6. If any lens was thin, name it, and say the round covered less than its result shows.
7. If nothing Important is open, say the change is ready for `/solo-review:ship`. Never run ship yourself.

When the user answers a finding, run `L resolve <ids> --as <outcome> --by user --reason "<their reason>"`.
When they ask to fix the nits:
1. Send the nits to a fixer as in step 6, then commit and resolve them the same way.
2. Run one round with `L scope --depth quick`. It reviews only the fix, for Important findings only.
3. Finish as above.

## Rules
- Never record `wrong`, `intentional`, `wontfix` or `merged-past` on your own judgment. Apart from deferring
  pre-existing findings, a finding closes only by a fix, by a later round finding it gone, or by the user.
- Style and cleanup are left out on purpose; `/simplify` handles them.
