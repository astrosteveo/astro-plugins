---
name: try-plugin
description: Check a change to one of this repo's plugins in a real Claude Code session - a second session in a detached tmux session with the plugin loaded, driven with keys and read back from its screen and transcript. Use after changing a plugin, before calling the change done, and whenever asked to see a plugin working.
---

# Try a plugin in a real session

A plugin ships only after it's seen working in a real session (PROJECT.md, Goal 3). Run a second Claude Code session with the plugin loaded in a detached tmux session, drive it with keys and read the screen back. Never drive the user's own session.

## Start it

Unless the change needs this repo, make a scratch folder in your scratchpad for the session to work in. Back up any real file the plugin could write, such as `~/.claude/CLAUDE.md`, so you can check it afterwards.

```
tmux new-session -d -s mod -x 220 -y 60 -c "$PWD" 'claude --permission-mode default --plugin-dir plugins/<name>'
```

- `--permission-mode default` makes the session ask before each write. The user's settings default to bypassPermissions, so without it the test session writes real files without asking.
- When `-c` points somewhere other than this repo, give `--plugin-dir` an absolute path.
- A first launch in a new folder stops at a trust prompt. Send `Down`, then `Enter`, for "Yes, I trust this folder".
- Wait for the prompt box (its placeholder starts with `Try "`) before typing. Keys sent while Claude is still starting are lost.

## Drive it

```
tmux send-keys -t mod 'Read README.md and summarise it'
tmux send-keys -t mod C-m        # submit with its own C-m; Enter sent with the text doesn't submit
tmux capture-pane -t mod -p      # read the screen
```

- Wait on the screen, not the clock: poll `tmux capture-pane -t mod -p | grep -q '<text>'` in an until-loop.
- A question dialog ends with "Enter to select". Move with `Down` and pick with `Enter`. With several questions, each answer moves on to the next. In a multi-select, `Enter` ticks the focused option: go down to Submit, press `Enter`, then `Enter` again on "Submit answers".
- A permission prompt asks "Do you want to proceed?", and `Enter` picks Yes. Read the command first and approve only commands that read. Press `Escape` for anything else.
- After editing the plugin, send `/reload-plugins` to pick up the change.

## Read what happened

The screen folds text: a line ending in `· summary` is Claude's thinking, not text it wrote. To see what Claude wrote and called, read the session's transcript. `command ls -dt ~/.claude/projects/*/ | head -3` lists the newest transcript folders, named after each session's folder with every `/` turned into `-`. The newest `.jsonl` in it is the session. Each assistant line's `message.content` lists its `text`, `thinking` and `tool_use` blocks in order.

## Finish

- Capture the screen that shows the change working, for the PR or your final message, alongside the passing tests.
- Kill the session with `tmux kill-session -t mod`, and stop any background poll you started.
- Check that the real files you backed up haven't changed.
