# screen-polish

Polishes Claude Code's terminal. Each change below has its own setting: open `/config`, type `screen`, and press Enter on a row to turn it on or off.

## Replies (on by default)

Claude Code's renderer gives inline code a color but no background, draws every heading below `#` as plain bold, and prints `---`, `- [x]` and quotes much as written. screen-polish redraws the parts of a reply that hold one of these, and leaves the rest (code fences, tables, plain paragraphs) to Claude Code. A part that holds something whose setting is off is left to Claude Code whole, so that thing looks as Claude Code draws it: with inline code off, a heading holding `code` loses its accent color too.

While any of these is on, a mouse selection in a reply also takes the gutter's two cells, which a plugin can't keep out of it the way Claude Code does. Click a reply's `●` to copy cleanly: your selection in that reply without the gutter, or the whole reply as markdown when nothing in it is selected.

| Setting | What it draws |
| --- | --- |
| Inline code on a background | `code` as a chip on a fill, so it stands apart from **bold** |
| Heading levels | `#` and `##` in the accent color, `#` underlined, `####` and below in italics |
| Drawn rules | `---` as a line across the transcript |
| Task list checkboxes | `- [ ]` as `○`, `- [x]` as a green `✓` with the item dimmed |
| Quote bars | `> quotes` in italics behind a bar, inline code still on its fill |

## The rest of the screen (off by default)

| Setting | What it draws |
| --- | --- |
| Tool calls as rows | One aligned row per call with a status glyph (`✓` done, `✗` failed, `◐` running, `◌` waiting, `⊘` interrupted), the tool, its main argument (for a shell call, its description) and a short result (`6 lines`, `+3 −1`, `200 OK`). A folded run draws its last six. Under a row, only an edit's diff (up to 30 lines) or a failed call's error, wrapped, up to 8 lines. |
| Prompt marker | An accent `❯` before your prompt |
| Spinner says what's happening | `Waiting`, `Writing`, `Working`, `Preparing` or `Running` in place of a random word |
| Mode labels joined by · | Mode labels joined by ` · ` in place of ` & ` |

The ctrl+o transcript, `--verbose` and the desktop, VS Code and mobile apps keep Claude Code's own drawing. The hint line under the prompt is left alone, since rewriting it would remove the live permission-mode pill.

It works with [inline-thinking](../inline-thinking): thinking still draws above the polished rows and replies, whichever of the two mods Claude Code runs first.

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
