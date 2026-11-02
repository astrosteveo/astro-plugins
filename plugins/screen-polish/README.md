# screen-polish

Redraws Claude Code's terminal transcript in a cleaner, more compact style without adding rows.

- **Tool calls**: one aligned row per call, with a status glyph (`✓` done, `✗` failed, `◐` running, `◌` waiting, `⊘` interrupted), the tool, its main argument (a path relative to the project, a command, a URL) and a short result (`6 lines`, `+3 −1`, `200 OK`, `Exit code 1`). A folded run of calls ("Read 3 files") draws as the same rows, at most the last six of it.
- **Results**: under an edit, its diff, up to 30 lines. Under a failed call, the lines of its error that the row left out. Other output, such as a command's, stays in the ctrl+o transcript.
- **Prompts and replies**: an accent `❯` before your prompt. Claude's replies are indented, without the bullet.
- **Spinner**: says what the turn is doing (`Waiting`, `Writing`, `Working`, `Preparing`, `Running`) in place of a random word. Claude Code still draws the elapsed time and tokens beside it.
- **End of a turn**: a thin rule with the turn's duration.
- **Mode labels**: joined by ` · ` in place of ` & `.

The ctrl+o transcript, `--verbose` and other surfaces (desktop, VS Code, mobile) keep Claude Code's own drawing.

The hint line under the prompt is left alone. Claude Code draws the live permission-mode pill on that line, and a mod that rewrites the hint also removes the pill.

The mod works with [inline-thinking](../inline-thinking): thinking still draws above the polished rows, whichever of the two mods Claude Code runs first.

## Install

At the prompt of a terminal session:

```
/plugin install screen-polish --marketplace astrosteveo/astro-plugins
```

## Test

```
claude plugin validate plugins/screen-polish
claude plugin test plugins/screen-polish
```
