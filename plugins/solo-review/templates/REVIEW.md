# Review guide

<!-- Read on every review by solo-review's agents (and by GitHub's Code Review, if you turn it on). Short guides get
followed: keep this under 40 lines, and delete these comments as you fill it in. -->

## What Important means here
<!-- What failure looks like in this project, one line each. Every change is checked against each line, so write
them the way you'd describe the bug report you dread. For example:
- A save can drop the user's data without an error.
- The CLI exits 0 when a command failed.
- The docs describe a flag or behavior the code doesn't have.
- A config change points the app at the wrong environment. -->

## Always check
<!-- Bug classes that have shipped here before, one line each. /solo-review:learn adds to this list. -->

## Do not report
- Style, naming, formatting or refactoring ideas: the linter and /simplify own those.
- Missing tests or docs, unless a line above asks for them.
- Anything a compiler, type checker or linter would catch.
- Generated and vendored files.

## Intentional
<!-- Choices that look like bugs but aren't, each with its reason, so the reviewer stops flagging them. -->

## Cap the nits
Report at most 3 nits, and only ones worth a commit. Nits never block a merge.

## Evidence
- Cite file:line and the input or path that triggers each finding. Never guess from a name.
- Report a bug class once, listing every place it occurs.
- Start the summary with the count. If there is nothing to fix, say so in one line.
