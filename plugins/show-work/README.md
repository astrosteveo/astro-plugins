# show-work

A pane beside the chat where Claude shows its work as it goes, so you can follow and steer it without reading every tool call.

The pane has four tabs (hotkeys 1 to 4 while it has focus). **Now**, the default, holds only the plan, the questions waiting on you and the last three actions; the other tabs hold the rest. A plan with a new goal starts a new task, and the notes of earlier tasks hide behind a button on the Notes tab.

- **Plan**: the goal as Claude understands it and its steps, with the current one marked. Claude posts it with the `plan` tool; a `TodoWrite` list shows here too.
- **Notes**: each decision (with its reason), assumption, open question, finding and risk, posted with the `note` tool the moment it comes up. Each opens with a tag in Claude's voice ("I chose", "I assume", "I ask", "I found", "Risk") and ends with what to do about it ("veto?", "correct me?", "answer me", "FYI", "heads up"). Press a question to quote it into your prompt and answer it; it turns replied once you send text after the quote. Press any other note to open it: it shows Claude's reason and detail and two buttons, one that starts a reply (Veto, Correct it, Tell me more, What would you do?) and one that marks it read (OK, Right, Got it).
- **Pictures**: every image Claude reads (a screenshot, a render) is copied here as it was at that moment; the list under it picks an older one.
- **Activity**: every file read, file edited, command run and search, logged by the mod itself, with failures marked and a count of files changed. Repeated reads or edits of one file fold into that file's row, which shows a count (`×3`) and moves to the bottom.

Claude can also draw a picture in the chat itself with the `show` tool: an image file or SVG source, such as a mockup of a design before it builds it. The picture appears under the tool's row, in a terminal that draws images (kitty, Ghostty, iTerm2); other surfaces show its caption and path. Pictures are kept as PNGs in `~/.cache/show-work` (the newest 30), converted with `rsvg-convert` and ImageMagick's `magick`.

A short section in the system prompt tells Claude when to post a plan and when to note something.

## Use

The pane opens by itself in a wide fullscreen terminal (144 columns or more). Otherwise:

- `/work` opens the pane.
- `/work clear` empties it.
- ctrl+x tab focuses it; Tab walks the notes, Enter replies to one.

## Install

At the prompt of a terminal session:

```
/plugin install show-work --marketplace astrosteveo/astro-plugins
```

## Test

```
claude plugin validate plugins/show-work
claude plugin test plugins/show-work
```
