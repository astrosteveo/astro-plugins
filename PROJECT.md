# astro-plugins

Personal Claude Code plugins that remove the frictions a solo developer runs into session after session.

## What it is

A public Claude Code plugin marketplace with six plugins, each installed on its own: inline-thinking, gates, global-memory, github-tracking, screen-polish and project-md. Install one with `/plugin install NAME --marketplace astrosteveo/astro-plugins`.

## The problem

Claude Code's defaults don't fit how the author works. It folds its thinking into "Thought for 4s", runs risky commands like `git add -A` or `pkill`, forgets preferences between projects, doesn't keep GitHub in step with the work, and drifts from a project's scope. Without the plugins, the author corrects the same things session after session.

## Who it's for

The author: a solo developer on Arch Linux who uses Claude Code for hobby projects. The repo is public, so anyone can install the plugins, but they're built around the author's workflow. They're not meant for teams or for Windows.

## Goals

1. Each plugin removes one friction that keeps coming up in Claude Code sessions, and installs on its own.
2. Plugins build on Claude Code's current docs and APIs, rather than copying its behavior.
3. A plugin ships only after it's tested and seen working in a real session.

## Non-goals

- Windows support. Why: the author works on Linux.
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
- Linux only.
- MIT license, public on GitHub.

## Decisions

None yet.

## Open questions

None yet.

## Glossary

- Mod: a plugin whose TypeScript hooks module (`hooks/register.ts` or `.tsx`) changes Claude Code's interface or behavior.
- Gate: a check in the gates plugin that refuses a risky Bash command and tells Claude why and what to run instead.
- Global memory: a memory Claude writes that holds in every project, kept in `~/.claude/memory`.

## Status

Six plugins are published. In progress: #55 moves /global-memory:suggest into its own plugin, global-rules, and #56 adds a /global-memory menu to browse, read and delete global memories. Parked: #44, letting memory recall pick global memories, until recall can be turned on in local sessions.
