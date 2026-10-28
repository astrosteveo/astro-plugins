# review-gate

Reviews a branch before its pull request, and refuses the pull request until the review passes. It follows [How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/): agents do most of the reading, every finding gets an answer, review stops when it no longer converges, and a person decides where the risk is.

## How a review runs

Claude calls the `review` tool once a change is committed and its checks pass. The tool compares the branch with the default branch (origin's copy where there is one) and sends reviewer agents over the diff in parallel, each with one focus: correctness, failure paths, fit with the rest of the code, and security, plus state and data in a deep round. Checker agents then vote on each candidate. A finding stands only when most of them hold it real, and they grade it important, nit or pre-existing and say whether it is a security hole.

Reviewers leave out style, naming and missing tests, report a recurring mistake once with every place it occurs, and keep to three nits a round.

The first round reads the whole branch. Later rounds read only the commits since the last one, and the checkers look again at every open finding, closing those the new commits fixed. A finding the branch has had is never raised again. After three rounds in a row end with findings open, the tool refuses a fourth and tells Claude to step back and talk to you.

Every finding needs an answer. Claude fixes it and commits, and the next round confirms the fix; or it dismisses the finding with a reason through the `dismiss` tool, and the reason shows in the card.

## The gate

`gh pr create` and `gh pr merge` are refused until the commit they propose has been reviewed and no finding is open. A review covers one commit, so a commit made after it needs a round of its own. For a merge, the gate asks gh for the pull request's head and checks that commit.

A change is high risk when it touches a path a person approves, or has a security finding that is not fixed. The paths are CI workflows, installers, release and deploy files, Dockerfiles, auth, secrets and credentials, and any a REVIEW.md lists. A change that touches only docs is low risk, and any other is medium. Risk picks the depth: quick (2 reviewers, 1 checker) for low, standard (4 and 3) for medium, and deep (5 and 5) for high.

For a high-risk change the gate asks you, in Claude Code's question dialog, to approve that commit before its pull request is opened or merged. Claude cannot answer the dialog, and the approval holds for that commit alone.

The review's agents only read. They get Read and Bash, and each command they run is checked: git's reading subcommands, rg, grep, find, ls, cat, head, tail, wc, `sed -n` and a few more pass. A command that writes a file, runs another program or changes the repository is refused.

## In the terminal

The band above the prompt says where the branch stands: a round in progress (`round 2: checkers 1 of 3 done`), findings open, commits not reviewed yet, or a commit ready for its pull request, with a note when it waits for your approval. A review's row in the chat draws as a card that lists each finding with its grade, place and votes; fixed ones are ticked, and dismissed ones show their reason. ctrl+o shows the text Claude read.

- `/review-gate` runs a round now; `/review-gate quick`, `standard` or `deep` picks its depth. Your run goes past the cap and reviews a commit again.
- `/review-gate status` shows the latest round.
- `/review-gate more` allows three more rounds after the cap.
- `/review-gate reset` forgets the branch's record.

## REVIEW.md

A REVIEW.md at the root, or in any folder above a changed file, goes to every reviewer and checker. Say what a defect looks like in that code. Two headings are read as lists of globs, written as in .gitignore and relative to the file's folder:

```markdown
## Skip
- `*.lock`
- `generated/`

## Needs a person
- `src/billing/`
```

Files under Skip are left out of the diff the agents read. A change to a file under Needs a person is high risk.

## Where the record lives

Each branch's record of rounds, findings, answers and approval is a JSON file in the repository's git folder, `.git/review-gate/<branch>.json`. It lasts across sessions and is never committed.

## Options

In `/config`, **Review depth** is `auto` by default, which picks by risk, or always `quick`, `standard` or `deep`. **Reviewer model** is `inherit` by default, which runs the agents on the session's model, or `opus`, `sonnet` or `haiku`.

## Limits

- A round runs one agent per reviewer and per checker: 3, 7 or 10 of them. A standard round over a small change takes a minute or two.
- The gate sees pull requests that a Claude Code session opens or merges with gh. One opened on github.com, or from another shell, does not pass through it.
- The record belongs to one clone; another clone starts with none.
- It needs git, gh for merges, and the `sleep`, `mkdir`, `mv` and `rm` commands. Windows is not supported.

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
