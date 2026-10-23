---
# solo-review settings. Every key is optional; these are the defaults.
depth: auto            # auto | quick | standard | deep
security: auto         # auto | always | never
check: "claude plugin validate --strict . && claude plugin validate --strict plugins/solo-review && claude plugin validate --strict plugins/web-reader && claude plugin test plugins/solo-review && python3 -B plugins/web-reader/scripts/webread.py --help > /dev/null"
max_nits: 3
max_rounds: 3          # after this many rounds on one change, step back instead of re-reviewing
gate: push             # push | off: block Claude's `git push` while any finding is open
branch: require        # require | off: no file edits on the default branch
workflow: manual       # manual | auto: auto runs review and ship when a task is done; manual waits for you to ask
merge: rebase          # rebase | squash | merge: how /solo-review:ship lands a branch
high:                  # High risk: reviewed deep with a security pass, and you read them before a merge. Added to
                       # the plugin's always-High list (Claude config, CLAUDE.md, CI, git hooks, dependency
                       # manifests, secrets), which nothing here can remove. `ledger.py config` shows both.
  - "**/install.sh"
  - "**/release.sh"
  - "**/auth/**"
  - "plugins/web-reader/scripts/webread.py"
low:                   # Low risk: a change whose every file matches lands on a clean review and passing checks,
                       # without waiting for you. Empty until you list paths, such as "docs/**". It never lowers
                       # a High-risk file.
trusted:               # author emails besides your git user.email; a Low change with a commit by anyone else
                       # (a contributor's PR) waits for you
skip:                  # never reviewed, except files on the always-High list (such as lockfiles), which
                       # skip never hides
  - "**/*.min.js"
  - "**/*.snap"
---

# Review guide

<!-- Read on every review by solo-review's agents, and by GitHub's Code Review if you turn it on. Short guides get
followed: keep this body under 40 lines, and delete these comments as you fill it in. -->

## What Important means here
- solo-review acts in a repo without `.review/`: a hook blocks or adds context there, or the commit, review or ship
  skill does anything but step aside.
- A skill and its script disagree: a step uses a `ledger.py` subcommand, flag or JSON field that doesn't exist, or
  `allowed-tools` doesn't cover a command the step runs.
- A skill acts without the user where it promises to wait: ship merges a Medium or High change, pushes, or ticks the
  sign-off box without the user saying so.
- `webread.py` fetches a private or local address without `--allow-local`, or writes outside its `--out` folder.
- A README, skill description or manifest describes a skill, flag or behavior the code doesn't have, or a change to a
  plugin doesn't raise its `version`.

## Always check
<!-- Bug classes that have shipped here before, one line each. /solo-review:review-learn adds to this list. -->

## Do not report
- Style, naming, formatting or refactoring ideas: linters and /simplify own those.
- Missing tests or docs, unless a line above asks for them.
- Anything a compiler, type checker or linter would catch.
- Generated and vendored files.

## Intentional
<!-- Choices that look like bugs but aren't, each with its reason, so the reviewer stops flagging them. -->

## Evidence
- Cite file:line and the input or path that triggers each finding. Never guess from a name.
- Report a bug class once, listing every place it occurs.
