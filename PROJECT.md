# astro-plugins

Personal Claude Code plugins that remove the frictions a solo developer runs into session after session.

## What it is

A public Claude Code plugin marketplace with ten plugins, each installed on its own: inline-thinking, gates, global-memory, github-tracking, screen-polish, project-md, bug-hunt, plain-english, instructions and corkboard. Install one with `/plugin install NAME --marketplace astrosteveo/astro-plugins`.

## The problem

Claude Code's defaults don't fit how the author works. It folds its thinking into "Thought for 4s", runs risky commands like `git add -A` or `pkill`, forgets preferences between projects, doesn't keep GitHub in step with the work, drifts from a project's scope, and pads its writing with hedges and filler. Without the plugins, the author corrects the same things session after session.

## Who it's for

The author: a solo developer on Linux who uses Claude Code for hobby projects. The repo is public, so anyone can install the plugins, but they're built around the author's workflow. They're not meant for teams.

## Goals

1. Each plugin removes one friction that keeps coming up in Claude Code sessions, and installs on its own.
2. Plugins build on Claude Code's current docs and APIs, rather than copying its behavior.
3. A plugin ships only after it's tested and seen working in a real session.

## Non-goals

- Settings or features for needs other than the author's, such as team or org setups. Why: these are personal plugins for solo hobby projects.
- Doing what Claude Code already does itself. A plugin is dropped once Claude Code ships the same feature. Why: a plugin like that is upkeep with no gain.

## Success looks like

- Every plugin in the marketplace is one the author keeps installed and enabled.
- Each plugin's tests and `claude plugin validate` pass on main.
- When a Claude Code release breaks a plugin, it's fixed or dropped within a week.

## Failure looks like

- The author turns off a plugin because it gets in the way more than it helps.
- Keeping the plugins working after Claude Code updates takes more time than they save.

## Priorities

1. Never breaks or slows down a session.
2. Follows Claude Code's current docs.
3. Simple, with the fewest moving parts.
4. More features.

## Constraints

- Every plugin is listed in `.claude-plugin/marketplace.json` and passes `claude plugin validate`.
- In `plugins/`, hook plugins are written in TypeScript, and skill scripts use only Python 3.11+'s standard library, as their tests do. corkboard, listed from its own repo, follows its own rules (see Decisions).
- Plugins are all tested on Linux.
- MIT license, public on GitHub.

## Decisions

- 2026-11-10: github-tracking says what to keep on GitHub and leaves how the work is done (branches, commits, what goes in a change, labels) to the user's CLAUDE.md and the repo's rules. Why: its own workflow rules contradicted the author's global CLAUDE.md.
- 2026-11-10: Plugins aim to support both Linux, on any distro, and Windows, replacing the Linux-only constraint and the Windows non-goal. Why: the author works on WSL now and wants the plugins not to depend on one setup; Windows support may lag behind Linux.
- 2026-11-11: Plugins are tested on Linux only, replacing the aim to support Windows. They may work on Windows, but that isn't tested or guaranteed. Why: the author uses Linux again.
- 2026-11-12: project-md loads PROJECT.md with a hook instead of an @PROJECT.md line in CLAUDE.md. Why: no repo needs the line, and the hook adds PROJECT.md only when the repo has one and nothing already imports it.
- 2026-11-12: Whether a plugin gets an init skill depends on the plugin. One that scaffolds something, such as PROJECT.md (/project-md:init) or a board (/github-tracking:init), gets one; one that reviews code, such as bug-hunt, doesn't. Why: an init skill gets what a plugin scaffolds set up properly, and reviewing code has nothing to set up.
- 2026-11-12: corkboard is listed from its own repo, astrosteveo/corkboard, instead of living in `plugins/`, and follows that repo's rules: its CLI and session-start hook are Python 3.11+ with only the standard library. Why: it's a larger project with its own tests, CI and PROJECT.md, and the author chose to list it here as an exception.
- 2026-11-13: Dropped global-rules. Claude Code's new `/init` (`CLAUDE_CODE_NEW_INIT=1`) sets up a project's CLAUDE.md, CLAUDE.local.md, skills and hooks, `/doctor prompt-audit` checks instruction files, and memory carries corrections between sessions. Why: what was left, guidance for the rare edit to a short global CLAUDE.md, wasn't worth the upkeep of a hook, two skills and a docs fetcher.
- 2026-11-13: plain-english sets its rules with an output style that turns itself on (`force-for-plugin`), and hands the same text to subagents as SubagentStart context. Why: an output style is Claude Code's own way to set how Claude writes and reaches the main conversation and forks, but a subagent with its own system prompt doesn't get it, and `prompt.compose` doesn't run for one either.
- 2026-11-13: Added instructions, whose /instructions:init is a fork of the new `/init`'s prompt from Claude Code 2.1.325. It goes against Goal 2 and the non-goal of doing what Claude Code already does, on purpose. Drop its project half once `/init` shows its proposals, and the plugin once `/init` covers the global CLAUDE.md too. Why: `/init` asked "Does this look right?" with no proposal on screen in 2 of the author's runs, because after a tool call Claude writes the text it's told to print before AskUserQuestion only in its thinking (0 of 3 test runs showed it, 3 of 3 when the draft ends the turn). `/init` also has no option for the global `~/.claude/CLAUDE.md`. A `skill.prompt` hook that edits `/init`'s text was turned down: a text replacement breaks silently when the prompt changes, and the global flow is too large to add that way.
- 2026-11-13: Raised the Python floor for skill scripts and their tests from 3.8 to 3.11, the same as corkboard's. Why: no reason for 3.8 was recorded, its upstream support ended in October 2024, and neither script needs a change.

## Open questions

None yet.

## Glossary

- Mod: a plugin whose TypeScript hooks module (`hooks/register.ts` or `.tsx`) changes Claude Code's interface or behavior.
- Gate: a check in the gates plugin that refuses a risky Bash command and tells Claude why and what to run instead.
- Global memory: a memory Claude writes that holds in every project, kept in `~/.claude/memory`.

## Status

Ten plugins are in the marketplace. instructions sets up a project's CLAUDE.md and CLAUDE.local.md and the global CLAUDE.md with /instructions:init, in place of the new `/init`, which asks for approval of a proposal it didn't show. plain-english makes Claude write plain English in the main conversation and in every subagent. project-md loads PROJECT.md with a hook (#88), with /project-md:init to draft it and /project-md:review to keep it current (#92). github-tracking sets up a board, views included, with /github-tracking:init (#93). bug-hunt (#67) hunts bugs across a whole codebase and reproduces each finding, leaving reviewing changes to Claude Code's /code-review. Parked: #44, letting memory recall pick global memories, until recall can be turned on in local sessions.
