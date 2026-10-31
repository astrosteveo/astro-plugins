---
name: scan
description: Scan prose for Claudisms, the stock words, set phrases and sentence forms that mark machine-written text, and rewrite them in plain English. Use it before you finish a README, docs, a commit message, a pull request or a long reply, and when the person asks you to check writing for AI tells or Claudisms.
argument-hint: "[file ...]"
---

# Scan prose for Claudisms

Find the Claudisms that got past the Plain English style, and rewrite them.

## 1. Choose the text

- Files named in the arguments: scan each one.
- No arguments: scan the reply that ended your last turn.
- Text the person pasted: scan that.
- A draft you have not sent yet: scan the draft itself, as text.

## 2. Run the scan tool

Load the tool with ToolSearch (`select:mcp__plain-english__scan`) if it is not loaded yet. Call it once per file with `path`, once with `text` for pasted text or a draft, or with neither for your last reply. If it refuses a path for permission, read the file with Read and pass its text.

The tool skips fenced and indented code, inline code, block quotes, HTML comments, URLs and frontmatter. It does not skip text in quotation marks. It matches phrases across wrapped lines within a paragraph. It returns two lists from a word scan, then, for text of 25 words or more, a third list of what a model found reading it. Rewrite each entry in the Rewrite list: its words and phrases are almost never right. The Check list has words that are fine when used literally, such as a config that `lives in` a folder or a data `shape`. Keep the literal ones and rewrite the metaphors.

## 3. Read for what a search misses

A word search cannot see these forms, and the model's list may miss some. Read the text for them yourself:

- A crowned superlative with a new noun: `the whole lesson`, `the one that [verb]`, `the only factor that changed`.
- Negative parallelism split across sentences or worded afresh.
- An announced structure (`three points`), a restated question, a closing line that restates the thesis, or summary bullets at the end.
- Vague stakes: a question, reckoning or conversation that is coming but never named.
- Invented observations and experience: what people say, a career the writer never had.
- A metaphor in place of a plain verb: an idea that lives, carries, moves, points or has a shape.
- Four or more very short sentences in a row, and two dashes in one sentence.
- A working label used as if the reader knows it: a nickname, internal state or variable name with no explanation, where a plain description would do.
- Personality in place of facts: enthusiasm, jokes, sympathy, or opinions on how good something is. Leave it if the person asked for that tone.

`claudisms.md` beside this file is the full list, with why each entry fails and what to write instead. Read the sections you need when a hit is unclear.

## 4. Report and rewrite

Give one line per finding: where it is, the words, and the plainer version. Group them by file. Then:

- If the person asked you to fix the text, or the text is your own draft in this task, make the edits.
- Otherwise, list the rewrites and wait for the person to choose.
- For your last reply, give the corrected reply.

Say nothing about passages that came through clean. If nothing needs a change, say so in one line.

The source list bans `essays` in favour of `articles`, and prescribes a spaced hyphen in place of an em dash. Those are one publication's house rules: this skill leaves the first out, and for the second accepts any plain fix (a comma, a colon, parentheses or a new sentence).
