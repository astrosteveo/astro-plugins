---
name: track
description: Use before you open, start, file, plan or finish any issue, PR or change in a repo with a GitHub remote, before you say where a project stands, and when such a repo has no Projects board. Keeps the repo's issues, milestones and board true, so the user can see on GitHub where the project stands: each change starts from an issue on the board, PRs close their issues, a larger step is a parent issue split into sub-issues, and status updates say what's done and next. Its script makes the board's API calls, so no project ids are needed.
allowed-tools: Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/board.py *)
---

# Track work on GitHub

The user follows each project on GitHub instead of asking: its issues, its milestones, and a Projects board linked to the repo, with a Status of Todo, In Progress or Done. Keep all three true as you work. A change that isn't on the board, or a board that says something is in progress when it merged a day ago, misleads them.

`board.py` makes the board's API calls. It finds the board linked to the repo you're in and that board's Status field, so no CLAUDE.md needs to keep a project's ids. Pass `--repo OWNER/NAME` to work on another repo's board, and `--project NUMBER` when a repo has more than one.

```
python3 ${CLAUDE_SKILL_DIR}/scripts/board.py show                    # where the board stands
python3 ${CLAUDE_SKILL_DIR}/scripts/board.py move 12 "In Progress"   # an issue or PR, by number or URL
python3 ${CLAUDE_SKILL_DIR}/scripts/board.py sub 10 11 12 13         # 11, 12 and 13 become sub-issues of 10
python3 ${CLAUDE_SKILL_DIR}/scripts/board.py update on-track FILE    # a status update, its body from FILE or - for stdin
```

`move` adds the item to the board when it isn't there yet. A status update is `on-track`, `at-risk`, `off-track`, `complete` or `inactive`. If gh says it lacks the `project` scope, ask the user to run `! gh auth refresh -s project`.

This skill says what to keep on GitHub, not how to do the work. Branches, commits, what belongs in a change and how issues are labelled and titled follow the user's CLAUDE.md and the repo's own rules. Those rules may also say what the repo's milestones stand for (such as one per slice) or which issue is a larger step's parent. Where they say something, follow them over this skill.

## Start each change from an issue

1. Find the change's issue (`gh issue list --search WORDS`) or open one. Give it the repo's label for its kind of change and the milestone of the step it belongs to.
2. Put it on the board as In Progress: `board.py move N "In Progress"`. A new issue isn't on the board until something adds it, and the API can't turn on a board's auto-add workflow, so add it yourself.

## Link the PR

- The PR's body says `Closes #N` for each issue it finishes, so merging it closes them.
- Put the PR on the board too: `board.py move PR "In Progress"`.
- After a merge, run `board.py show`. The board's Item closed and Pull request merged workflows move both to Done; move whatever they missed. When a milestone's last issue closes, close the milestone: `gh api -X PATCH repos/OWNER/NAME/milestones/M -f state=closed`.

## File what you find

Something that turns up and doesn't go in the current change, by the user's and repo's rules or because it's bigger, gets its own issue, labelled, in the milestone it belongs to, on the board as Todo (`board.py move N Todo`). Tell the user what you filed.

## Plan a larger step

A larger step (a milestone) starts as one parent issue in that milestone, before any code:

- **Today:** what exists now, naming the code it touches.
- **Open questions:** each with your recommendation and its alternative, so the user can answer with a yes.
- **Work:** filled in once the questions are decided.

Ask the user to decide the questions. Then edit the parent: the questions become **Decided**, each with its answer. Open one issue per piece of work, in the order they'll land, each leaving the project working. Give each the step's milestone and label, make them its sub-issues (`board.py sub PARENT N...`), and list them in order under **Work**. Put any the board's Auto-add sub-issues workflow didn't add on it as Todo. Post a status update saying the step is decided and what comes first.

## Post a status update

Post one when a merge or a decision changes where the project stands: a step decided or split, a sub-issue that finishes part of a step, a milestone finished, a new blocker. A routine fix doesn't need one.

Write a few plain lines for someone reading the board, with issues and PRs as `#N`: what's done, what's next, and what's in the way. Use `on-track` unless something blocks the work (`at-risk`, or `off-track` when the plan no longer holds), and `complete` when the project's planned work is all done. Write the body to a file and pass it: `board.py update on-track FILE`.

## Say where things stand

When the user asks where a project is, run `board.py show` with `git status`, `git branch -a` and `gh pr list`, and answer from them: the milestones' progress, what's in progress, what's next and what's open. `show` marks an item out of step with its issue (closed but not Done, or Done but open) and lists the board's workflows that are off. Fix what's out of step. If the latest status update no longer says where the project stands, post one.

## Set up tracking

In a repo with a GitHub remote and no board (`show` says so), offer to set one up. If the user says yes:

1. Make the board and link it to the repo. A new board has a Status field with Todo, In Progress and Done:
   ```
   gh project create --owner OWNER --title "NAME" --format json --jq .number
   gh project link NUMBER --owner OWNER --repo OWNER/NAME
   ```
2. Make the labels that are missing for the repo's kinds of change, with `gh label create`.
3. Make a milestone for each larger step that's already planned: `gh api repos/OWNER/NAME/milestones -f title=TITLE -f description=TEXT`.
4. Run `show`. A new board has its workflows on. If it lists Item closed, Pull request merged or Auto-add sub-issues as off, ask the user to turn them on in the board's Workflows settings, as the API can't turn on a workflow.
5. Put the open issues on the board, then post a first status update.

If the user says no, save that in the project's memory, and don't offer again in that repo.
