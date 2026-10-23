---
# solo-review settings. Every key is optional; these are the defaults.
depth: auto            # auto | quick | standard | deep
security: auto         # auto | always | never
check: ""              # the one command that builds and tests the project; init fills it in when it can tell
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

Keep this short. The reviewer reads all of it on every run, and short guides get followed.

## What failure looks like here
<!-- One line per failure that would actually hurt this project. Examples:
- The CLI exits 0 when a command fails.
- A save path can lose user data without an error.
- Docs describe a flag or behavior the code no longer has. -->

## Always check
<!-- Bug classes this project has shipped before. /solo-review:review-learn adds to this list. -->

## Don't flag
- Style, formatting, naming, or cleanup. Linters and /simplify handle those.
- Missing tests or docs, unless a line above asks for them.

## Intentional patterns
<!-- Deliberate choices the reviewer keeps flagging as bugs, each with the reason. -->

## Evidence
- Cite file:line and the input or path that triggers each finding. Do not guess from a name.
- Flag a bug class once and list every instance, rather than one finding per instance.
