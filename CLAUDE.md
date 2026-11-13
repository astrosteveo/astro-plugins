# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## No build step

The `claude` binary runs each hooks module (`plugins/<name>/hooks/register.ts` or `.tsx`) straight from source. There's no package.json, node, bun or tsc, so don't add any. Load the `plugin-authoring` skill before writing or changing a hooks module.

## Check a change

```
claude plugin validate plugins/<name>
claude plugin test plugins/<name>                      # TypeScript tests (*.test.ts, *.test.tsx)
python3 -m unittest discover -s plugins/<name>/tests   # Python tests: stdlib unittest, not pytest
claude plugin validate .                               # after editing .claude-plugin/marketplace.json
uvx ruff check plugins && uvx ruff format plugins      # after changing Python
```

The Python tests check the exact wording of SKILL.md and README files, and that a skill's `allowed-tools` lists every command its body names. Rerun them after rewording either.

## See it working

Run a second Claude Code session with the plugin loaded in a detached tmux session, drive it with keys and read the screen back. Never drive the user's own session.

```
tmux new-session -d -s mod -x 220 -y 60 -c "$PWD" 'claude --plugin-dir plugins/<name>'
# Wait for the prompt box (its placeholder starts with: Try ") before typing.
# Keys sent while Claude is still starting are lost.
tmux send-keys -t mod 'Read README.md and summarise it'
tmux send-keys -t mod C-m        # submit with its own C-m; Enter sent with the text doesn't submit
tmux capture-pane -t mod -p      # read the screen
tmux kill-session -t mod         # always clean up
```

- Wait on the screen, not the clock: poll `tmux capture-pane -t mod -p | grep -q '<text>'` in an until-loop.
- A first launch may stop at a trust or login prompt. Read the capture and answer it with `send-keys`.
- After editing the plugin, send `/reload-plugins` to the tmux session to pick up the change.
- End a change with a capture of the screen that shows it working, alongside the passing tests.

## Commits and releases

- The commit scope is the plugin's name, such as `fix(gates): …`. A change across the repo takes no scope.
- A user-visible change to a plugin also updates its README, and its description in both `plugin.json` and `.claude-plugin/marketplace.json` when those no longer fit.
- After each user-visible feat or fix, bump `version` in the plugin's `plugin.json` in a commit of its own: `chore(<name>): release X.Y.Z so installs get …`. Installs from GitHub stay on the old version until it changes.
- Adding or dropping a plugin also updates PROJECT.md: the plugin count and list, Decisions and Status.
