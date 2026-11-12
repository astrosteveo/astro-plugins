---
name: init
description: Start the repo's PROJECT.md, the committed document that says what the project is for - the problem, who it's for, goals, non-goals, what success and failure look like, priorities, constraints and decisions. Drafts it from the repo and a short interview, and writes it once the user approves. Use when the user asks to start, create, write or set up a PROJECT.md, or to write down a new project's scope or goals. When the repo already has a PROJECT.md, /project-md:review reviews it instead.
allowed-tools: Bash(git rev-parse *), Bash(git log *)
---

# Start PROJECT.md

PROJECT.md, at the repo root, says what the project is for: the problem it solves, who it's for, what it will and won't do, and how to tell whether it worked. CLAUDE.md says how to work in the repo; PROJECT.md says what the work is for. This plugin loads it into every session, so Claude has it without a CLAUDE.md importing it. Once it's written, `/project-md:review` keeps it current as the project grows.

## 1. Look at the repo

Run these in one turn:

```
git rev-parse --show-toplevel
git log --oneline -20
```

If the folder is not a git repo, work in the current folder as the repo root.

If PROJECT.md already exists at the repo root, don't draft another: say so, offer to review it with `/project-md:review`, and stop.

Read the README, CLAUDE.md, .claude/CLAUDE.md and AGENTS.md that exist at the repo root, and its manifests, such as Cargo.toml, package.json, pyproject.toml or project.godot.

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

<!-- Where the project stands against its goals: what works, what's next. A few lines, not a task list or a log of changes, and nothing that changes with every commit, such as a commit count. -->
````

Fill in what the repo shows: what it is, and constraints such as the stack, platforms and license, from the files you read and the commits.

The problem, who it's for, goals, non-goals, success, failure and priorities are the user's to say. What they've already said about the project, in the arguments or the conversation, counts as their answer: don't ask it again. Ask for the rest in plain text, not with AskUserQuestion, so the user can answer several in one reply. Ask at most four at a time. Give each a suggestion from what the repo shows, so the user can answer with a yes or reword it.

Then show the whole draft. It holds only what the user said or confirmed and facts from the repo. A section with no answer yet says `Not decided yet.`, and its question goes under Open questions. Keep the file under 150 lines: it loads into every session, like CLAUDE.md, and Claude Code's docs aim to keep that under 200 lines.

## 3. Write

1. Write nothing until the user approves the draft. Then write PROJECT.md at the repo root with Write, with any changes the user asked for.
2. Offer to commit PROJECT.md, following the repo's git rules. `/project-md:review` starts its first review from that commit. Don't add an import of PROJECT.md to CLAUDE.md: this plugin loads it into every session.
