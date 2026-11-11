# astro-plugins

Personal Claude Code plugins that remove the frictions a solo developer runs into session after session.

## What it is

A public Claude Code plugin marketplace with eight plugins, each installed on its own: inline-thinking, gates, global-memory, global-rules, github-tracking, screen-polish, project-md and bug-hunt. Install one with `/plugin install NAME --marketplace astrosteveo/astro-plugins`.

## The problem

Claude Code's defaults don't fit how the author works. It folds its thinking into "Thought for 4s", runs risky commands like `git add -A` or `pkill`, forgets preferences between projects, doesn't keep GitHub in step with the work, and drifts from a project's scope. Without the plugins, the author corrects the same things session after session.

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
- Hook plugins are written in TypeScript. Skill scripts use only Python 3.8+'s standard library.
- Runs on Linux without assuming a distro, and on Windows where it can. A plugin that doesn't work on Windows says so in its README.
- MIT license, public on GitHub.

## Decisions

- 2026-11-10: github-tracking says what to keep on GitHub and leaves how the work is done (branches, commits, what goes in a change, labels) to the user's CLAUDE.md and the repo's rules. Why: its own workflow rules contradicted the author's global CLAUDE.md.
- 2026-11-10: Plugins aim to support both Linux, on any distro, and Windows, replacing the Linux-only constraint and the Windows non-goal. Why: the author works on WSL now and wants the plugins not to depend on one setup; Windows support may lag behind Linux.

## Open questions

None yet.

## Glossary

- Mod: a plugin whose TypeScript hooks module (`hooks/register.ts` or `.tsx`) changes Claude Code's interface or behavior.
- Gate: a check in the gates plugin that refuses a risky Bash command and tells Claude why and what to run instead.
- Global memory: a memory Claude writes that holds in every project, kept in `~/.claude/memory`.

## Status

Eight plugins are published. bug-hunt (#67) hunts bugs across a whole codebase, component by component, and reproduces each finding; it leaves reviewing changes to Claude Code's /code-review. global-rules took /global-memory:suggest out of global-memory as /global-rules:suggest (#55), global-memory gained /global-memory, a menu to browse, read and delete global memories (#56), and github-tracking now follows the user's own workflow rules instead of setting its own (#63). Parked: #44, letting memory recall pick global memories, until recall can be turned on in local sessions.
