---
name: review
description: Draft or review the repo's PROJECT.md, the committed document that says what the project is for - the problem, who it's for, goals, non-goals, what success and failure look like, priorities, constraints and decisions. With no PROJECT.md, drafts one from the repo and a short interview. With one, reviews it against what changed since its last commit and asks the user about drift, stale lines and open questions. With an idea as the argument, checks the idea against the project's scope. Use when the user asks to write, review, refine or update PROJECT.md or the project's scope or goals, or asks whether an idea fits the project.
argument-hint: "[a section to focus on, or an idea to check against the scope]"
allowed-tools: Bash(git rev-parse *), Bash(git status *), Bash(git log *), Bash(git diff *)
---

# Draft and review PROJECT.md

PROJECT.md, at the repo root, says what the project is for: the problem it solves, who it's for, what it will and won't do, and how to tell whether it worked. CLAUDE.md says how to work in the repo; PROJECT.md says what the work is for. CLAUDE.md imports it, so Claude has it in every session. It grows with the project.

This skill was invoked with: `$ARGUMENTS`

The user runs this skill as often as they like, to stay on track. A run changes PROJECT.md only with the user's approval, and a run right after another finds nothing to raise. Three rules make that hold:

- The file has no review date or "last updated" line. The last commit that touched PROJECT.md marks the last review.
- Every finding the user answers is written into the file (step 4), even "keep it as it is", and a finding the file already answers is not raised again.
- The file has one copy of each heading, in the template's order. Its own extra sections and the user's wording stay as they are unless the user approves a change.

## 1. Look at the repo

Run these in one turn:

```
git rev-parse --show-toplevel
git status --short
git log -1 --format='%h %cs' -- PROJECT.md
```

If the folder is not a git repo, work in the current folder, skip the history in step 3, and say the review can't see what changed. If the repo has no commits yet, or PROJECT.md was never committed, there is no baseline: step 3 says what to do.

Read PROJECT.md at the repo root if it exists, and the README, CLAUDE.md, .claude/CLAUDE.md and AGENTS.md that exist.

Then pick what to do:

- **No PROJECT.md**: draft one (step 2). If the arguments name an idea, check it once the draft is written (step 5).
- **The arguments name a section** of PROJECT.md, such as `non-goals`: review that section only (step 3).
- **The arguments name anything else**: it's an idea to check (step 5).
- **No arguments**: review the whole file (step 3).

## 2. Draft PROJECT.md

Use the template below. Its headings, in its order, are PROJECT.md's sections. The comment under each says what goes there. Leave the comments out of PROJECT.md.

````markdown
# Project name

One sentence: what this is and who it's for.

## What it is

<!-- The kind of thing it is (CLI, library, web app, game, service), what it does, and how someone uses it. One short paragraph. -->

## The problem

<!-- Who has the problem, what it costs them, and what they do about it today. -->

## Who it's for

<!-- The people who use it, and what they know and have already. Name who it is not for when that's not obvious. -->

## Goals

<!-- What the project will do, as outcomes, most important first. -->

## Non-goals

<!-- What it won't do, even though someone could reasonably expect it to. Each with the reason. -->

## Success looks like

<!-- How to tell it worked, as checks someone could run or observe: "a new player finishes level 1 in under 10 minutes", not "players enjoy it". -->

## Failure looks like

<!-- The outcomes that would make the project not worth doing, or the signs it is heading there. -->

## Priorities

<!-- The order to trade off in when two good things conflict, such as "1. Simple to use 2. Fast 3. More features". -->

## Constraints

<!-- What can't change: platforms, stack, budget, time, licenses, things that must never break. -->

## Decisions

<!-- One line each, newest last: "- YYYY-MM-DD: what was decided. Why: the reason." Include ideas turned down and findings kept on purpose, so they aren't raised again. -->

## Open questions

<!-- What isn't decided yet, each as a question. Move one to Decisions once it's answered. -->

## Glossary

<!-- Terms this project uses in its own way, one line each. -->

## Status

<!-- Where the project stands against its goals: what works, what's next. A few lines, not a task list, and nothing that changes with every commit, such as a commit count. -->
````

Fill in what the repo shows: what it is, and constraints such as the stack, platforms and license. Take them from the README, the manifests (such as Cargo.toml, package.json, pyproject.toml or project.godot), CLAUDE.md and `git log --oneline -20`.

The problem, who it's for, goals, non-goals, success, failure and priorities are the user's to say. Ask for them in plain text, not with AskUserQuestion, so the user can answer several in one reply. Ask at most four at a time. Give each a suggestion from what the repo shows, so the user can answer with a yes or reword it.

Then show the whole draft. It holds only what the user said or confirmed and facts from the repo. A section with no answer yet says `Not decided yet.`, and its question goes under Open questions. Keep the file under 150 lines: CLAUDE.md loads it into every session, and Claude Code's docs aim to keep that under 200 lines. Write it once the user approves (step 6).

## 3. Review PROJECT.md

Find what changed since PROJECT.md's last commit, the hash from step 1:

```
git log --oneline HASH..HEAD
git diff --stat HASH..HEAD
```

Read a commit's changes (`git log -p -1 COMMIT`) when its subject doesn't say enough. If PROJECT.md has uncommitted changes, read `git diff -- PROJECT.md`: the user may have edited it by hand, and those edits are theirs. If it was never committed, or the repo has no commits, review it against `git log --oneline -30` and the files, and say it has no committed baseline yet.

Look for:

- **Against what changed:**
  - Work that serves none of the goals, or that a non-goal or constraint rules out. Name the commit.
  - A success check now met, or a sign of failure now showing.
  - A decision in the commits that Decisions doesn't record, such as a dependency added, a feature dropped or an approach chosen.
  - An open question the commits answer.
  - Status that no longer says where the project stands.
- **In the file itself:**
  - A success or failure line too vague to check. Propose a checkable one.
  - Lines that contradict each other, such as a goal that a non-goal rules out.
  - A template section that's missing, or a `Not decided yet.` that the repo now answers.
  - Over 150 lines: propose folding old Decisions into fewer lines and cutting Status to where things stand now.

Drop any finding the file already answers: a decision, non-goal or open question that covers it. Review the scope, not the code: don't run, test or change the code.

Report one line on whether the work is on track with the goals. Then list the findings, numbered, each with its evidence (a commit or a line of the file) and the edit you propose. Then ask the questions only the user can answer, in plain text. If there are no findings, say PROJECT.md is current and stop without changing anything.

## 4. Record the answers

Draft an edit for each finding the user answers:

- A change of scope goes in Goals, Non-goals or Constraints, in the user's words.
- Work the user keeps although it's outside the goals goes in Decisions, with their reason. Otherwise the next review raises it again.
- A success check met, a question answered or a new status updates its section. An answered open question moves to Decisions.

A Decisions line reads `- YYYY-MM-DD: what was decided. Why: the reason.`, dated today. For example: `- 2026-11-05: Kept the level editor, though it's not a goal. Why: it makes testing levels faster.`

## 5. Check an idea

Compare the idea with Goals, Non-goals, Priorities, Constraints and Decisions. Say whether it fits, conflicts (quote the line it conflicts with) or isn't covered. Recommend doing it, not doing it, or changing the scope first, and say why. Once the user decides, record it as step 4 does: a new goal or non-goal, or a line in Decisions such as `- 2026-11-05: Won't add multiplayer. Why: it would double the testing for a game made by one person.`

## 6. Write

1. Write nothing until the user approves the draft or the edits. Then write a new file with Write, or change an existing one with Edit, keeping its wording and its own sections.
2. Show what changed: `git diff -- PROJECT.md`, or the new file in full.
3. If no instruction file imports PROJECT.md yet, offer to add the import, so Claude reads it in every session. Look for `@PROJECT.md` in ./CLAUDE.md, ./.claude/CLAUDE.md and ./AGENTS.md, and don't add it twice. Add it to whichever of ./CLAUDE.md or ./.claude/CLAUDE.md exists. If there is neither, create ./CLAUDE.md. If the repo has an AGENTS.md and you create ./CLAUDE.md, make `@AGENTS.md` its first line: once a CLAUDE.md exists, Claude Code stops reading AGENTS.md unless CLAUDE.md imports it, and some setups never read AGENTS.md on its own. Add this line, as plain text outside backticks and code blocks, because Claude Code doesn't import a path inside them:

   ```
   See @PROJECT.md for what this project is for. If a request conflicts with its non-goals or constraints, say so before starting.
   ```

   If the user says no, save that in the project's memory and don't offer again in this repo.
4. Offer to commit PROJECT.md, and the import line if you added it, following the repo's git rules. The next review starts from that commit.
