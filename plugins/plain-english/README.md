# plain-english

Makes Claude write plain English, after Strunk & White, without the stock phrases that mark machine-written text.

- Plain English is an output style. Choose it with `/output-style plain-english:Plain English`, or in `/config`. It keeps Claude's coding instructions and replaces any other style, Concise included, so it repeats Concise's rules: lead with the result, no narration, no recap.
- Every agent the session starts gets the style too. Claude Code gives an output style to the main thread alone. While Plain English is chosen, this mod adds the style's rules to the prompt of each subagent, workflow agent and teammate, so their reports and the files, commit messages and pull requests they write follow it. A fork shares the parent's conversation, which already contains the style, so the fork gets a one-line pointer to it. The rules come from the style file itself, so the agents follow any edit to it. Two kinds of agent go without: a workflow agent whose prompt the engine fixes (the Code Review workflow's, for one), since the engine ignores a change to that prompt, and an agent resumed from before the style was chosen, which keeps the prompt it had.
- The skill `/plain-english:scan` finds the Claudisms the style did not prevent. Give it files to check, or no arguments to check the reply that ended Claude's last turn. To check a draft before it is sent, Claude passes the draft as text. It runs the mod's scan tool, then reads the text for the forms a search cannot find, and proposes rewrites. It edits a file only when you ask, or when the file is Claude's own draft in the current task. Claude may also run it on its own before it finishes a README, docs, a commit message or a pull request.

The scan tool, `mcp__plain-english__scan`, sorts what it finds into two lists. The Rewrite list has words and phrases that are almost never right, such as em dashes, emoji, `delve`, the `worth ___` family, `at its core` and negative parallelism (`not just X, it's Y`). The Check list has words that are fine when used literally, such as a config that `lives in` a folder, a promise that `settles` or the `shape of` the data; a reader keeps the literal ones and rewrites the metaphors.

It skips frontmatter, fenced, indented and inline code, block quotes, HTML comments, URLs, link targets and HTML tags. It matches a phrase broken across the wrapped lines of a paragraph, so a commit message wrapped at 72 columns is checked whole. It also checks forms a word list misses: horizontal rules used as section breaks, `**Term**: explanation` lists, two spaced dashes in one sentence, and four or more very short sentences in a row. It reads a file only where your permission rules let Claude read it without asking; elsewhere Claude reads the file with Read and passes the text.

The list comes from [claudisms.ai](https://claudisms.ai/claudisms.md), which is free to copy and adapt. A copy is in `skills/scan/claudisms.md` for the skill to read. Two of its entries are one publication's house rules (`articles`, not `essays`, and a spaced hyphen in place of an em dash); the scan leaves the first out and accepts any plain fix for the second.

## Install

At the prompt of a terminal session:

```
/plugin install plain-english --marketplace astrosteveo/astro-plugins
```

Then choose the style:

```
/output-style plain-english:Plain English
```

`/output-style` saves the choice to the project's `.claude/settings.local.json`. To use the style in every project, set `"outputStyle": "plain-english:Plain English"` in `~/.claude/settings.json`.

## Test

```
claude plugin validate plugins/plain-english
claude plugin test plugins/plain-english
```
