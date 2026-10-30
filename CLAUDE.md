# astro-plugins

Claude Code plugins (mods), one per folder under `plugins/`. Each has `.claude-plugin/plugin.json`, `hooks/` (the hooks module and any files it imports), `tests/` and `types/` (its `$.state` contract).

## Check a change

```
claude plugin validate plugins/<name>
claude plugin test plugins/<name>
```

## Drive your work with tmux

Run a second Claude Code session in a detached tmux session with the plugin loaded, drive it with keys, and read the screen back. Never drive the user's own session.

```
# Start: wide enough that the pane docks unasked (144 columns or more).
tmux new-session -d -s mod -x 220 -y 60 -c "$PWD" 'claude --plugin-dir plugins/<name>'

# Type a prompt, then submit it with its own C-m: Enter sent with the text
# lands as part of the paste and does not submit.
tmux send-keys -t mod 'Read README.md and summarise it'
tmux send-keys -t mod C-m
tmux send-keys -t mod C-x Tab      # focus the pane
tmux send-keys -t mod 5            # a pane hotkey, such as a tab

# Read the screen: plain text, or with colours (-e) for a closer look.
tmux capture-pane -t mod -p
tmux capture-pane -t mod -p -e > "$SCRATCH/screen.ansi"

# Done: always clean up.
tmux kill-session -t mod
```

- Wait on the screen, not the clock: poll `tmux capture-pane -t mod -p | grep -q '<text>'` in an until-loop (the Monitor tool), since foreground `sleep` is blocked.
- A first launch may stop at a trust or login prompt: read the capture and answer it with `send-keys`.
- After editing the plugin, `/reload-plugins` in the tmux session picks the change up; send it with `send-keys`.
- End a change with a capture of the screen that shows it, alongside the passing tests.
