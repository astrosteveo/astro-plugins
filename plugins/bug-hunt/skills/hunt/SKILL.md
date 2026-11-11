---
name: hunt
description: Hunt for bugs and prove each one by reproducing it. With no arguments, maps the whole codebase into components and sends a read-only hunter through each, riskiest first. Also takes paths, an area or a symptom in words, or a change (diff, PR, branch, range), which Claude Code's /code-review reviews first; "confirm" reproduces findings already in the conversation. Reports confirmed bugs with the failing test that shows each, suspected ones with the repro that would confirm them, and which components were and weren't hunted. Use when the user asks to hunt or find bugs in a codebase, component or area, to check code that has never been reviewed, or to confirm review findings by reproducing them.
argument-hint: "[nothing for the whole codebase | paths | an area or symptom | diff | PR | branch or A..B | confirm]"
allowed-tools: Bash(git rev-parse *), Bash(git status *), Bash(git log *), Bash(git diff *), Bash(git branch *), Bash(git merge-base *), Bash(git ls-files *), Bash(gh pr view *), Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/inventory.py), Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/inventory.py *)
---

# Hunt bugs and reproduce them

Find bugs in a change, a part of a codebase or all of it, then reproduce each one. A finding is a bug only once a repro has run and failed for the reason the finding gives. Until then it is suspected, and the report says what would confirm it.

This skill was invoked with: `$ARGUMENTS`

These hold for the whole run, across turns:

- **The working tree ends as it started.** Hunters only read. Confirming adds one repro at a time and removes exactly what it added. Never run `git checkout`, `git restore`, `git reset`, `git stash` or `git clean`: they would destroy the user's uncommitted work.
- **The run file holds the state.** Write each finding to it as it arrives and build the report from it, so a long run loses nothing to compaction. After a compaction, read it to see what's done.
- **Report, don't fix.** Fix nothing unless the user asks after the report.

## 1. Pick the target

Run these in one turn:

```
git rev-parse --show-toplevel
git status --short
git branch --show-current
```

Work from the repo root. In a folder that isn't a git repo, work in the current folder: change targets need git, and the rest work without it.

Read the arguments, in this order:

| Arguments | Target | Finder |
| --- | --- | --- |
| none | the whole codebase | hunters (steps 2 and 3) |
| `confirm` | findings already in this conversation, from `/code-review`, a PR review or an earlier hunt | none: go to step 5 |
| `diff`, or words for the current changes such as "my changes" or "this branch" | the branch's commits and uncommitted changes | `/code-review` (step 4) |
| paths that exist: files, directories or globs | those paths | hunters (steps 2 and 3) |
| a PR number or URL, a branch, a commit or a range such as `main..HEAD` | that change | `/code-review` (step 4) |
| anything else | an area, such as "the save system", or a symptom, such as "crash when saving with no slots" | hunters on the matching components (steps 2 and 3) |

Tell a branch or commit from words with `git rev-parse --verify --quiet WORD`.

Then start the run file: `.bug-hunt/YYYY-MM-DD-<target in a few words>.md` at the repo root, with today's date, and `-2`, `-3` added if that name is taken. If `.bug-hunt/.gitignore` doesn't exist, create it holding the single line `*`, so git ignores the folder without a change to the repo's own `.gitignore`. The run file starts with the target and the finder. It gets the map, each finding and the coverage as the run goes.

## 2. Map the code into components

```
python3 ${CLAUDE_SKILL_DIR}/scripts/inventory.py [PATHS]
```

With no paths it lists the whole repo; with paths, only those. It prints the code's size and languages, the manifests, and units: directories or groups of files of at most 3,000 lines of code each, with their test files and how many recent commits touched them. It leaves out vendored, generated and binary files and counts tests apart. If python3 is missing, map from `git ls-files` and Glob instead, and say the map is rougher.

Read what tells you what the program is and how it's tested: the README, CLAUDE.md or AGENTS.md, the manifests it lists and the entry points. Find how the project runs one test file, from those files or its CI config.

Turn the units into components. A component is a part with one job and a boundary: a package, module, service or game system. Name each by what it does. Merge small units that share a job, across directories if need be, and split a unit that holds unrelated jobs. Keep each under about 3,000 lines, so its hunter can read all of it; a single file over that is a component of its own. Tests aren't hunted, but hunters read them as a statement of what the code should do. Leave out only what the script left out, plus anything you say why you left out.

For each component, note its files, what it does, its entry points, its neighbors (what it calls and what calls it) and its tests. Rank by risk: what breaks if it's wrong (data loss, security, money, crashes) and how likely it is to be wrong (it parses outside input, keeps state across calls, runs concurrently, does arithmetic, time or units, has many error paths, changed often lately, has no tests).

For an area in words, keep the components that make it up. For a symptom, keep the components on its path, from the entry point to where it would fail, and make the symptom each hunter's focus.

Write the map to the run file as a numbered table: component, files, lines, risk, status. Show the user the map and how many hunters it takes, then go on without waiting.

## 3. Hunt

Send one `bug-hunt:hunter` subagent per component with the Agent tool, riskiest first, at most 6 at a time. Start the next as each one reports, until every component on the map is hunted. Brief each with:

- the component's name, what it does, its entry points, and every file in it;
- its neighbors and their files, so it can check the seams;
- the tests that cover it, and the command that runs one test file;
- its focus: the whole component, or the symptom to trace.

Give it the files and the job, not your guesses: a hunter told what to find tends to find it.

As each report arrives, add its findings to the run file as suspected, with their repros in full, and its Checked and Not read lists. Mark the component hunted. If two hunters report the same root cause from either side of a seam, keep one finding. Once every hunter has reported, go to step 5. Don't start confirming before then: the hunters may read a file a repro has added to.

## 4. Review a change with /code-review

Claude Code's own `/code-review` finds bugs in changes. Start it with the Skill tool, skill `code-review`, passing the target as its arguments: nothing for `diff` (it reviews the branch's commits and uncommitted changes), or the PR, branch, commit or range as the user gave it. Don't pass an effort level or flags: it reuses the level the user last chose. Don't send hunters at the change as well.

When it runs in the background, its findings arrive in a later message. Wait for them, then add each to the run file as a suspected finding, with its place and summary, and go to step 5.

If you can't start it, because the skill isn't available to you or the call is refused, tell the user to run `/code-review TARGET` and then `/bug-hunt:hunt confirm`, and stop.

The repros in step 5 run against the working tree, so it has to hold the change: `diff`, the current branch, a PR whose branch is checked out (`gh pr view N --json headRefName`), or a branch, commit or range that HEAD contains (`git merge-base --is-ancestor REF HEAD`). Otherwise skip step 5, keep the findings suspected, and tell the user to check out the change and run `/bug-hunt:hunt confirm`.

## 5. Confirm each finding

With `confirm` as the target, take the findings from earlier in this conversation and write them to the run file as suspected first.

Before the first repro, keep the output of `git status --short` as the baseline, and run one existing test file the way the project does, to check the command works.

Then take the findings one at a time, most severe first:

1. **Write the smallest repro** that shows the failure through the code's real entry points: a test in the project's framework and layout, named for the bug, in a new file unless the language needs it inside an existing one. Start from the hunter's repro when there is one. Where the project has no tests, write a script in a temporary folder outside the repo.
2. **Run only that repro.** The finding is confirmed only if it fails, and fails the way the finding says: the wrong value, the exception, the crash. A failure for another reason, such as a compile error, an import error or broken setup, is not a confirmation: fix the repro and run it again, at most three times.
3. **Remove exactly what you added:** delete the new file, or take your lines back out with Edit. Run `git status --short` and check it matches the baseline.
4. **Record the outcome** in the run file:
   - **Confirmed:** the command and the lines of output that show the failure, and the repro's code and where it goes.
   - **Ruled out:** the repro passed, so the code does the right thing. Say why the finding was wrong.
   - **Suspected:** it can't be shown here, because it needs hardware, a network service, credentials, a GPU, a race that won't happen on demand, or more than a few minutes. Keep the repro that would show it.

Don't run a repro that would reach outside the repo and temporary folders, such as one that calls a real service or deletes data. Keep that finding suspected.

## 6. Report

Finish the run file's coverage section, then report from the run file:

1. One line: the target, how many components were hunted of how many, and how many findings were confirmed, suspected and ruled out.
2. **Confirmed bugs**, most severe first: `path:line` and a title, what goes wrong (this input or state gives this instead of that), the repro command, and the output that shows the failure.
3. **Suspected**: each with why it couldn't be confirmed and the repro that would confirm it.
4. **Coverage**: the components hunted, the ones that weren't and why, and the files a hunter didn't read in full. Code that wasn't hunted wasn't checked, so say so plainly rather than call it clean.
5. The run file's path. It holds each confirmed bug's repro in full, ready to add as the failing test when the bug is fixed.

Then offer to fix the confirmed bugs, each starting from its repro as the failing test, the way the user's CLAUDE.md says to fix bugs.
