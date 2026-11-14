---
name: init
description: Set up or improve CLAUDE.md files, and optionally skills and hooks - a project's CLAUDE.md, a personal CLAUDE.local.md, and the global ~/.claude/CLAUDE.md that loads in every project. A fork of Claude Code's new /init that shows every draft before asking to write it, and adds the global file. Use when the user asks to set up, start, redo or review a project's CLAUDE.md, a CLAUDE.local.md or their global CLAUDE.md. For a one-line change to one of these files, edit the file instead.
allowed-tools: Read, Bash(git worktree list), Bash(git remote -v), Bash(which gh), Bash(cp ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.bak)
---

# Set up CLAUDE.md files

Set up minimal CLAUDE.md files, and optionally skills and hooks. CLAUDE.md files load into every Claude Code session, so each must be short: include only what Claude would get wrong without it.

| File | Loads in | Holds |
| --- | --- | --- |
| `./CLAUDE.md` (project) | every session in this repo, for everyone who clones it | the repo's commands, conventions and gotchas |
| `./CLAUDE.local.md` (personal) | every session in this repo, for this user only | their role, sandbox URLs, local setup |
| `~/.claude/CLAUDE.md` (global) | every session in every project on this machine | how the user works anywhere: tools, shell, workflow, how they want answers |

## What the user must read goes in your reply

- Print the primer (Phase 0) as the first text of your reply, before any tool call.
- Show every draft and every list of edits as your reply, and end your turn there. The user's next message is their answer. Don't ask for approval with AskUserQuestion. When Claude writes text after a tool call and then calls AskUserQuestion in the same turn, the text tends to stay in its thinking, and the user is asked to approve something they never saw.
- Use AskUserQuestion only for questions that stand on their own. Each names what it's about, and the evidence it rests on, in the question itself.

## Phase 0: Print the primer and check what exists

Print this as the first text of your reply, before any tool call:

> Quick context:
> - **CLAUDE.md** files give Claude persistent instructions: for a project (`CLAUDE.md`), for you in one project (`CLAUDE.local.md`), or for you in every project (`~/.claude/CLAUDE.md`). Claude reads them at the start of every session.
> - **Skills** are packaged instructions Claude invokes automatically when a task matches, or that you trigger with a slash command (e.g. `/frontend-design`).
> - **Hooks** run shell commands automatically on lifecycle events: get notified when Claude is waiting on you, format after edits, enforce checks. They're deterministic, so Claude can't skip them.

Then read these with the Read tool, and don't explore the tree yet: `./CLAUDE.md` at the project root (only the root file counts), `./CLAUDE.local.md` and `~/.claude/CLAUDE.md`. Note which exist and how many lines each has.

## Phase 1: Ask what to set up

Call AskUserQuestion with only this question, with `multiSelect: true`:

- "Which CLAUDE.md files should we set up? Pick one or more."
  - "Project CLAUDE.md": "Shared instructions checked into the repo: commands, conventions, gotchas."
  - "Personal CLAUDE.local.md": "Your private notes for this project, gitignored: your role, sandbox URLs, local setup."
  - "Global ~/.claude/CLAUDE.md": "Your preferences for every project on this machine: tools, shell, workflow, how you want answers."
  - "Let Claude decide": "Fastest path: project CLAUDE.md plus whatever skills or hooks fit this repo. No more setup questions; you'll approve everything before it's written."

End each file option's description with what Phase 0 found, such as "Exists, 40 lines." or "None yet." If the folder isn't a git repo, say so in the question: a CLAUDE.md there loads in every project below it.

How the answer routes:

- **"Let Claude decide"** skips the rest of this phase. On its own it means the project CLAUDE.md, with skills and hooks chosen to fit the repo. Picked with files, it means those files. Review and improve any picked file that already exists. Don't replace it.
- **No CLAUDE.md at all** (an "Other" answer asking only for skills or hooks): ask only Q2 below, with its fourth option renamed "Neither, skip setup". If they pick that, go to Phase 8 with "Nothing to set up. Your CLAUDE.md files are unchanged."
- **Otherwise**, call AskUserQuestion once more, with these questions together:
  - For each picked file that exists: "`<path>` already exists (N lines). What should we do with it?" Options: "Review and improve it" ("Explore what's changed and propose targeted edits to the existing file.") | "Start fresh (replace it)" ("Discard it and draft a new one.").
  - Q2: "Also set up skills and hooks?" Options: "Skills + hooks" | "Skills only" | "Hooks only" | "Neither, just CLAUDE.md". For skills: "Packaged instructions Claude invokes automatically when a task matches, or that you trigger with a slash command (e.g. `/frontend-design`)." For hooks: "Deterministic shell commands that run on tool events (e.g., format after every edit). Claude can't skip them." Q2 is a hint, not a filter: Phase 4 proposes what fits and says where it differs.

Where skills and hooks go:

- With the project or personal file picked: skills in `.claude/skills/`, hooks in `.claude/settings.json`, or in `.claude/settings.local.json` when only the personal file was picked.
- With only the global file picked: skills in `~/.claude/skills/`, hooks in `~/.claude/settings.json`.
- With both: each goes where it applies, this repo or every project.

## Phase 2: Explore

Launch a subagent for each survey the picked files need, in parallel. Tell each to read only, never edit, and to report what it couldn't find out.

**Project survey**, for the project or personal file, or skills and hooks for this repo. Read the key files: manifest files (package.json, Cargo.toml, pyproject.toml, go.mod, pom.xml, etc.), README, Makefile and build configs, CI config, existing CLAUDE.md, .claude/rules/, AGENTS.md, .cursor/rules or .cursorrules, .github/copilot-instructions.md, .devin/rules/ or .windsurf/rules/ or .windsurfrules, .clinerules and .mcp.json. Detect:

- Build, test and lint commands (especially non-standard ones)
- Languages, frameworks and package manager
- Project structure (monorepo with workspaces, multi-module, or single project)
- Code style rules that differ from language defaults
- Non-obvious gotchas, required env vars or workflow quirks
- Existing .claude/skills/ and .claude/rules/ directories
- Formatter configuration (prettier, biome, ruff, black, gofmt, rustfmt, or a unified format script like `npm run format` or `make fmt`)
- Git worktrees, with `git worktree list` (only when the personal file was picked)

**Global survey**, for the global file. It's about the user, not one repo:

- Their Claude Code setup: `~/.claude/CLAUDE.md` and `~/.claude/rules/`; `~/.claude/settings.json` (env, hooks, permissions, output style, enabled plugins); the file of the active output style, whether settings set it or a plugin turns it on, so the global file doesn't repeat it; `~/.claude/skills/` and `~/.claude/agents/`; the global memories in `~/.claude/memory/` if it exists, and each project's memories in `~/.claude/projects/*/memory/`, flagging any project memory that is really a preference for every project.
- Their projects: the folders their recent sessions ran in, from the `cwd` field of the transcripts under `~/.claude/projects/`. In each: the manifests, CI, formatter and linter config, CLAUDE.md or AGENTS.md, and the last 20 commits for commit style. Report what repeats across projects, not what one project does.
- Their machine: the OS and distro, how system packages are installed, the shell and whether its aliases reach Claude's Bash tool (such as `cat` running `bat`), and which toolchains and package managers are installed.
- Their corrections: the user's own messages in the 40 most recent transcripts under `~/.claude/projects/*/`, skipping tool results, command wrappers and pasted text. Look for instructions given more than once, and corrections such as "don't", "stop", "I said" or "use X, not Y". For each, give the instruction in one line, how often it came up and one short quote. Rank what holds in any project first. Leave out names, emails and secrets.

Note what the surveys couldn't find out: those become the Phase 3 questions.

## Phase 3: Fill in the gaps

Use AskUserQuestion for what the files can't answer, and nothing else, at most four questions per call. Don't mark options "(Recommended)": these are about how the user works, not best practice.

- **Project file**: codebase practices, such as non-obvious commands, gotchas, branch and PR conventions, required env setup and testing quirks. Skip what the README or manifests already say.
- **Personal file**: the user, not the codebase: their role, how familiar they are with the codebase and its languages, personal sandbox URLs, test accounts or local setup, and communication preferences. If Phase 2 found several worktrees, ask whether they're nested inside the main repo (such as `.claude/worktrees/<name>/`) or siblings (such as `../myrepo-feature/`).
- **Global file**: how they work in every project: when Claude should decide and when it should ask, the default git workflow, what to check before calling work done, and how they want answers if no output style covers it. Ground each question in what the survey found, such as "Four of your repos use feature branches and PRs; one commits to main."
- **A file to review and improve**: one question: "Has anything changed about how you work since `<path>` was written?" with options "No, nothing's changed" | "Yes, let me describe". If yes, ask what changed before going on.

Then sort each finding:

- **Hook**: a deterministic, fast shell command on each edit (formatting, linting a changed file).
- **Skill**: an on-demand workflow with several steps (`/verify`, `/deploy-staging`, session reports).
- **CLAUDE.md line**: guidance that shapes behavior but isn't enforced, in the file it belongs to: the repo's, the user's own for this repo, or every project's.
- **Nowhere**: what Claude does anyway, what it can read from the code, and what another loaded file already says (an output style, a hook, a permission rule, a global memory).

## Phase 4: Show the drafts and end your turn

Draft every picked file under "What goes in each file" below. Then reply with, in this order:

1. If the skills and hooks differ from the Q2 hint, one line saying so, such as "You said hooks only, but nothing here is hook-shaped."
2. Each new or replaced file in full, in a fenced markdown block under its path.
3. For each file to review and improve: numbered edits, each a `diff` block with the lines removed and added, and one line of why. The existing file is the baseline: catch what's missing, outdated or bloated.
4. One bullet per skill and hook: `**Skill**` or `**Hook**`, its name, what it does and its target file. For a skill, add why it fits.
5. A last line asking the user to reply "write it", to pick edits by number ("1, 3"), or to say what to change.

End your turn there. Write nothing until the user replies. If they ask for changes, show the changed draft the same way and end your turn again.

## Phase 5: Write the files

Write what the user approved, with the changes they asked for. In a file that already exists, make only the approved edits.

- **Project CLAUDE.md**: at the project root.
- **CLAUDE.local.md**: at the project root, then add `CLAUDE.local.md` to the project's `.gitignore`. If the user's worktrees are siblings, put the content in `~/.claude/<project-name>-instructions.md`, make CLAUDE.local.md the one-line import `@~/.claude/<project-name>-instructions.md`, and tell the user to copy that line to each worktree. Never put this import in the project CLAUDE.md. Nested worktrees need nothing extra: Claude Code finds the main repo's CLAUDE.local.md from them.
- **Global ~/.claude/CLAUDE.md**: before you replace or edit an existing one, back it up with `cp ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.bak`, and say where the backup is. If a line you wrote repeats a global memory, say so and offer to delete the memory, so it doesn't load twice. Delete it with the `global_memory_delete` tool when it's available. Otherwise, name the memory's file and its line in `~/.claude/memory/MEMORY.md`.

### What goes in each file

Every line must pass this test: "Would removing this cause Claude to make mistakes?" If not, cut it. Be specific: "Use 2-space indentation in TypeScript" is better than "Format code properly." Don't repeat yourself, and don't make up sections like "Common Development Tasks" or "Tips for Development": include only what you found in files you read or what the user told you.

**Project CLAUDE.md.** Include:

- Build, test and lint commands Claude can't guess (non-standard scripts, flags or sequences)
- Code style rules that differ from language defaults (e.g., "prefer type over interface")
- Testing instructions and quirks (e.g., "run a single test with: pytest -k 'test_name'")
- Repo etiquette (branch naming, PR conventions, commit style)
- Required env vars or setup steps
- Non-obvious gotchas or architectural decisions
- The important parts of other AI coding tool configs, if they exist (AGENTS.md, .cursor/rules, .cursorrules, .github/copilot-instructions.md, .devin/rules/, .windsurf/rules/, .windsurfrules, .clinerules)

Exclude:

- File-by-file structure or component lists (Claude can discover these by reading the codebase)
- Standard language conventions Claude already knows
- Generic advice ("write clean code", "handle errors")
- Detailed API docs or long references: use `@path/to/import` instead (e.g., `@docs/api-reference.md`)
- Information that changes often: reference its source with `@path/to/import`, so Claude always reads the current version
- Long tutorials or walkthroughs: move them to a separate file and import it, or make them a skill
- Commands obvious from manifest files (e.g., a standard `npm test`, `cargo test` or `pytest`)

Start it with:

```
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
```

For a project with several concerns, suggest splitting instructions into `.claude/rules/` as focused files (e.g., `code-style.md`, `testing.md`). They load with CLAUDE.md, and `paths` frontmatter scopes one to matching files. For a project with distinct subdirectories, such as a monorepo, mention that a subdirectory can have its own CLAUDE.md, which loads when Claude works there, and offer to create them.

**CLAUDE.local.md.** Include the user's role and familiarity with the codebase (so Claude can calibrate explanations), personal sandbox URLs, test accounts or local setup, and personal workflow or communication preferences. Keep it short: only what would make Claude's answers noticeably better for this user.

**Global ~/.claude/CLAUDE.md.** Include:

- Their environment: the OS, how to install packages, and which toolchains and package managers to use or avoid
- Shell behavior that breaks commands, such as aliases that reach Claude's Bash tool
- Workflow defaults: branches, commits, when to decide and when to ask
- What to check before calling work done
- How they want answers, unless an output style covers it

Exclude:

- Anything about one project: it goes in that project's CLAUDE.md
- What an output style, a hook, a permission rule or a setting already covers
- What Claude does anyway, and generic advice
- Names, emails and secrets

A rule for one language or file type goes in `~/.claude/rules/<topic>.md` with `paths` frontmatter, so it loads only when Claude works with matching files. Group the lines under short headings, such as `# Environment` and `# How to work`. Don't start it with the project file's opening lines.

## Phase 6: Create skills (if the approved reply includes any)

Skills add capabilities Claude can use on demand without bloating every session. For each approved skill:

- Name it from what the user asked for (e.g., "verify-deep", "session-report", "deploy-sandbox").
- Write the body from the user's own words plus what Phase 2 found (test commands, report format, deploy target). If it extends a bundled skill (e.g., `/verify`), write a skill that adds the user's constraints on top, and tell the user the bundled one still exists.
- Ask a quick follow-up if it's underspecified (e.g., "Which test command should verify-deep run?").

Create each at `.claude/skills/<skill-name>/SKILL.md` for this repo, or `~/.claude/skills/<skill-name>/SKILL.md` for every project. Read the skills already in that folder first, and never overwrite one.

```yaml
---
name: <skill-name>
description: <what the skill does and when to use it>
---

<Instructions for Claude>
```

Both the user (`/<skill-name>`) and Claude can invoke a skill by default. For a workflow with side effects (e.g., `/deploy`, `/fix-issue 123`), add `disable-model-invocation: true` so only the user can start it, and use `$ARGUMENTS` to take input.

## Phase 7: Suggest additional optimizations

Check for these gaps, and ask about each one you find with AskUserQuestion. Each question says what you found.

- **GitHub CLI** (project or personal file): run `which gh`. If it's missing and `git remote -v` shows github.com, ask whether to install it. It lets Claude help with commits, pull requests, issues and code review.
- **Linting** (project file): if Phase 2 found no lint config for the project's language (no .eslintrc, ruff.toml, .golangci.yml, etc.), ask whether to set up linting. It catches issues early and gives Claude fast feedback on its own edits.
- **Hooks** (if the approved reply includes any): if Phase 2 found a formatter and no formatting hook was approved, offer format-on-edit too. For each hook:
  1. Its target file comes from "Where skills and hooks go" in Phase 1. Ask only when the hook could go in either, and ask once for all hooks.
  2. Pick the event and matcher from what the user asked for:
     - "after every edit": `PostToolUse` with matcher `Write|Edit`
     - "when Claude finishes" or "before I review": the `Stop` event (it fires at the end of every turn, including read-only ones)
     - "before running bash": `PreToolUse` with matcher `Bash`
     - "before committing", as a literal gate on git commit: not a settings hook, because a matcher can't filter Bash by the command's content. Offer a git pre-commit hook instead (`.git/hooks/pre-commit`, husky, or the pre-commit framework). If the user means "before I review and commit Claude's work", that's `Stop`: ask to tell them apart.
  3. Before the first hook, load the hook reference once: the Skill tool with `skill: 'update-config'` and args starting with `[hooks-only]`, followed by one line on what you're building, e.g. `[hooks-only] Constructing a PostToolUse/Write|Edit format hook for .claude/settings.json using ruff`. Later hooks reuse it.
  4. Follow its "Constructing a Hook" flow: dedup check, construct for this project, pipe-test raw, wrap, write JSON, validate with `jq -e`, live-proof (for `PreToolUse` and `PostToolUse` on matchers you can trigger), clean up, hand off.

Act on each yes before moving on.

## Phase 8: Summary and next steps

Say which files were written, with the main points in each, and where any backup is. These files are a starting point: the user should review and tweak them, and can run `/instructions:init` again any time to re-scan. `/doctor prompt-audit` checks them later for outdated or conflicting lines.

Then give a short to-do list of further suggestions, most useful first, with only what applies:

- If frontend code was detected (React, Vue, Svelte, etc.) and the plugins aren't installed: `/plugin install frontend-design@claude-plugins-official` gives Claude design principles and component patterns, and `/plugin install playwright@claude-plugins-official` lets Claude open a real browser, screenshot what it built and fix visual bugs itself.
- The gaps from Phase 7 the user said no to (GitHub CLI, linting), each with one line on why it helps.
- If tests are missing or sparse: set up a test framework so Claude can check its own changes.
- If the skill-creator plugin isn't installed: `/plugin install skill-creator@claude-plugins-official`, then `/skill-creator <skill-name>` creates new skills and refines existing ones with evals.
