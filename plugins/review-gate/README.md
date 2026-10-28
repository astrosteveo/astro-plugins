# review-gate

Reviews a branch before its pull request, and refuses the pull request until the review passes. It follows [How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/): agents do most of the reading, every finding gets an answer, review stops when it no longer converges, and a person approves the changes that carry the most risk.

## How a review runs

Claude calls the `review` tool once a change is committed and its checks pass. The tool compares the branch with the default branch (origin's copy where there is one) and sends reviewer agents over the diff in parallel, each with one focus: correctness, failure paths, fit with the rest of the code, and security, plus state and data in a deep round. Checker agents then vote on each candidate. A finding stands only when most of them hold it real, and they grade it important, nit or pre-existing and say whether it is a security hole.

Reviewers leave out style, naming and missing tests, report a recurring mistake once with every place it occurs, and keep to three nits a round.

The first round reads the whole branch. Later rounds read only the commits since the last one, and the checkers look again at every open finding, closing those the new commits fixed. A finding the branch has had is never raised again. After three rounds in a row end with findings open, the tool refuses a fourth and tells Claude to step back and talk to you.

Every finding needs an answer. Claude fixes it and commits, and the next round confirms the fix; or it dismisses the finding with a reason through the `dismiss` tool, and the reason shows in the card.

## The gate

`gh pr create`, `gh pr new` and `gh pr merge` are refused until the commit they propose has been reviewed and no finding is open. A review covers one commit, so a commit made after it needs a round of its own. For a merge, the gate asks gh for the pull request's head, in the repository `-R` names if one is given, and checks that commit. The gate finds these commands after a wrapper such as `env` or `command`, inside `bash -c` and `eval`, and every one of several in a line. Where it cannot tell which repository, branch or pull request a command acts on, as with a `cd` through a variable, a branch that is not in this clone, or arguments that xargs supplies, it refuses the command.

Before each round a classifier reads the branch's whole diff, files REVIEW.md skips included, and judges its risk from the code, not from a list of paths. Low is a change where nothing that runs can break, such as docs or tests alone. Medium is an ordinary change to behaviour. High is code where a missed defect could do lasting harm: code that decides what may run or who may act, runs commands or reads outside input, handles secrets, deletes or migrates data, or changes how the project is built, released or installed. The classifier gives its reasons, and a security finding that is not fixed also makes a change high risk. It runs on the reviewers' model; if it gives no verdict after two tries, the change counts as high. Risk picks the depth: quick (2 reviewers, 1 checker) for low, standard (4 and 3) for medium, and deep (5 and 5) for high.

For a high-risk change the gate asks you, in Claude Code's question dialog, to approve that commit before its pull request is opened or merged. Claude cannot answer the dialog, and the approval holds for that commit alone.

The review's agents only read. They get Read and Bash, and each command they run is checked: git's reading subcommands, rg, grep, find, ls, cat, head, tail, wc, `sed -n` and a few more pass. A command that writes a file, runs another program or changes the repository is refused. So is a word the shell would change before the program sees it, such as a variable, a glob or a brace list, and a program named by its path, so what the check reads is what runs.

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

Each branch's record of rounds, findings and answers is a JSON file in the repository's git folder, `.git/review-gate/<branch>.json`. It lasts across sessions and is never committed. Your approvals are kept apart, in the plugin's own store. Claude's file tools, and shell commands that name the record, are refused it. A record goes when its branch is deleted, and one left by an earlier branch of the same name is ignored.

## Options

In `/config`, **Review depth** is `auto` by default, which picks by risk, or always `quick`, `standard` or `deep`. **Reviewer model** is `inherit` by default, which runs the agents on the session's model, or `opus`, `sonnet` or `haiku`.

## Limits

- A round runs one agent per reviewer and per checker, 3, 7 or 10 of them, and one completion for the risk. A standard round over a small change takes a minute or two.
- The gate sees pull requests that a Claude Code session opens or merges with gh. One opened on github.com, or from another shell, does not pass through it.
- The record belongs to one clone; another clone starts with none.
- The record's guard keeps Claude from writing the record by habit or by mistake. It cannot stop a program written to get round it: the gate guards a workflow, and is not a sandbox.
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
