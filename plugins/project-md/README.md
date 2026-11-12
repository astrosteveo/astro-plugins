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
| You approve | Writes the file, shows the diff and offers to commit |

It writes nothing until you approve, and it reviews the scope, not the code.

## The file

The sections, in order: What it is, The problem, Who it's for, Goals, Non-goals, Success looks like, Failure looks like, Priorities, Constraints, Decisions, Open questions, Glossary and Status. The template, with a note under each heading on what goes there, is in [`skills/review/SKILL.md`](skills/review/SKILL.md), under "Draft PROJECT.md". It sits inside the skill, not in a file beside it, because Claude Code asks before it reads a file outside the project, and an installed plugin always is outside.

What keeps repeated runs quiet:

- No review date in the file. The last commit that touched PROJECT.md marks the last review, so commit it after each session.
- Every finding you answer is written down, even "keep it as it is", and a finding the file already answers isn't raised again.
- One copy of each heading. Your own sections and wording stay unless you approve a change.

## Loading it in every session

The plugin loads PROJECT.md for you, so your CLAUDE.md doesn't need to import it. When a session starts, a hook looks for PROJECT.md at the root of the git repo you're in, or in the session's folder outside a repo. If it's there, the hook adds it to the files Claude Code sends with your first message, the same way it sends CLAUDE.md, and starts it with this line:

```
PROJECT.md says what this project is for. If a request conflicts with its non-goals or constraints, say so before starting.
```

Claude Code sends the file again after a compaction or `/clear`. With no PROJECT.md, the hook does nothing. If a CLAUDE.md already imports PROJECT.md with `@PROJECT.md`, the hook skips it so it doesn't load twice, and you can delete that line. Since the hook does the loading, PROJECT.md loads only where project-md is installed. Someone who clones the repo without the plugin doesn't get it.

PROJECT.md costs context in every session, like CLAUDE.md. Claude Code's docs aim to keep that under 200 lines, so the skill keeps PROJECT.md under 150 and proposes folding old decisions when it grows past that.

## Tests

```
python3 -m unittest discover -s plugins/project-md/tests
claude plugin validate plugins/project-md
claude plugin test plugins/project-md
```
