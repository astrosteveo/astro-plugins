# {{name}}

<One line: what this project is, and who it's for.>

<!-- Every line must be true and checkable: name the file, command, or pattern that shows it. No absolute rule the
code can't meet. Keep it short, and point to other docs instead of copying them. Delete this comment when done. -->

## Goals
- <What the project is for.>

## Non-goals
- <What it deliberately does not do.>

## Layout
- <Language and framework, and where the code lives: the main folders and what each holds.>

## Commands
- `{{check}}`: builds and tests the project.
- <How to run it locally.>

## Verify
Before saying a change is done, run the check and show what it printed. Never report a result you didn't see. If it
fails for a reason unrelated to the change, say so and show the output instead of working around it.
- <For a UI change: how to start it, where to look, and a screenshot of the changed screen. Delete this line if
  there is no UI.>

## Conventions
- <A convention the code or tooling depends on, and the file or command that enforces it.>

## Git
- Work on a branch named `<type>/<short-name>` (feat, fix, refactor, docs or chore), in this checkout:
  `git switch -c <type>/<short-name>`. Never commit to the default branch.
- Changes reach the default branch through a reviewed pull request: `/solo-review:review`, then `/solo-review:ship`.

## Gotchas
- <Anything surprising: a step that must run first, a required environment variable, a flaky test.>

## More
- <Pointers: README.md, REVIEW.md, docs.>
