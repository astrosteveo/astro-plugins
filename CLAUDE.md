# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## No build step

The `claude` binary runs each hooks module (`plugins/<name>/hooks/register.ts` or `.tsx`) straight from source. There's no package.json, node, bun or tsc, so don't add any. Load the `plugin-authoring` skill before writing or changing a hooks module.

## Check a change

```
claude plugin validate plugins/<name>
claude plugin test plugins/<name>                      # TypeScript tests, for a plugin with hooks/hooks.json
python3 -m unittest discover -s plugins/<name>/tests   # Python tests (test_*.py): stdlib unittest, not pytest
claude plugin validate .                               # after editing .claude-plugin/marketplace.json
uvx ruff check plugins && uvx ruff format --check plugins   # after changing Python
```

Run only the tests a plugin has: `claude plugin test` fails with "no hooks module to load" on a plugin without hooks, and unittest exits 5 with "NO TESTS RAN" on one without `test_*.py`.

The Python tests check the exact wording of SKILL.md files, plain-english's output style and bug-hunt's README, and that a skill's `allowed-tools` lists every command its body names. Rerun them after rewording any of these.

## Writing a plugin

- `claude plugin validate` refuses a plugin name that starts with `claude-`, `anthropic-`, `anthropics-` or `cc-plugin-`.
- Claude Code replaces `$ARGUMENTS` in a SKILL.md body with the skill's arguments when it loads, even inside backticks. Don't write it where you mean the word itself.

## See it working

Check each change in a second Claude Code session in tmux, with the `try-plugin` skill. Never drive the user's own session. End a change with a capture of the screen that shows it working, alongside the passing tests.

## Commits and releases

- The commit scope is the plugin's name, such as `fix(gates): …`. A change across the repo takes no scope.
- A user-visible change to a plugin also updates its README, and its description in both `plugin.json` and `.claude-plugin/marketplace.json` when those no longer fit.
- After each user-visible feat or fix, bump `version` in the plugin's `plugin.json` in a commit of its own: `chore(<name>): release X.Y.Z so installs get …`. Installs from GitHub stay on the old version until it changes.
- A new plugin starts at version 0.1.0 in its feat commit, with no release commit.
- Adding or dropping a plugin also updates PROJECT.md: the plugin count and list, Decisions and Status.
