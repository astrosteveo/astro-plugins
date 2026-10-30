# plain-english

Makes Claude write plain English, after Strunk & White, without the stock phrases that mark machine-written text.

- Plain English is an output style, and the mod forces it: while the mod is on, the style applies in every session and the `outputStyle` setting is ignored. To use another style, disable the mod. It keeps Claude's coding instructions and replaces any other style, Concise included, so it repeats Concise's rules: lead with the result, no narration, no recap.
- Every agent the session starts gets the style too. Claude Code gives an output style to the main thread alone. This mod adds the style's rules to the prompt of each subagent, workflow agent and teammate, so their reports and the files, commit messages and pull requests they write follow it. A fork shares the parent's conversation, which already contains the style, so the fork gets a one-line pointer to it. The rules come from the style file itself, so the agents follow any edit to it. Two kinds of agent go without: a workflow agent whose prompt the engine fixes (the Code Review workflow's, for one), since the engine ignores a change to that prompt, and an agent resumed from before the mod was on, which keeps the prompt it had.
- Prose that leaves the session is checked. A Markdown file or a doc such as `README` or `NOTES.txt` that Claude writes or edits, and a pull request opened through an MCP tool such as review-gate's `pull_request` (whose own run of `gh` is checked too), are scanned before the call runs. A call whose prose has Claudisms is refused with the list of fixes, and Claude rewrites the text and tries again. Files under test and fixture folders are skipped. An edit is scanned as the file it leaves, so code fences keep their meaning, and answers only for the text it adds. If a finding is wrong, as for a word used literally, Claude makes the same call again unchanged and it goes through; that text then stays cleared for the session.
- A shell command is checked after it runs, so its prose is read exactly as published rather than guessed from the command line. When a `git commit` makes a commit (found by comparing the repository's `HEAD` before and after, and by the line git prints), the hook reads its message with `git log`; when `gh` creates a pull request, issue or comment, the hook reads it back from the host. If it has Claudisms, Claude is told to amend the commit or edit the post, unless a finding is wrong. Commits a pull or checkout brings in, and a commit that reuses an existing message (`--no-edit`, `-C`), are not flagged.
- A push is checked before it runs, whether Claude runs `git push` or review-gate runs it to open a pull request. Every commit the push would send that no remote has yet, and that was made in this session, is read; a push that would send a message with Claudisms is refused with the commits to reword. This catches commits the check after each command missed: one made in the background, in another directory, or by a hook. Commits from before the session are left alone, as are pushes that send no commits (a delete, tags alone). Pushing again unchanged goes through, for commits whose messages are not Claude's to change.
- What `gh` posts from a command run in the background is not read back, since its output is not there to read. In this repository's setup review-gate opens pull requests itself, and those are checked.
- Each subagent's report is checked as the subagent finishes, except for text in quotation marks, which a review quotes as evidence. A report with Claudisms goes back to the subagent once to be rewritten.
- The skill `/plain-english:scan` finds the Claudisms the style did not prevent. Give it files to check, or no arguments to check the reply that ended Claude's last turn. To check a draft before it is sent, Claude passes the draft as text. It runs the mod's scan tool, then reads the text for the forms a search cannot find, and proposes rewrites. It edits a file only when you ask, or when the file is Claude's own draft in the current task. Claude may also run it on its own before it finishes a README, docs, a commit message or a pull request.

Each check runs in two steps. A word scan runs first; it is free and instant. Text of 25 words or more then goes to Haiku, which reads it for the forms a word list cannot see (negative parallelism in new wording, crowned claims, announced structure, metaphors standing in for plain verbs, bold labels) and decides whether each word that is fine when literal is used literally. Each check costs one small model call and a second or two. If the model cannot answer, the word scan's findings stand alone, and a check that fails lets the call through. Chat replies are not checked, since fixing one means showing it twice.

The scan tool, `mcp__plain-english__scan`, sorts what it finds into two lists. The Rewrite list has words and phrases that are almost never right, such as em dashes, emoji, `delve`, the `worth ___` family, `at its core` and negative parallelism (`not just X, it's Y`). The Check list has words that are fine when used literally, such as a config that `lives in` a folder, a promise that `settles` or the `shape of` the data; a reader keeps the literal ones and rewrites the metaphors. Under them it lists what the model found.

It skips frontmatter, fenced, indented and inline code, block quotes, HTML comments, URLs, link targets and HTML tags. It matches a phrase broken across the wrapped lines of a paragraph, so a commit message wrapped at 72 columns is checked whole. It also checks forms a word list misses: horizontal rules used as section breaks, `**Term**: explanation` lists, two spaced dashes in one sentence, and four or more very short sentences in a row. It reads a file only where your permission rules let Claude read it without asking; elsewhere Claude reads the file with Read and passes the text.

The list comes from [claudisms.ai](https://claudisms.ai/claudisms.md), which is free to copy and adapt. A copy is in `skills/scan/claudisms.md` for the skill to read. Two of its entries are one publication's house rules (`articles`, not `essays`, and a spaced hyphen in place of an em dash); the scan leaves the first out and accepts any plain fix for the second.

## Install

At the prompt of a terminal session:

```
/plugin install plain-english --marketplace astrosteveo/astro-plugins
```

The style applies from the next session. Its `force-for-plugin: true` frontmatter makes it win over the `outputStyle` setting; if two mods force a style, Claude Code uses the first and logs a warning.

## Test

```
claude plugin validate plugins/plain-english
claude plugin test plugins/plain-english
```
