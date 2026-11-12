# project-md

Gives each project a `PROJECT.md`: a document committed with the code that says what the project is for. `/project-md:init` drafts it, and `/project-md:review` reviews it as the project grows. Run the review as often as you like to keep the work on track: a run with nothing new changes nothing. Claude also runs either one when you ask it to start or review PROJECT.md.

```
/plugin install project-md --marketplace astrosteveo/astro-plugins
```

`CLAUDE.md` says how to work in a repo. `PROJECT.md` says what the work is for, so Claude can tell a feature that fits from one that doesn't, settle small tradeoffs your way, and stop proposing ideas you've already turned down.

## Use

```
/project-md:init                        # draft a first PROJECT.md
/project-md:review                      # review PROJECT.md against what changed
/project-md:review non-goals            # review one section
/project-md:review add multiplayer      # check an idea against the scope
```

| When | What Claude does |
| --- | --- |
| You run init | Fills in what the repo shows (what it is, the stack, the license), asks you the rest a few questions at a time, each with a suggestion, then shows the whole draft. If PROJECT.md already exists, it offers a review instead |
| You run review | Reads what changed since PROJECT.md's last commit and reports whether the work is on track, with numbered findings: work a non-goal rules out, success checks now met, decisions the file doesn't record, questions the commits answered, vague or stale lines. Then it asks what only you can answer |
| You name an idea | Says whether it fits, conflicts (quoting the line) or isn't covered, recommends what to do, and records your decision |
| You answer | Drafts the edits: scope changes in your words, and work you keep anyway goes in Decisions with your reason, so it isn't raised again |
| You approve | Writes the file and offers to commit. A review shows the diff too |

Neither writes anything until you approve, and review checks the scope, not the code. Review with no PROJECT.md offers to run init.

## The file

The sections, in order: What it is, The problem, Who it's for, Goals, Non-goals, Success looks like, Failure looks like, Priorities, Constraints, Decisions, Open questions, Glossary and Status. The template, with a note under each heading on what goes there, is in [`skills/init/SKILL.md`](skills/init/SKILL.md), under "Draft PROJECT.md". It sits inside the skill, not in a file beside it, because Claude Code asks before it reads a file outside the project, and an installed plugin always is outside. For the same reason, review keeps its own list of the sections, and a test checks the two agree.

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

PROJECT.md costs context in every session, like CLAUDE.md. Claude Code's docs aim to keep that under 200 lines, so the skills keep PROJECT.md under 150, and review proposes folding old decisions when it grows past that. Review rewrites Status as where things stand rather than adding a line per change, so Status stays a few lines.

## Tests

```
python3 -m unittest discover -s plugins/project-md/tests
claude plugin validate plugins/project-md
claude plugin test plugins/project-md
```
