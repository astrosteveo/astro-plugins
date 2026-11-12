---
name: init
description: Set up GitHub tracking for a repo with a GitHub remote - a Projects board linked to the repo, with views of its open work, milestones and recently done issues, the labels and milestones its work needs, and its open issues on the board. On a repo that already has a board, adds only what's missing, such as the views. Use when the user asks to set up, start or initialize a GitHub project, board, views or issue tracking for a repo, or says yes to setting one up.
allowed-tools: Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/board.py *), Bash(gh repo view *), Bash(gh label list *), Bash(gh issue list *)
---

# Set up tracking on GitHub

The track skill keeps a repo's issues, milestones and Projects board true while Claude works. This skill gives the repo what that needs: a board linked to the repo, with a Status of Todo, In Progress or Done, its views, labels for the repo's kinds of change, and milestones for the steps already planned. Each step checks what's there and adds only what's missing, so a second run changes nothing.

`board.py` makes the board's API calls. It finds the board linked to the repo you're in. Pass `--project NUMBER` when a repo has more than one.

```
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/board.py show                    # where the board stands, or that the repo has none
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/board.py views                   # give the board its views
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/board.py move 12 Todo            # an issue or PR, by number or URL
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/board.py update on-track FILE    # a status update, its body from FILE or - for stdin
```

If gh says it lacks the `project` scope, ask the user to run `! gh auth refresh -s project`.

Labels and milestones follow the user's CLAUDE.md and the repo's own rules, such as the labels its issues use or what its milestones stand for. Where they say something, follow them over this skill.

## 1. Look at the repo

Run these in one turn:

```
gh repo view --json nameWithOwner --jq .nameWithOwner
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/board.py show
gh label list --limit 100
gh issue list --state open --limit 200 --json number,title
```

If the repo has no GitHub remote, say tracking needs one and stop. The first command prints `OWNER/NAME` for the commands below. If `show` says the repo has several boards, ask the user which one and pass `--project NUMBER` to every `board.py` command from then on.

## 2. Make the board

Skip this if `show` printed a board. If it says no board is linked to the repo, make one and link it. A new board has a Status field with Todo, In Progress and Done:

```
gh project create --owner OWNER --title "NAME" --format json --jq .number
gh project link NUMBER --owner OWNER --repo OWNER/NAME
```

## 3. Give it its views

Run `board.py views`, unless the user has said they don't want them. It adds Open work (a column per status), Milestones (open issues grouped by milestone) and Recently done (closed in the last two weeks), each with an issue's PRs in its row. It adds only the ones the board lacks, removes the "View 1" a new board starts with if no one has changed it, and leaves other views alone.

## 4. Labels and milestones

1. Make the labels that are missing for the repo's kinds of change, with `gh label create NAME --description TEXT --color HEX`.
2. Make a milestone for each larger step that's already planned, in PROJECT.md, the README, the open issues or what the user said, and isn't among the open milestones `show` lists: `gh api repos/OWNER/NAME/milestones -f title=TITLE -f description=TEXT`. If no step is planned yet, make none.

## 5. Check its workflows

Run `show` again. A new board has its workflows on. If it lists Item closed, Pull request merged or Auto-add sub-issues as off, ask the user to turn them on in the board's Workflows settings, as the API can't turn on a workflow.

## 6. Put the open issues on it

Put each open issue that's not on the board on it as Todo: `board.py move N Todo`. `show` lists every item that isn't done, and marks an open one at Done, so an open issue it doesn't list isn't on the board. Leave the ones it lists where they are.

If `show` says there's no status update yet, post one: a few plain lines on what's open and what comes first. Write the body to a file and pass it: `board.py update on-track FILE`.

## 7. Report

Say what you added and what was already there, with the board's URL from `show`.
