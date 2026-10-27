# show-work

A pane beside the chat where Claude shows its work as it goes, so you can follow and steer it without reading every tool call.

The pane has five tabs (hotkeys 1 to 4 and g while it has focus) and a search box. **Now**, the default, holds a one-line status (working or idle, the call in flight, agents running, failures this turn), the plan, the subagents and a log of the task's notes. What needs the person rides above the prompt instead, as cards (below). The other tabs hold the rest. A plan with a new goal starts a new task, and the notes of earlier tasks hide behind a button on the Notes tab.

- **Plan**: the goal as Claude understands it and its steps, with the current one marked. Claude posts it with the `plan` tool; a `TodoWrite` list shows here too.
- **Notes** are not a tab. Each decision (with its reason), assumption, open question, finding and risk, posted with the `note` tool the moment it comes up, shows above your prompt as a card, where you are looking: *I ask*, *I chose*, *I assume*, *I found*, *Risk*, with its reason underneath. A question has **Answer**, which starts your reply in the prompt, and ✗ to put it away; the others have a reply (Veto, Correct it, Tell me more, What would you do?) and an OK (OK, Right, Got it). Questions come first, three cards at most. Sending words after the quote marks it replied. Now keeps a log of the task's notes, each opening to its reason and detail. A plan with a new goal starts a new task and hides the notes of earlier ones.
- **Agents**: each subagent Claude starts gets a lane on the Now tab: its task, its type, a count of its calls and, while it runs, its latest call. A lane turns ✓ when the subagent stops, background ones included.
- **Tests**: every test command Claude runs (bun test, pytest, cargo test, go test, jest, vitest, claude plugin test) read for its counts and the tests it names: the last run's result, its failing tests, and the last six runs. After a failing run, **Fix these** (`x`) drops the failing test names into your prompt.
- **Find** is not a tab: the search box at the end of the tab bar brings it up. Click into the box, type in it, or press `f` (the hotkey sits on the box's own `find` button) and the pane shows two modes, **Names** (`o`) and **Text** (`t`). *Names* is the project's files as git sees them: walk the tree, or type a few letters of a name to find it (Enter opens the best match). A file opens in a syntax-highlighted preview with buttons that drop `@path` into your prompt (`m`), open its diff (`d`) and close it (`x`). Files git calls changed, and files Claude read or edited, are marked. A markdown file (`.md`, `.markdown`, `.mdx`) opens rendered: headings, tables, lists, links and fenced code with syntax highlighting, its local pictures drawn as pictures where the terminal draws images (kitty, Ghostty, iTerm2), and a link to another local file opens that file. `v` shows the source instead. An image file (png, jpeg, gif, webp, bmp, svg) opens as a picture where the terminal draws images. `w` turns line wrapping off and on in the code and diff viewers: off cuts a long line at the edge. **Ask about lines**: drag the mouse over lines in a code viewer, here or in Changes. The lines get a bar down the side, and the moment you let go the prompt box gets a short coloured marker, `[src/big.ts lines 5 to 8]`. Type your question around it; when you send, the marker is swapped for the file and the quoted lines, so the box stays short and Claude gets the code. A click picks the one line, a click on it again puts it back, and alt-click stretches the pick from its first line to the one clicked, so a pick can reach past what the pane shows: click the first line, scroll with the wheel, alt-click the last (kitty keeps shift-click for its own selection). Drag again and the new marker takes the old one's place, keeping your words. One line above the viewer, always there so picking never moves the lines under the pointer, says what is in your prompt, with `✗ drop it` to take the marker out. The viewer picks whole lines, wrapped or not. In rendered markdown it picks whole blocks (a paragraph, heading, table or code fence, or one item of a list, with its continuation lines): start the drag in one block and let go in another, and every block between is picked (each lights up as the pointer passes it, and the marker goes in the prompt when you let go), quoted by its source lines. A file's links to other project files sit in a `links:` row under it, since a block cannot answer a click on a link. In the Text search, a drag over the hit rows picks those hits and the marker quotes them with their files and lines (`[search "jump" 3 hits]`); a plain click on a hit still opens its file. The search box ends the tab bar and fills what is left of its row, or takes a row of its own when the tabs leave too little room. It is one box for both modes: in Names it filters as you type and Enter opens the best match, in Text the search runs as your typing pauses (a quarter second, two letters at least) and Enter runs it at once. Pressing `f` puts the typing in it; Enter gives the keys back to the tab hotkeys. *Text* is ripgrep over the project (git grep where there is no rg), smart case, hits grouped by file; a hit opens its file at that line in the Names preview, ready to mention.
- **Git** (`g`): the branch and how far it is ahead of or behind its upstream, then staged, changed and new files. Press a file to stage or unstage it, `±` for its diff; stage all (`a`), unstage all (`z`), type a message to commit the staged files, push (`p`) when ahead. What git said shows under the branch.
- **Pictures**: every image Claude reads or shows (a screenshot, a render, a design) is copied here as it was at that moment; the list under it picks an older one. Under a sheet, a button for each tile picks it: press its letter (`a`, `b`, …) or click it, and your prompt starts with "I pick B (Bug page) from …". On a sheet of six or more, `f` and `g` pick tiles F and G while this tab is open.
- **Changes**: the diff of what Claude edited, where a drag over some rows puts a marker for them, `+` and `-` kept, in your prompt (see *Ask about lines* under Find). The files it edited sit along the top, newest first; the latest edit's diff is open (added lines green, removed red), and pressing another file shows its own. Reads, commands and counts are not here: the chat has them, and Git stages and commits.

Outside the pane: a band above the prompt holds the note cards, and while Claude works it also shows the pulse, the step it is on, its running agents, the last test run and what waits on you. The context and spend stay in your status line. In the chat, each Edit and Write row gets a bar of the lines it added and removed, and each test command's row a bar of its passes and failures. Diffs are drawn by Claude Code's own diff highlighter.

Claude can also draw a design in the chat itself with the `show` tool, so you can veto it before it is built. Claude describes the design's structure and a tool lays it out:

- **d2** for architecture and systems, containers nested in braces, drawn by [D2](https://d2lang.com).
- **mermaid** for flowcharts and sequence, state, class, ER and gantt diagrams, drawn by mermaid-cli's `mmdc`.
- **dot** for big graphs such as dependencies or scene trees, drawn by Graphviz.
- **html** for a UI mockup (a screen, menu, dialog or HUD), laid out by headless Chrome or Chromium. A wireframe kit gives it classes for layout (`row`, `col`, `grid`, `grow`), parts (`box`, `window`, `btn`, `input`, `slider`, `tabs`, `list`, `img` placeholders), annotations (`note`, numbered `mark`) and game screens (`stage` or `screen`, children pinned by anchor: `tl` … `br`). The page fits its content, or takes the width and height Claude gives.
- **svg** for a freeform drawing, and **path** for an image that exists.

`show` shows you images too:

- **path**: an image on disk (PNG, JPEG, GIF, WebP, BMP or SVG).
- **url**: an image on the web, such as reference art, an asset or a screenshot in some docs. curl fetches it (http or https only, 20 MB in 30 seconds at most). ImageMagick then reads it only with the coder its first bytes name, so a hostile file can't reach ImageMagick's riskier coders. A web page is refused with a hint to give the image's own address.
- **images**: two to nine paths or URLs side by side on one sheet, up to four across so it comes out wide, each lettered A, B, C… over its label (its file name if Claude gives none), for you to compare and pick from on the Pictures tab. ImageMagick's `montage` lays the sheet out, and a sprite under 240 pixels is blown up with whole pixels so it stays crisp.
- **marks**: numbered boxes, or rings round a spot, that Claude draws on any picture above in its own pixels, each with a short note and, if Claude likes, a longer detail. A bug in a screenshot or the parts of a mockup get pointed at, and Claude gets the marked picture back to check each mark sits where its note says. Up to twelve per picture.

Under a sheet or a marked picture in the chat sits a small card: a button per tile (`B Bug page`) and one per mark (`2 Score jumps here ↩`). Click one and your prompt starts with the pick, or with "About mark 2 ("Score jumps here") on …: " for you to finish, with no trip to the pane. Point at a mark on the picture and its row in the card lights and its detail shows in lines the card keeps for it under the rows; a row lights the same way under the pointer, here or in the Pictures tab. The card never changes size, so the chat never moves under the pointer. Where two marks overlap, pointing lands on the smaller one, and Claude is told the two overlap so it can tighten them. Nothing is drawn over the picture on hover: kitty leaves a revealed picture on screen once the chat scrolls. Pictures are sized to the terminal's real cell shape, read once from its tty at the session's start (Linux; 1:2 elsewhere), so a picture fills its box and each mark's spot sits on it.

Each picture follows Claude Code's light or dark theme. A design Claude wrote, an image from the web and a sheet each come back to Claude in the tool's result as the picture you see, so it can fix overlaps or cut text, or catch the wrong picture, before you look; a source that won't parse comes back with the renderer's words. The picture appears under the tool's row, as wide as the transcript and at most a screen tall, in a terminal that draws images (kitty, Ghostty, iTerm2); other surfaces show its caption and path. Pictures are kept as PNGs in `~/.cache/show-work` (the newest 30), converted with `rsvg-convert` and ImageMagick's `magick`.

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
