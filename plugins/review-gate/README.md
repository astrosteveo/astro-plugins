# review-gate

Reviews a branch before its pull request, and opens or merges the pull request only once the review passes. The review is Claude Code's own `/code-review`: review-gate runs it, keeps what it finds in a record for the branch, and holds the pull request until every finding is answered. It follows [How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/): agents do most of the reading, every finding gets an answer, review stops when it no longer converges, and a person approves the changes that carry the most risk.

## How a review runs

Claude calls the `review` tool once a change is committed and its checks pass. The tool compares the branch with the default branch (origin's copy where there is one), judges the change's risk, and runs `/code-review` through the Skill tool at the level that risk calls for. It adds a section to the skill's prompt that gives the round's scope and lists the findings the branch has had, marking the open ones to look at again. The section tells the review to hand its findings to the plugin's `record` tool before it writes its answer. The record tool takes them only from that review, for that round, once. Only Claude Code's own `/code-review` counts: a project's or a person's skill of the same name, which a branch could add, is told to stop, and the round refuses it.

Each finding the review reports becomes `R<round>-<n>` in the branch's record, graded from what the review said. It is a security finding when it lets someone do what they should not, pre-existing when the defect was there before the branch, a nit when the review files it as cleanup (reuse, simplification, efficiency), and important otherwise. A finding the branch has had, in any state, is never raised again. A round raises at most three nits, since each one needs an answer before the pull request, and says how many it left out.

The first round reads the whole branch. Later rounds read only the commits since the last one, and the review looks again at every open finding, since a fix may sit in another file. Those it finds fixed are closed. A review that reports as many findings as its level allows may have left some out, so the next round reads the whole branch again. After three rounds in a row end with findings open, the tool refuses a fourth and tells Claude to step back and talk to you.

Every finding needs an answer. Claude fixes it and commits, and the next round confirms the fix; or it dismisses the finding with a reason through the `dismiss` tool, and the reason shows in the card. Called with `fix`, the review also fixes what it found in the working tree once it has recorded it, then tells the gate which findings it fixed and why it left the rest. The round, its card and the band show those findings as fixed by the review and not yet confirmed, apart from the ones that still need an answer. The fixes stay uncommitted: Claude commits the ones it keeps, and the next round confirms each fix and closes its finding, or leaves it open.

A round reviews one commit, which may be someone else's: a pull request checked out to review it. So the review only reads. The engine's own check says which tool calls only read before they run, and the gate refuses the rest to the review and to any agent the review starts: no file changes, no command that is not a read, nothing fetched from outside the session, in any permission mode. With `fix`, the review may change files once it has recorded its findings, and not before; use it on code you trust, since a fix may run commands such as tests.

The round refuses to start while files have changes the commit does not hold, new files included. It records nothing if HEAD moves while it runs, or if files change before the review records what it read, or, without `fix`, at any point: the review may have read the change. Files that change once a `fix` review has recorded are listed as changed while the round ran; the gate cannot tell the review's edits from anyone else's, so the review's fixes stay its word until the next round confirms them.

## Risk

Before each round a classifier reads the branch's whole diff, files REVIEW.md skips included, and judges its risk from the code, not from a list of paths. Low is a change where nothing that runs can break, such as docs or tests alone. Medium is an ordinary change to behaviour. High is code where a missed defect could do lasting harm: code that decides what may run or who may act, runs commands or reads outside input, handles secrets, deletes or migrates data, or changes how the project is built, released or installed. The classifier gives its reasons, and a security finding that is not fixed also makes a change high risk. If it gives no verdict after two tries, the change counts as high. A commit judged once keeps its verdict.

Risk picks the level: `medium` for low, `high` for medium, and `xhigh` for high. A round over new commits alone runs at most at `high`, unless the `review` call or `/review-gate` names its level.

## Pull requests

Claude opens and merges pull requests through the `pull_request` tool. `open` pushes the reviewed commit to the branch on origin, by its id, and runs `gh pr create`. `merge` runs `gh pr merge` with `--match-head-commit`, so gh refuses if the pull request's head moves away from the reviewed commit. Both are refused until that commit has been reviewed and no finding is open. A review covers one commit, so a commit made after it needs a round of its own.

For a high-risk change, the tool asks you in Claude Code's question dialog to approve that commit before its pull request is opened or merged. Claude cannot answer the dialog, and the approval holds for that commit alone.

A shell command that runs `gh pr create`, `gh pr new` or `gh pr merge` is refused and sent to the tool, and so is a `gh api` call that opens or merges a pull request: a POST to `pulls`, a call to a pull request's `merge`, or a GraphQL mutation that creates, merges or queues one. The match reads the command's text with continued lines joined, so `env`, `bash -c`, `eval`, `xargs` and a variable holding `gh` do not hide the call. A commit message that only mentions those words is passed from a file (`git commit -F FILE`).

## Cost and time

- The review runs on the session's model, as `/code-review` does, and the risk classifier on Haiku unless `/config` says otherwise.
- A round is one review agent, so it costs about what `/code-review` at that level costs on its own, plus the classifier's few thousand tokens. Later rounds read only the new commits, so they cost less.
- Each round records how long it took, the tokens the review and the classifier spent with the share read from the cache, and the review's tool calls. The card shows them.

## In the terminal

While a round runs, the band above the prompt shows it:

```
review · round 2 · /code-review high · 3m 10s
  ● 31 calls · reading src/app.ts   [ watch ]
```

The second line is the review's agent: its tool calls so far, and what it is doing now. `watch` opens its transcript.

Between rounds the band says where the branch stands: fixes the review made, waiting for a round to confirm them, findings open, commits not reviewed yet, or a commit ready for its pull request, with a note when it waits for your approval. A review's row in the chat draws as a card that lists each finding with its grade, place and the review's category for it; fixed ones are ticked, the review's own fixes are marked as not yet confirmed, and dismissed ones show their reason. ctrl+o shows the text Claude read. When the review ran in the background, the engine's notice of its end is kept out of the conversation, since the round's result already holds its findings.

- `/review-gate` runs a round now. `/review-gate low`, `medium`, `high`, `xhigh` or `max` picks its level. Add `--fix` to let the review fix what it finds, and `--max-findings <n|all|default>` to pass `/code-review` its limit, which it keeps for later runs. Your run goes past the cap and reviews a commit again.
- A pull request's number is not a target: the gate reviews the branch checked out, so run `gh pr checkout <n>` first. `--comment` is not passed, since the review runs before the pull request exists.
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

Each branch's record of rounds, findings, answers and your approval is kept in the plugin's own store, outside the repository, so it lasts across sessions and is never committed. A record keeps who made the branch's first commit and when, which survives a rebase, so a later branch under the same name starts with none. A record goes when its branch is deleted. A record from version 0.1, whose rounds ran review-gate's own reviewer agents, reads as none, so its branch is reviewed again.

## Options

In `/config`:

- **Review level** is `auto` by default, which picks by risk, or one of `low`, `medium`, `high`, `xhigh` or `max`. A round over new commits alone still runs at most at `high`.
- **Risk model** is `haiku` by default; `inherit` uses the session's model.

## Limits

- A round runs one `/code-review` agent and one completion for the risk.
- The record depends on the review calling the `record` tool as the added section asks. A review that ends without doing so records no round, and Claude reviews again.
- A review reports at most what its level allows, 10 findings at `high`. The next round then reads the whole branch.
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
