---
name: review
description: Review the repo's PROJECT.md, the committed document that says what the project is for - the problem, who it's for, goals, non-goals, what success and failure look like, priorities, constraints and decisions. Reviews it against what changed since its last commit and asks the user about drift, stale lines and open questions. With a section as the argument, reviews that section. With an idea as the argument, checks the idea against the project's scope. Use when the user asks to review, refine or update PROJECT.md or the project's scope or goals, or asks whether an idea fits the project. When the repo has no PROJECT.md yet, /project-md:init starts one instead.
argument-hint: "[a section to focus on, or an idea to check against the scope]"
allowed-tools: Bash(git rev-parse *), Bash(git status *), Bash(git log *), Bash(git diff *)
---

# Review PROJECT.md

PROJECT.md, at the repo root, says what the project is for: the problem it solves, who it's for, what it will and won't do, and how to tell whether it worked. CLAUDE.md says how to work in the repo; PROJECT.md says what the work is for. This plugin loads it into every session, so Claude has it without a CLAUDE.md importing it. It grows with the project.

This skill was invoked with: `$ARGUMENTS`

The user runs this skill as often as they like, to stay on track. A run changes PROJECT.md only with the user's approval, and a run right after another finds nothing to raise. Three rules make that hold:

- The file has no review date or "last updated" line. The last commit that touched PROJECT.md marks the last review.
- Every finding the user answers is written into the file (step 3), even "keep it as it is", and a finding the file already answers is not raised again.
- The file has one copy of each section, in this order: What it is, The problem, Who it's for, Goals, Non-goals, Success looks like, Failure looks like, Priorities, Constraints, Decisions, Open questions, Glossary, Status. Its own extra sections and the user's wording stay as they are unless the user approves a change.

## 1. Look at the repo

Run these in one turn:

```
git rev-parse --show-toplevel
git status --short
git log -1 --format='%h %cs' -- :/PROJECT.md
```

If the folder is not a git repo, work in the current folder as the repo root, skip the history in step 2, and say the review can't see what changed. If the repo has no commits yet, or PROJECT.md was never committed, there is no baseline: step 2 says what to do.

At the repo root, read PROJECT.md, and the README, CLAUDE.md, .claude/CLAUDE.md and AGENTS.md that exist. If there is no PROJECT.md, there is nothing to review or check an idea against: say so, offer to start one with `/project-md:init`, and stop.

Then pick what to do:

- **The arguments name a section** of PROJECT.md, such as `non-goals`: review that section only (step 2).
- **The arguments name anything else**: it's an idea to check (step 4).
- **No arguments**: review the whole file (step 2).

## 2. Review PROJECT.md

Find what changed since PROJECT.md's last commit, the hash from step 1:

```
git log --oneline HASH..HEAD
git diff --stat HASH..HEAD
```

Read a commit's changes (`git log -p -1 COMMIT`) when its subject doesn't say enough. If PROJECT.md has uncommitted changes, read `git diff -- :/PROJECT.md`: the user may have edited it by hand, and those edits are theirs. If it was never committed, or the repo has no commits, review it against `git log --oneline -30` and the files, and say it has no committed baseline yet.

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
  - A section from the list above that's missing, or a `Not decided yet.` that the repo now answers.
  - Status that reads as a log of past changes rather than where the project stands, or holds something that changes with every commit, such as a commit count.
  - Over 150 lines: propose folding old Decisions into fewer lines and cutting Status to where things stand now.

Drop any finding the file already answers: a decision, non-goal or open question that covers it. Review the scope, not the code: don't run, test or change the code.

Report one line on whether the work is on track with the goals. Then list the findings, numbered, each with its evidence (a commit or a line of the file) and the edit you propose. Then ask the questions only the user can answer, in plain text, not with AskUserQuestion. If there are no findings, say PROJECT.md is current and stop without changing anything.

## 3. Record the answers

Draft an edit for each finding the user answers:

- A change of scope goes in Goals, Non-goals or Constraints, in the user's words.
- Work the user keeps although it's outside the goals goes in Decisions, with their reason. Otherwise the next review raises it again.
- A success check met or a question answered updates its section. An answered open question moves to Decisions.
- A new status rewrites Status as where the project stands now: what works, what's next and what's parked. Keep a past change only while it's still useful context, and drop finished work and anything Decisions, What it is or a README already records. Don't add a line per change: Status stays a few lines however long the project runs.

A Decisions line reads `- YYYY-MM-DD: what was decided. Why: the reason.`, dated today. For example: `- 2026-11-05: Kept the level editor, though it's not a goal. Why: it makes testing levels faster.`

## 4. Check an idea

Compare the idea with Goals, Non-goals, Priorities, Constraints and Decisions. Say whether it fits, conflicts (quote the line it conflicts with) or isn't covered. Recommend doing it, not doing it, or changing the scope first, and say why. Once the user decides, record it as step 3 does: a new goal or non-goal, or a line in Decisions such as `- 2026-11-05: Won't add multiplayer. Why: it would double the testing for a game made by one person.`

## 5. Write

1. Write nothing until the user approves the edits. Then change PROJECT.md with Edit, keeping its wording and its own sections.
2. Show what changed: `git diff -- :/PROJECT.md`.
3. Offer to commit PROJECT.md, following the repo's git rules. The next review starts from that commit. Don't add an import of PROJECT.md to CLAUDE.md: this plugin loads it into every session.
