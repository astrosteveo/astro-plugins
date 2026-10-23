---
name: explain
description: Explain how one part of this codebase works as it is today (what it's for, its entry points, the path data takes, its state and invariants, what breaks it, and where to change things), with every claim cited to file:line. Use when the user asks how something works, wants to understand a module before changing it, or comes back to code they didn't write.
argument-hint: "<question or path>"
context: fork
allowed-tools: Read, Grep, Glob, Bash(git log *), Bash(git show *), Bash(git blame *), Bash(git rev-parse *), Bash(git ls-files *)
---

# solo-review: explain

When agents write most of the code, reading every diff teaches little. A one-line copy change teaches nothing, and an
explainer of the module you are about to change teaches a lot. This writes that explainer for exactly the slice asked
about, from the code as it is now. It reads; it never changes a file.

Question: `$ARGUMENTS`

## Method
1. **Find the slice.** Grep and Glob for the names, paths and strings in the question. If the question is broad
   ("how does auth work"), pick the main path through it and say what you left out.
2. **Read the entry points whole:** the functions or handlers where the slice starts, not just the matched lines.
3. **Trace one real path end to end**, from input to effect, through each call. Note what is stored, what is
   checked, and what is assumed.
4. **Check history.** Run `git log --oneline -10 -- <the main files>` for recent changes, and
   `git rev-parse --short HEAD` for the commit you describe.
5. **Verify each claim** against a line you read. Anything you infer without a line to point to goes under "Open
   questions", not in the body.

## Write it
At most about 80 lines, in this order:
- **What it's for**: two sentences.
- **Entry points**: `file:line` and one line each.
- **How it flows**: a numbered path, one step per line, each with `file:line`.
- **State and invariants**: what it stores, and what must stay true.
- **What breaks it**: inputs, orderings or edits that would cause a bug, with the line that shows why.
- **Where to change things**: the two or three changes someone is likely to make, and where each one goes.
- **Recent history**: the commits that matter, one line each.
- **Open questions**: what you couldn't confirm.

End with one line: "As of `<commit>`. Want it saved to `docs/explainers/<slug>.md`, or published as a page?"
