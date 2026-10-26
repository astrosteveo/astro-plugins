# show-work

A pane beside the chat where Claude shows its work as it goes, so you can follow and steer it without reading every tool call.

The pane has thirteen tabs (hotkeys 1 to 9, 0, u, g and f while it has focus). **Now**, the default, holds a pulse of tool calls over the last two minutes, then the plan, the questions waiting on you, the subagents and the last three actions; the other tabs hold the rest. A plan with a new goal starts a new task, and the notes of earlier tasks hide behind a button on the Notes tab.

- **Plan**: the goal as Claude understands it and its steps, with the current one marked. Claude posts it with the `plan` tool; a `TodoWrite` list shows here too.
- **Notes**: each decision (with its reason), assumption, open question, finding and risk, posted with the `note` tool the moment it comes up. Each opens with a tag in Claude's voice ("I chose", "I assume", "I ask", "I found", "Risk") and ends with what to do about it ("veto?", "correct me?", "answer me", "FYI", "heads up"). Press a question to quote it into your prompt and answer it; it turns replied once you send text after the quote. The tab counts only the notes still waiting on you. Press any other note to open it: it shows Claude's reason and detail and two buttons, one that starts a reply (Veto, Correct it, Tell me more, What would you do?) and one that marks it read (OK, Right, Got it).
- **Agents**: each subagent Claude starts gets a lane on the Now tab: its task, its type, a count of its calls and, while it runs, its latest call. A lane turns ✓ when the subagent stops, background ones included.
- **Timeline**: a Gantt chart of the last eight turns and the subagents each one started, drawn in cells; running bars grow and pulse four times a second.
- **Context**: how full the context window is, with a mark where compaction comes, what fills it by category, an area chart of the window after each turn, the last turn's tokens, the spend so far and the rate limits.
- **Tests**: every test command Claude runs (bun test, pytest, cargo test, go test, jest, vitest, claude plugin test) read for its counts and the tests it names: a grid of runs across and tests down, failing tests first, tests that flip between pass and fail flagged as flaky.
- **Files**: a treemap of the files Claude read and edited, sized by how often and colored from read (blue) to edited (orange); pressing a file opens its diff.
- **Commits**: this session's commits on every branch as a git graph, each with its stat, refreshed after each commit or merge Claude makes (`r` refreshes it).
- **Explorer** (`0`): the project's files as git sees them. Walk the tree, or type a few letters of a name to find it (Enter opens the best match). A file opens in a syntax-highlighted preview with buttons that drop `@path` into your prompt (`m`), open its diff (`d`) and close it (`x`). Files git calls changed, and files Claude read or edited, are marked. Switching to this tab puts the typing in the filter; Enter gives the keys back to the tab hotkeys.
- **Run** (`u`): type a command and press Enter; it runs in a shell in the working directory and its output streams in, errors red. Stop it (`k`), run it again (`e`), or hand its output to Claude in your prompt (`a`). Recent commands rerun with a press. A reload of the plugin stops running commands.
- **Git** (`g`): the branch and how far it is ahead of or behind its upstream, then staged, changed and new files. Press a file to stage or unstage it, `±` for its diff; stage all (`a`), unstage all (`z`), type a message to commit the staged files, push (`p`) when ahead. What git said shows under the branch.
- **Search** (`f`): ripgrep over the project (git grep where there is no rg), smart case, hits grouped by file; a hit opens its file at that line in the Explorer's preview, ready to mention.
- **Pictures**: every image Claude reads (a screenshot, a render) is copied here as it was at that moment; the list under it picks an older one.
- **Activity**: every file read, file edited, command run and search, logged by the mod itself, with failures marked and a count of files changed. Repeated reads or edits of one file fold into that file's row, which shows a count (`×3`) and moves to the bottom. Above the log, each changed file is a button: press it to see its diff against git HEAD (a new file against nothing), added lines green and removed ones red; the diff refreshes when the file is edited again, and `x` closes it.

Outside the pane: while Claude works, a band above the prompt shows the pulse, the step it is on, its running agents, the last test run and what waits on you. The context and spend stay in your status line. In the chat, each Edit and Write row gets a bar of the lines it added and removed, and each test command's row a bar of its passes and failures. Diffs are drawn by Claude Code's own diff highlighter.

Claude can also draw a design in the chat itself with the `show` tool, so you can veto it before it is built. Claude describes the design's structure and a tool lays it out:

- **d2** for architecture and systems, containers nested in braces, drawn by [D2](https://d2lang.com).
- **mermaid** for flowcharts and sequence, state, class, ER and gantt diagrams, drawn by mermaid-cli's `mmdc`.
- **dot** for big graphs such as dependencies or scene trees, drawn by Graphviz.
- **html** for a UI mockup (a screen, menu, dialog or HUD), laid out by headless Chrome or Chromium. A wireframe kit gives it classes for layout (`row`, `col`, `grid`, `grow`), parts (`box`, `window`, `btn`, `input`, `slider`, `tabs`, `list`, `img` placeholders), annotations (`note`, numbered `mark`) and game screens (`stage` or `screen`, children pinned by anchor: `tl` … `br`). The page fits its content, or takes the width and height Claude gives.
- **svg** for a freeform drawing, and **path** for an image that exists.

`show` shows you images too:

- **path**: an image on disk (PNG, JPEG, GIF, WebP, BMP or SVG).
- **url**: an image on the web, such as reference art, an asset or a screenshot in some docs. curl fetches it (http or https only, 20 MB in 30 seconds at most). ImageMagick then reads it only with the coder its first bytes name, so a hostile file can't reach ImageMagick's riskier coders. A web page is refused with a hint to give the image's own address.
- **images**: two to nine paths or URLs side by side on one sheet, each numbered over its label (its file name if Claude gives none), for you to compare and pick from. ImageMagick's `montage` lays the sheet out, and a sprite under 240 pixels is blown up with whole pixels so it stays crisp.

Each picture follows Claude Code's light or dark theme. A design Claude wrote, an image from the web and a sheet each come back to Claude in the tool's result as the picture you see, so it can fix overlaps or cut text, or catch the wrong picture, before you look; a source that won't parse comes back with the renderer's words. The picture appears under the tool's row, in a terminal that draws images (kitty, Ghostty, iTerm2); other surfaces show its caption and path. Pictures are kept as PNGs in `~/.cache/show-work` (the newest 30), converted with `rsvg-convert` and ImageMagick's `magick`.

A ```mermaid block in Claude's reply draws as the diagram itself, in place, in such a terminal: its code shows while it renders and again, under mermaid's error, if it will not. Diagrams render once with mermaid-cli's `mmdc` (`npm i -g @mermaid-js/mermaid-cli`) in Claude Code's light or dark theme and are cached in `~/.cache/show-work` (the newest 40). Other surfaces draw the block as Claude Code does.

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
