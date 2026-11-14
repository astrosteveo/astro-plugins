# github-tracking

Keeps a repo's GitHub issues, milestones and Projects board true while Claude works, so you can see on GitHub where a project stands instead of asking. Two skills: `/github-tracking:init` sets up a repo's board, and `track` keeps it true as you work. Claude loads track whenever it starts, plans, files or finishes work in a repo with a GitHub remote, or you ask where a project stands. You can also run it as `/github-tracking:track`.

```
/plugin install github-tracking --marketplace astrosteveo/astro-plugins
```

## Set up a repo

```
/github-tracking:init
```

Run it in a repo with a GitHub remote, or ask Claude to set up a board. It makes a Projects board and links it to the repo, gives it its views, makes the labels and milestones the work needs, checks the board's workflows, puts the open issues on the board and posts a first status update. On a repo that already has a board, it adds only what's missing, so running it on an older board gives the board its views.

## What Claude does

| When | What |
| --- | --- |
| A change starts | Finds or opens its issue, with a label for its kind and its milestone, and puts it on the board as In Progress |
| A PR opens | Its body says `Closes #N`, and it goes on the board too |
| A PR merges | Checks the board moved both to Done, and closes a milestone whose last issue closed |
| Something turns up | Whatever doesn't go in the current change gets its own issue, on the board as Todo |
| A larger step is planned | One parent issue in its milestone: what exists today, then open questions with recommendations. Once you decide them, it splits into sub-issues |
| Where things stand changes | A short status update on the board: what's done, what's next, what's in the way |
| You ask where a project is | Answers from the board, the milestones and git, and fixes what's out of step |
| A repo has no board | Offers to set one up with `/github-tracking:init` |

The skills say what to keep on GitHub, not how to do the work: branches, commits, what goes in a change and how issues are labelled follow your CLAUDE.md and the repo's own rules. Those rules can also say what the repo's milestones stand for; the skills follow them over their own.

## The script

`scripts/board.py` makes the board's API calls through the `gh` CLI, for both skills. It finds the board linked to the repo and that board's Status field, so no CLAUDE.md keeps a project's ids.

```
board.py show                       # open milestones, items not done, workflows off, the latest status update
board.py move 12 "In Progress"      # an issue or PR by number or URL, added to the board if it isn't there
board.py sub 10 11 12               # 11 and 12 become sub-issues of 10
board.py update on-track FILE       # a status update: on-track, at-risk, off-track, complete or inactive
board.py views                      # the board's views of its open work, milestones and recently done issues
```

`--repo OWNER/NAME` works on another repo's board, and `--project NUMBER` picks one when a repo has several. It needs `gh` signed in with the `project` scope (`gh auth refresh -s project`) and Python 3.11 or later. Stdlib only.

## Views

A new board has one view, "View 1": a table of every issue and PR, done or not. `views` gives the board three views of its issues instead, each showing an issue's PRs in its row:

| View | Shows |
| --- | --- |
| Open work | Open issues on a board, a column per status, with labels, milestone, PRs and sub-issue progress |
| Milestones | Open issues grouped by milestone, with status, labels, PRs and sub-issue progress |
| Recently done | Issues closed in the last two weeks, with labels, milestone and the PRs that closed them |

It adds only the ones the board lacks, by name, and removes View 1 if no one has changed it, so the board opens on Open work. `show` lists the ones a board is missing, and `/github-tracking:init` adds them. GitHub's API can't show or sort by the Created, Updated or Closed dates, so Recently done keeps to two weeks rather than putting the newest first.

## Workflows

The board's own workflows do part of the job: Item closed and Pull request merged move items to Done, and Auto-add sub-issues puts a step's sub-issues on the board. A new board has them on. `show` lists any that are off, and the API can't turn one on, so you switch them on in the board's Workflows settings.

## Tests

```
python3 -m unittest discover -s plugins/github-tracking/tests
claude plugin validate plugins/github-tracking
```
