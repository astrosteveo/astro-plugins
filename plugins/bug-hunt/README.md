# bug-hunt

Finds bugs and reproduces each one before calling it a bug. One skill, `/bug-hunt:hunt`, works on a change you just made, a part of the codebase, or a whole codebase nobody has reviewed. A large codebase is split into components, and each is hunted on its own.

```
/plugin install bug-hunt --marketplace astrosteveo/astro-plugins
```

## Use

```
/bug-hunt:hunt                              # the whole codebase, component by component
/bug-hunt:hunt src/save src/io              # those paths
/bug-hunt:hunt the inventory system         # an area, found on the component map
/bug-hunt:hunt crash when a save has no slots   # a symptom: the components on its path
/bug-hunt:hunt diff                         # your branch's commits and uncommitted changes
/bug-hunt:hunt 42                           # a pull request; also a branch, commit or A..B range
/bug-hunt:hunt confirm                      # reproduce findings already in the conversation
```

| Target | What finds the bugs | Then |
| --- | --- | --- |
| Nothing, paths, or an area or symptom in words | Hunters: one read-only subagent per component, riskiest first, at most 6 at a time | Each finding is reproduced |
| A change: `diff`, a PR, a branch, a commit or a range | Claude Code's own [`/code-review`](https://code.claude.com/docs/en/code-review-local), started by the skill | Each finding is reproduced |
| `confirm` | Findings already in the conversation, such as from a `/code-review` you ran or a PR review | Each finding is reproduced |

## How it works

1. **Map.** `skills/hunt/scripts/inventory.py` lists the code by directory with line counts, test files and how many of the last 300 commits touched each part. It leaves out vendored, generated and binary files, and its output stays short on a large repo. Claude reads the README, manifests and entry points, then groups the list into components of about 3,000 lines each, named for what they do and ranked by risk.
2. **Hunt.** One `bug-hunt:hunter` subagent per component. It has only Read, Grep and Glob, so hunters can run side by side without touching your working tree or asking for permissions. Each reads its component in full and the code on either side of its seams. It tries to disprove each suspicion, and reports the rest, each with a concrete failure and the test that would reproduce it.
3. **Confirm.** Your session takes the findings one at a time. For each, it adds the repro to the project's own tests, runs it, and checks that it fails for the reason given, on input the program can really receive and against behavior its docs, tests or callers expect. Then it removes exactly what it added. It never runs `git checkout`, `restore`, `reset`, `stash` or `clean`, so your uncommitted work is safe, and `git status` ends as it started.
4. **Report.** Findings are sorted into confirmed (with the command and the failing output), suspected (with why it couldn't be shown here and the repro that would show it) and ruled out. The report ends with coverage: which components were hunted, which weren't, and which files a hunter didn't read in full.

Each finding is written to a run file, `.bug-hunt/<date>-<target>.md`, as it arrives, so a long hunt loses nothing when the conversation is compacted. The run file keeps each confirmed bug's repro in full, ready to add as the failing test when you fix it. The folder holds a `.gitignore` of `*`, so git ignores it without a change to your repo's `.gitignore`.

It reports and doesn't fix. At the end it offers to fix the confirmed bugs, each starting from its failing test.

## Why it uses /code-review for changes

Claude Code's `/code-review` already reviews a diff, PR, branch or range, so bug-hunt doesn't repeat it. It adds what `/code-review` leaves out: a hunt across a whole codebase, component by component, and a reproduction for every finding. It doesn't run `/code-review` once per component, because a second review started while another is running runs in the foreground, one after another. A path target is also just text the review interprets, so the hunters handle whole codebases instead.

If Claude can't start `/code-review`, for example because your settings make it user-invocable only, the skill asks you to run `/code-review TARGET` and then `/bug-hunt:hunt confirm`. A change has to be checked out to be reproduced. For a PR or branch that isn't, its findings stay suspected until you check it out and run `/bug-hunt:hunt confirm`.

## Cost

A hunt reads every line it hunts and runs a repro for every finding, so its cost grows with the code. Two runs on Claude Opus with Claude Code 2.1.322, at the cost Claude Code reported:

| Target | Hunters | Findings | Time | Cost |
| --- | --- | --- | --- | --- |
| A 108-line sample repo, whole | 4 | 6 confirmed | 2 minutes | $1.14 |
| A 24,000-line Python and GDScript repo, whole | 10 | 40 confirmed, 9 suspected, 1 ruled out | 40 minutes | $32.82 |

The second run labelled 44 findings confirmed. 4 of those carried notes that the input might never occur or the expected behavior wasn't checked, so the skill now leaves such findings suspected; the table counts them that way. To spend less, hunt only the paths you care about, or hunt a change with `diff`.

## Requirements

- `python3` 3.8 or later for the map. Without it, the skill is told to map from `git ls-files` and say the map is rougher; that hasn't been tried in a session yet.
- git for change targets and recent-commit counts. A folder that isn't a git repo can still be hunted by path or whole.
- `gh` only for a PR target.

It hasn't been tried on Windows yet. There it would need Claude Code's Bash tool (Git Bash) and `python3` on the PATH.

## Tests

```
python3 -m unittest discover -s plugins/bug-hunt/tests
claude plugin validate plugins/bug-hunt
```
