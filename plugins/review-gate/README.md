# review-gate

Reviews a branch before its pull request, and opens or merges the pull request only once the review passes. The review is Claude Code's own `/code-review`: review-gate runs it, keeps what it finds in a record for the branch, and holds the pull request until every finding is answered. It follows [How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/): agents do most of the reading, every finding gets an answer, review stops when it no longer converges, and a person approves the changes that carry the most risk.

## How a review runs

Claude calls the `review` tool once a change is committed and its checks pass. The tool compares the branch with the default branch (origin's copy where there is one), judges the change's risk, and runs `/code-review` through the Skill tool at the level that risk calls for. It adds a section to the skill's prompt that gives the round's scope and lists the findings the branch has had, marking the open ones to look at again. The section tells the review to hand its findings to the plugin's `record` tool before it writes its answer. The record tool takes them only from that review, for that round, once. Only Claude Code's own `/code-review` counts: a project's or a person's skill of the same name, which a branch could add, is told to stop, and the round refuses it.

When the Skill tool runs the review in the background, the round is done when the review has recorded its findings through `record`. The round then stops it, with any agents it started, so none runs on unseen. A review that ends without recording is caught through the agent list: one listed as ended, or one left idle with nothing of its own at work for five minutes. The wait is that long because an idle review may only be waiting on a background agent or shell to wake it.

Each finding the review reports becomes `R<round>-<n>` in the branch's record, graded from what the review said. It is a security finding when it lets someone do what they should not, pre-existing when the defect was there before the branch, a nit when the review files it as cleanup (reuse, simplification, efficiency), and important otherwise. A finding the branch has had, in any state, is never raised again. A branch raises at most three nits over all its rounds: each one needs an answer before the pull request, and an agent answers a nit by fixing it, which costs a commit and another round. The review is told how many nits the branch has left, and a round says how many it left out.

The first round reads the whole branch. Later rounds read only the commits since the last one. A rebase, an amend or a merge of the default branch sends the round back over the whole branch. The review looks again at every open finding, since a fix may sit in another file. Those it finds fixed are closed. After three rounds in a row end with findings open, the tool refuses a fourth and tells Claude to step back and talk to you.

Every finding needs an answer. Claude fixes it and commits, and the next round confirms the fix; or it dismisses the finding with a reason through the `dismiss` tool, and the reason shows in the card. The review itself changes no file.

The review works as `/code-review` does when you run it yourself: with the session's tools and permission mode, so `max` hands its angles to agents of their own, and a review may run a test to check a finding. A command that leaves a file changed, such as a test that writes a snapshot git does not ignore, makes the round record nothing, as the rules below say. review-gate adds only what it needs to keep the record: the round's section in the prompt, the `record` tool, and the checks below. A branch may be someone else's, such as a pull request checked out to review it; review code you do not trust in a permission mode that asks before commands run, or in a sandbox, as you would with `/code-review`.

A round reviews one commit. It refuses to start while files have changes the commit does not hold, new files included. It records nothing if HEAD moves or a file changes while it runs: the review may have read the change, and the record would vouch for a commit the review did not read.

## Risk

Before each round a classifier reads the branch's whole diff, files REVIEW.md skips included, and judges its risk from the code, not from a list of paths. Low is a change where nothing that runs can break, such as docs or tests alone. Medium is an ordinary change to behaviour. High is code where a missed defect could do lasting harm: code that decides what may run or who may act, runs commands or reads outside input, handles secrets, deletes or migrates data, or changes how the project is built, released or installed. The classifier gives its reasons, and a security finding that is not fixed also makes a change high risk. If it gives no verdict after two tries, the change counts as high. A commit judged once keeps its verdict.

Risk picks the level: `medium` for low, `high` for medium, and `xhigh` for high. A round over new commits alone runs at most at `high`, unless the `review` call or `/review-gate` names its level.

## Pull requests

Claude opens and merges pull requests through the `pull_request` tool. `open` pushes the reviewed commit to the branch on origin, by its id, sets the branch to track origin's copy, and runs `gh pr create`. When the branch has a pull request open already, the push brings it up to the reviewed commit, and `open` says so. `merge` runs `gh pr merge` with `--match-head-commit`, so gh refuses if the pull request's head moves away from the reviewed commit. Both are refused until that commit has been reviewed and no finding is open. A review covers one commit, so a commit made after it needs a round of its own.

For a high-risk change, the tool asks you in Claude Code's question dialog to approve that commit before its pull request is opened or merged. Claude cannot answer the dialog, and the approval holds for that commit alone.

A shell command that runs `gh pr create`, `gh pr new` or `gh pr merge` is refused and sent to the tool, and so is a `gh api` call that opens or merges a pull request: a POST to `pulls`, a call to a pull request's `merge`, or a GraphQL mutation that creates, merges or queues one. The match reads the command's text with continued lines joined, so `env`, `bash -c`, `eval`, `xargs` and a variable holding `gh` do not hide the call. Only flags, such as `-R owner/repo`, may come between `pr` and its verb, so `gh pr view 12 | grep new` and `gh pr checkout 12 && git merge main` run. A commit message that only mentions those words is passed from a file (`git commit -F FILE`).

## Cost and time

- The review runs on the session's model, as `/code-review` does, and the risk classifier on Haiku unless `/config` says otherwise.
- A round is one review agent, so it costs about what `/code-review` at that level costs on its own, plus the classifier's few thousand tokens. Later rounds read only the new commits, so they cost less.
- Each round records how long it took and the review's tool calls. The card shows them.

## In the terminal

While a round runs, the band above the prompt shows it:

```
review · round 2 · /code-review high · 3m 10s · 1 of 3 left after this
  ● 31 calls · reading src/app.ts   [ watch ]
```

The second line is the review's agent: its tool calls so far, and what it is doing now. `watch` opens its transcript. When the last round left findings open, or a finding is open now, the first line also counts the rounds the cap leaves after this one (`last round before the cap` when this round's result decides whether the next may run, `past the cap` when you ran it past the cap), so you can see how deep a loop of fix and review has gone.

Between rounds the band says where the branch stands: findings open, commits not reviewed yet, or a commit ready for its pull request, with a note when it waits for your approval. While findings are open, it ends with the rounds the cap leaves, such as `2 of 3 rounds left`, and the round's result tells Claude the same. A review's row in the chat draws as a card that lists each finding with its grade, place and the review's category for it; fixed ones are ticked, and dismissed ones show their reason. ctrl+o shows the text Claude read. The round's result ends by asking Claude to suggest, for each open finding, whether to fix it and how or dismiss it and why.

When the review ran in the background, the engine sends a notice of its end, which would hand Claude `/code-review`'s raw report a second time. review-gate puts the round's word in place of the report and draws the notice's row as one dim line, `review-gate · round 2 recorded`. When Claude ran the round, the notice tells it only that, and a notice that comes once its turn has ended is dropped rather than start an empty one. When you ran `/review-gate`, the notice carries the round's result, so Claude follows up with its suggestions; a review that ran in the foreground sends no notice, so the command's output carries the same request for Claude's next turn.

- `/review-gate` runs a round now. `/review-gate low`, `medium`, `high`, `xhigh` or `max` picks its level. Add `--max-findings <n|all|default>` to pass `/code-review` its limit for that round. Your run goes past the cap and reviews a commit again.
- A pull request's number is not a target: the gate reviews the branch checked out, so run `gh pr checkout <n>` first. `--comment` is not passed, since the review runs before the pull request exists, and neither is `--fix`: Claude fixes findings and commits, and the next round confirms each fix.
- `/review-gate status` shows the latest round.
- `/review-gate more` allows three more rounds after the cap.
- `/review-gate reset` forgets the branch's record.

## REVIEW.md

A REVIEW.md at the root, or in any folder above a changed file, goes to the review and to the risk classifier. It is read as it stands where the branch forked from the default branch, so a branch cannot loosen its own review. Say what a defect looks like in that code. A Skip heading is read as a list of globs, written as in .gitignore and relative to the file's folder, for files the review leaves out, and a finding the review reports in such a file is left out too. When every file a round covers is skipped, no review runs, unless the branch has open findings: a fix may sit in a skipped file, so the review still looks at them again.

```markdown
## Skip
- `*.lock`
- `generated/`
```

## Where the record lives

Each branch's record of rounds, findings, answers and your approval is kept in the plugin's own store, outside the repository, so it lasts across sessions and is never committed. A record goes when its branch is deleted. A branch deleted and made again under the same name before the band looks at git keeps the old record: `/review-gate reset` clears it. A record from version 0.1, whose rounds ran review-gate's own reviewer agents, reads as none, so its branch is reviewed again.

## Options

In `/config`:

- **Review level** is `auto` by default, which picks by risk, or one of `low`, `medium`, `high`, `xhigh` or `max`. A round over new commits alone still runs at most at `high`.
- **Risk model** is `haiku` by default; `inherit` uses the session's model.

## Limits

- A round runs one `/code-review` agent and one completion for the risk.
- The record depends on the review calling the `record` tool as the added section asks. A review that ends without doing so records no round, and Claude reviews again.
- A review reports at most what its level allows, 10 findings at `high`. Run `/review-gate` with `--max-findings all` to see every one.
- The gate sees pull requests that a Claude Code session opens or merges. One opened on github.com, or from another shell, does not pass through it.
- The record belongs to one machine; another clone or machine starts with none.
- It guards a workflow and is not a sandbox. The match does not read a script file run by name, and a model that sets out to hide a gh command from it, or to forge the plugin's store, can.
- It needs git, gh, and the `sleep` command. Windows is not supported.

The article's other layers, a merge queue, feature flags, staged releases and an eval built from past incidents, belong to CI and release tooling, so this mod leaves them out.

## Install

At the prompt of a terminal session:

```
/plugin install review-gate --marketplace astrosteveo/astro-plugins
```

## Test

```
claude plugin validate plugins/review-gate
claude plugin test plugins/review-gate
```
