# project-md

Gives each project a `PROJECT.md`: a document committed with the code that says what the project is for. One skill, `/project-md:review`, drafts it and then reviews it as the project grows. Run it as often as you like to keep the work on track: a run with nothing new changes nothing.

```
/plugin install project-md --marketplace astrosteveo/astro-plugins
```

`CLAUDE.md` says how to work in a repo. `PROJECT.md` says what the work is for, so Claude can tell a feature that fits from one that doesn't, settle small tradeoffs your way, and stop proposing ideas you've already turned down.

## Use

```
/project-md:review                      # draft PROJECT.md, or review it against what changed
/project-md:review non-goals            # review one section
/project-md:review add multiplayer      # check an idea against the scope
```

| When | What Claude does |
| --- | --- |
| The repo has no PROJECT.md | Fills in what the repo shows (what it is, the stack, the license), asks you the rest a few questions at a time, each with a suggestion, then shows the whole draft |
| PROJECT.md exists | Reads what changed since PROJECT.md's last commit and reports whether the work is on track, with numbered findings: work a non-goal rules out, success checks now met, decisions the file doesn't record, questions the commits answered, vague or stale lines. Then it asks what only you can answer |
| You name an idea | Says whether it fits, conflicts (quoting the line) or isn't covered, recommends what to do, and records your decision |
| You answer | Drafts the edits: scope changes in your words, and work you keep anyway goes in Decisions with your reason, so it isn't raised again |
| You approve | Writes the file, shows the diff, offers to import it from CLAUDE.md, and offers to commit |

It writes nothing until you approve, and it reviews the scope, not the code.

## The file

The sections, in order: What it is, The problem, Who it's for, Goals, Non-goals, Success looks like, Failure looks like, Priorities, Constraints, Decisions, Open questions, Glossary and Status. The template, with a note under each heading on what goes there, is in [`skills/review/SKILL.md`](skills/review/SKILL.md), under "Draft PROJECT.md". It sits inside the skill, not in a file beside it, because Claude Code asks before it reads a file outside the project, and an installed plugin always is outside.

What keeps repeated runs quiet:

- No review date in the file. The last commit that touched PROJECT.md marks the last review, so commit it after each session.
- Every finding you answer is written down, even "keep it as it is", and a finding the file already answers isn't raised again.
- One copy of each heading. Your own sections and wording stay unless you approve a change.

## Loading it in every session

With your approval, the skill adds this line to the repo's CLAUDE.md (or `.claude/CLAUDE.md`), unless it is already there:

```
See @PROJECT.md for what this project is for. If a request conflicts with its non-goals or constraints, say so before starting.
```

Claude Code expands an `@path` outside backticks into the file's contents at session start. If the repo has an AGENTS.md and no CLAUDE.md, the new CLAUDE.md starts with `@AGENTS.md`: once a CLAUDE.md exists, Claude Code reads AGENTS.md only through that import, and with its AGENTS.md reader turned off it never reads AGENTS.md on its own.

An imported file costs context in every session, like the CLAUDE.md that imports it. Claude Code's docs aim to keep that under 200 lines, so the skill keeps PROJECT.md under 150 and proposes folding old decisions when it grows past that.

## Tests

```
python3 -m unittest discover -s plugins/project-md/tests
claude plugin validate plugins/project-md
```
