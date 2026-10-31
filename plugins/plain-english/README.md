# plain-english

Makes Claude write plain English in the voice of technical instructions: neutral, exact and easy to follow. It also removes the stock phrases that mark machine-written text.

## The output style

Plain English is an output style, and the mod forces it. While the mod is on, the style applies in every session, and Claude Code ignores the `outputStyle` setting. To use another style, disable the mod.

The style keeps Claude's coding instructions and replaces any other style, Concise included. It repeats Concise's rules: lead with the result, do not narrate, and do not recap.

The style tells Claude to do these things:

- Write for a reader who did not watch it work. Name each thing by what it is, and explain any label it made up.
- Write one idea per sentence, and split any sentence over 30 words.
- Keep a neutral tone, with no enthusiasm, jokes or opinions.
- Leave out the stock words and sentence forms that mark machine-written text.

If you ask for a tone or a personality, Claude uses it where you asked. The rules on clarity still apply.

## Subagents

Claude Code gives an output style to the main thread only. The mod adds the style's rules to the prompt of each subagent, workflow agent and teammate. Their reports, files, commit messages and pull requests then follow the style too. The rules come from the style file, so the agents follow any edit to it.

A fork shares the parent's conversation, which already has the style. The mod gives a fork a one-line pointer to it.

Two kinds of agent do not get the rules:

- A workflow agent whose prompt the engine fixes, such as the agents of the Code Review workflow. The engine ignores a change to that prompt.
- An agent resumed from before the mod was on. It keeps the prompt it had.

## Checks on prose that leaves the session

The mod checks prose that leaves the session. If the prose breaks the rules, Claude gets a list of fixes. Chat replies are not checked, because fixing one would show it twice.

### Files and pull requests

These are checked before the call runs:

- A Markdown file, or a doc such as `README` or `NOTES.txt`, that Claude writes or edits.
- A pull request opened through an MCP tool, such as the `pull_request` tool of review-gate. The `gh` command that the tool runs is checked too.

If the prose has problems, the call is refused with a list of fixes. Claude rewrites the text and tries again.

Files in test and fixture folders are skipped. An edit is scanned as the whole file it leaves, so code fences keep their meaning. Only the text that the edit adds counts.

If a finding is wrong, for example for a word used literally or a tone you asked for, Claude makes the same call again unchanged. The call then goes through, and that text stays cleared for the rest of the session.

### Commits and posts from the shell

A shell command is checked after it runs, so the hook reads the prose exactly as it was published:

- When `git commit`, `git merge` or `git rebase` makes a commit, the hook reads its message with `git log`. The hook finds the commit by comparing `HEAD` before and after the command, and by the line that git prints.
- When `gh` creates a pull request, issue or comment, the hook reads it back from the host.

If the prose has problems, Claude is told to amend the commit or edit the post. If a finding is wrong, Claude leaves the text as it is.

What `gh` posts from a command run in the background is not read back, because its output is not available. In this repository, review-gate opens pull requests itself, and those are checked.

### Pushes

A push is checked before it runs. This applies when Claude runs `git push`, and when review-gate runs it to open a pull request.

The hook reads every commit that the push would send and that no remote has yet. If a message has problems, the push is refused with the list of commits to reword. This check finds commits that the check after each command missed, such as a commit made in the background, in another directory or by a hook.

A push that sends no commits, such as a delete or tags only, is not checked. If the messages are not Claude's to change, Claude pushes again unchanged, and the push goes through.

### Which commits count

Only commits first written in this session count. The hook finds them by author time, which a rebase, amend or cherry-pick keeps. It stores the start time of each session by its id, so a resumed session keeps its own start time.

These commits are not flagged:

- Commits that a pull or checkout brings in.
- A commit that reuses a message, with `--no-edit`, `-C`, `--fixup` or `--squash`.
- A message that git writes itself, such as `fixup!`, `Revert "…"` or `Merge branch …`.

### Subagent reports

A subagent's report is checked when the subagent finishes. Text in quotation marks is skipped, because a review quotes text as evidence. If the report has problems, it goes back to the subagent once to be rewritten.

### How a check works

Each check has two steps:

1. A word scan runs. It is free and instant.
2. If the text has 25 words or more, Haiku reads its first 40,000 characters. For an edit, Haiku reads only the lines that the edit writes. Haiku finds the forms that a word list cannot see, and decides whether each word that is fine when literal is used literally.

The forms that Haiku looks for include these:

- Negative parallelism in new wording.
- A claim that crowns one thing as the most important.
- An announced structure, such as a sentence that only says what comes next.
- A metaphor in place of a plain verb.
- A bold label at the start of a list item.
- A working label used as if the reader knows it.
- A sentence over 30 words.
- Personality dropped into otherwise plain text. A tone that the whole text keeps on purpose is not flagged, because you may have asked for it.

Haiku flags a sentence that an edit makes longer only when the lines that the edit writes hold the whole sentence. The style still tells Claude to split every sentence over 30 words.

Each check costs one small model call and takes a second or two. If the model cannot answer, the findings of the word scan stand alone. If the check itself fails, the call goes through.

## The scan skill and tool

The skill `/plain-english:scan` finds what the style did not prevent. Give it files to check, or give no arguments to check the reply that ended the last turn of Claude. To check a draft before it is sent, Claude passes the draft as text.

The skill runs the scan tool, reads the text for the forms a search cannot find, and proposes rewrites. It edits a file only when you ask, or when the file is a draft that Claude wrote in the current task. Claude can also run the skill on its own before it finishes a README, docs, a commit message or a pull request.

The scan tool, `mcp__plain-english__scan`, sorts what it finds into two lists:

- The Rewrite list has words and forms that are almost never right. Examples are em dashes, emoji, `delve`, `worth noting`, `at its core` and `not just X, it's Y`.
- The Check list has words that are fine when used literally, such as a config that `lives in` a folder or the `shape of` the data. Keep the literal ones and rewrite the metaphors.

Under the two lists, the tool shows what the model found.

The scan skips frontmatter, code, block quotes, HTML comments, URLs, link targets and HTML tags. It matches a phrase that is broken across the wrapped lines of a paragraph, so it checks a wrapped commit message as a whole.

The scan also checks these forms, which a word list cannot match:

- A horizontal rule used as a section break.
- A list whose items start with a bold term and a colon.
- Two spaced dashes in one sentence.
- Four or more very short sentences in a row.

The tool reads a file only where your permission rules let Claude read it without asking. For other files, Claude reads the file with Read and passes the text.

The word list comes from [claudisms.ai](https://claudisms.ai/claudisms.md), which is free to copy and adapt. A copy is in `skills/scan/claudisms.md` for the skill to read. Two of its entries are the house rules of one publication: `articles` in place of `essays`, and a spaced hyphen in place of an em dash. The scan leaves out the first rule, and accepts any plain fix for the second.

## Install

At the prompt of a terminal session, run this command:

```
/plugin install plain-english --marketplace astrosteveo/astro-plugins
```

The style applies from the next session. Its `force-for-plugin: true` frontmatter makes it win over the `outputStyle` setting. If two mods force a style, Claude Code uses the first one and logs a warning.

## Test

```
claude plugin validate plugins/plain-english
claude plugin test plugins/plain-english
```
