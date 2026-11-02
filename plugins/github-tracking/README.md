# github-tracking

Keeps a repo's GitHub issues, milestones and Projects board true while Claude works, so you can see on GitHub where a project stands instead of asking. One skill, `track`, which Claude loads whenever it starts, plans, files or finishes work in a repo with a GitHub remote, or you ask where a project stands. You can also run it as `/github-tracking:track`.

```
/plugin install github-tracking --marketplace astrosteveo/astro-plugins
```

## What Claude does

| When | What |
| --- | --- |
| A change starts | Finds or opens its issue, with a label for its kind and its milestone, and puts it on the board as In Progress |
| A PR opens | Its body says `Closes #N`, and it goes on the board too |
| A PR merges | Checks the board moved both to Done, and closes a milestone whose last issue closed |
| Something turns up | Small fixes go in the change; anything bigger gets its own issue, on the board as Todo |
| A larger step is planned | One parent issue in its milestone: what exists today, then open questions with recommendations. Once you decide them, it splits into sub-issues |
| Where things stand changes | A short status update on the board: what's done, what's next, what's in the way |
| You ask where a project is | Answers from the board, the milestones and git, and fixes what's out of step |
| A repo has no board | Offers to set one up: the board, linked to the repo, its labels and milestones |

A repo's CLAUDE.md can add to this, such as its labels or what its milestones stand for. The skill follows it where it's more specific.

## The script

`skills/track/scripts/board.py` makes the board's API calls through the `gh` CLI. It finds the board linked to the repo and that board's Status field, so no CLAUDE.md keeps a project's ids.

```
board.py show                       # open milestones, items not done, workflows off, the latest status update
board.py move 12 "In Progress"      # an issue or PR by number or URL, added to the board if it isn't there
board.py sub 10 11 12               # 11 and 12 become sub-issues of 10
board.py update on-track FILE       # a status update: on-track, at-risk, off-track, complete or inactive
```

`--repo OWNER/NAME` works on another repo's board, and `--project NUMBER` picks one when a repo has several. It needs `gh` signed in with the `project` scope (`gh auth refresh -s project`) and Python 3.8 or later. Stdlib only.

The board's own workflows do part of the job: Item closed and Pull request merged move items to Done, and Auto-add sub-issues puts a step's sub-issues on the board. A new board has them on. `show` lists any that are off, and the API can't turn one on, so you switch them on in the board's Workflows settings.

## Tests

```
python3 -m unittest discover -s plugins/github-tracking/tests
claude plugin validate plugins/github-tracking
```
