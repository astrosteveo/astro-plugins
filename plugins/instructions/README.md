# instructions

`/instructions:init` sets up CLAUDE.md files: a project's `CLAUDE.md`, your private `CLAUDE.local.md` for it, and your global `~/.claude/CLAUDE.md`, which loads in every project. It can add skills and hooks too. It's a fork of Claude Code's new `/init` (`CLAUDE_CODE_NEW_INIT=1`, as of 2.1.325) with two changes: it shows every draft before it asks you to approve it, and it covers the global file.

```
/plugin install instructions --marketplace astrosteveo/astro-plugins
```

## Use

```
/instructions:init
```

Or ask Claude to set up or redo a CLAUDE.md. For a one-line change to one of these files, ask for the change instead.

| Step | What Claude does |
| --- | --- |
| Start | Prints a short primer, checks which of the three files exist, and asks which to set up. Pick any of Project, Personal and Global, or "Let Claude decide" |
| Choose | For each picked file that exists, asks whether to review and improve it or start fresh, and whether to set up skills and hooks too |
| Explore | A subagent surveys the repo. For the global file, another surveys your Claude Code settings, output style and memories, the projects your recent sessions ran in, your machine's tools and shell, and the corrections you gave in your last 40 sessions. That survey reads a lot: it took 13 minutes in testing |
| Fill gaps | Asks only what the files can't answer, each question with the evidence it rests on |
| Draft | Shows each new file in full and each edit to an existing file as a diff, lists the skills and hooks, then stops and waits for your reply |
| You reply | Answer "write it", pick edits by number ("1, 3"), or say what to change. Nothing is written before that |
| Write | Writes the files. Before changing `~/.claude/CLAUDE.md` it copies it to `~/.claude/CLAUDE.md.bak`. Then it creates the skills and hooks, offers the GitHub CLI and linting if they're missing, and ends with a short to-do list |

Where things go:

| You picked | CLAUDE.md file | Skills | Hooks |
| --- | --- | --- | --- |
| Project | `./CLAUDE.md` | `.claude/skills/` | `.claude/settings.json` |
| Personal | `./CLAUDE.local.md`, added to `.gitignore` | `.claude/skills/` | `.claude/settings.local.json` |
| Global | `~/.claude/CLAUDE.md` | `~/.claude/skills/` | `~/.claude/settings.json` |

## Why a fork

The new `/init` tells Claude to print its proposal as text and then ask "Does this look right?" with AskUserQuestion, in the same turn. By then the turn has already run tools, and in that spot Claude writes the proposal only in its thinking. Claude Code shows the thinking as one line ending in `· summary`, so you're asked to approve a proposal you never saw. Tested on 2.1.325 with a request to print a draft and then ask:

| Setup | Draft on screen |
| --- | --- |
| No tool call first | 3 of 3 runs |
| One tool call first | 0 of 3 |
| One tool call first, and the draft is the reply that ends the turn | 3 of 3 |

A full `/init` run left the proposal out with the plain-english output style on and with it off. `/init`'s primer, printed after its first read, was left out in 5 of 5 runs.

So this fork prints the primer before any tool call, and shows every draft and edit list as its reply and ends the turn there. It asks with AskUserQuestion only for choices that stand on their own. `/init` also writes only project files: its first question has no option for the global file.

This plugin goes once `/init` shows its proposals and covers the global file.

## Tests

```
python3 -m unittest discover -s plugins/instructions/tests
claude plugin validate plugins/instructions
```
