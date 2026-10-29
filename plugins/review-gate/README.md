# review-gate

Reviews a branch before its pull request, and opens or merges the pull request only once the review passes. It follows [How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/): agents do most of the reading, every finding gets an answer, review stops when it no longer converges, and a person approves the changes that carry the most risk.

## How a review runs

Claude calls the `review` tool once a change is committed and its checks pass. The tool compares the branch with the default branch (origin's copy where there is one) and sends reviewer agents over the diff in parallel, each with one focus: correctness, failure paths, fit with the rest of the code, and security, plus state and data in a deep round. Checker agents then vote on each candidate. A finding stands only when most of them hold it real, and they grade it important, nit or pre-existing and say whether it is a security hole.

Reviewers leave out style, naming and missing tests, report a recurring mistake once with every place it occurs, and keep to three nits a round. They have no shell: they read files with Read, run git's reading commands through a `review_git` tool and search with a `review_search` tool. Both run their program by its arguments, with no shell to expand them, and `review_git` takes only the subcommands that read.

The first round reads the whole branch. Later rounds read only the commits since the last one, run at most at standard depth, and recheck only the open findings in files those commits touched. A finding the branch has had is never raised again. After three rounds in a row end with findings open, the tool refuses a fourth and tells Claude to step back and talk to you.

Every finding needs an answer. Claude fixes it and commits, and the next round confirms the fix; or it dismisses the finding with a reason through the `dismiss` tool, and the reason shows in the card.

## Risk

Before each round a classifier reads the branch's whole diff, files REVIEW.md skips included, and judges its risk from the code, not from a list of paths. Low is a change where nothing that runs can break, such as docs or tests alone. Medium is an ordinary change to behaviour. High is code where a missed defect could do lasting harm: code that decides what may run or who may act, runs commands or reads outside input, handles secrets, deletes or migrates data, or changes how the project is built, released or installed. The classifier gives its reasons, and a security finding that is not fixed also makes a change high risk. If it gives no verdict after two tries, the change counts as high. A commit judged once keeps its verdict.

Risk picks the depth: quick (2 reviewers, 1 checker) for low, standard (4 and 3) for medium, and deep (5 and 3) for high.

## Pull requests

Claude opens and merges pull requests through the `pull_request` tool. `open` pushes the branch to origin and runs `gh pr create`. `merge` runs `gh pr merge` with `--match-head-commit`, so gh refuses if the pull request's head moves away from the reviewed commit. Both are refused until that commit has been reviewed and no finding is open. A review covers one commit, so a commit made after it needs a round of its own.

For a high-risk change, the tool asks you in Claude Code's question dialog to approve that commit before its pull request is opened or merged. Claude cannot answer the dialog, and the approval holds for that commit alone.

A shell line that runs `gh pr create`, `gh pr new` or `gh pr merge`, however it is wrapped, is refused and sent to the tool. The match is on the line's text, so a commit message that only mentions those words is passed from a file (`git commit -F FILE`).

## Cost and time

- Reviewers and checkers run on Sonnet, and the risk classifier on Haiku, unless `/config` says otherwise.
- The checkers share one prompt. The first starts alone and the rest a few seconds later, so they read its prompt from the prompt cache. The classifier marks its prompt for the cache too, for a second try.
- Once the votes so far settle every finding, the checkers still at work are stopped. Once all but one agent of a phase has answered, the last gets three more minutes.
- Each round records how long it took and the tokens it spent, with the share read from the cache, and the card shows them.

## In the terminal

The band above the prompt says where the branch stands: a round in progress (`round 2: judging the change's risk`, then `round 2: checkers 1 of 3 done`), findings open, commits not reviewed yet, or a commit ready for its pull request, with a note when it waits for your approval. A review's row in the chat draws as a card that lists each finding with its grade, place and votes; fixed ones are ticked, and dismissed ones show their reason. ctrl+o shows the text Claude read.

- `/review-gate` runs a round now; `/review-gate quick`, `standard` or `deep` picks its depth. Your run goes past the cap and reviews a commit again.
- `/review-gate status` shows the latest round.
- `/review-gate more` allows three more rounds after the cap.
- `/review-gate reset` forgets the branch's record.

## REVIEW.md

A REVIEW.md at the root, or in any folder above a changed file, goes to every reviewer and checker, and to the risk classifier. It is read as it stands where the branch forked from the default branch, so a branch cannot loosen its own review. Say what a defect looks like in that code. A Skip heading is read as a list of globs, written as in .gitignore and relative to the file's folder, for files to leave out of the diff the agents read:

```markdown
## Skip
- `*.lock`
- `generated/`
```

## Where the record lives

Each branch's record of rounds, findings, answers and your approval is kept in the plugin's own store, outside the repository, so it lasts across sessions and is never committed. A record keeps who made the branch's first commit and when, which survives a rebase, so a later branch under the same name starts with none. A record goes when its branch is deleted.

## Options

In `/config`:

- **Review depth** is `auto` by default, which picks by risk, or always `quick`, `standard` or `deep`.
- **Reviewer model** is `sonnet` by default; `inherit` runs the agents on the session's model.
- **Risk model** is `haiku` by default; `inherit` uses the reviewer model.

## Limits

- A round runs one agent per reviewer and per checker, 3, 7 or 8 of them, and one completion for the risk.
- The gate sees pull requests that a Claude Code session opens or merges. One opened on github.com, or from another shell, does not pass through it.
- The record belongs to one machine; another clone or machine starts with none.
- It guards a workflow and is not a sandbox: a model that sets out to forge the plugin's store, or to hide a gh command from a text match, can.
- It needs git, gh, and the `sleep` command; ripgrep is used when installed, and git grep when not. Windows is not supported.

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
