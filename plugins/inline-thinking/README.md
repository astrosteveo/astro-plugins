# inline-thinking

Draws Claude's thinking in the chat, above the reply or tool call it led to. Without it, Claude Code folds the thinking into a "Thought for 4s" line that only ctrl+o or `--verbose` opens.

Each thinking block draws as Claude Code draws one under `--verbose`: a dim italic `∴` in the gutter with the text beside it. It sits above the row that came next. That row is a reply, a tool call's own row, or a folded run of calls ("Thought for 4s, read 3 files"), which shows the thinking before each of its calls in order. Markdown in the text, mostly bold headings, is stripped so it doesn't show as stars.

Rows where Claude Code already draws thinking are left alone: under `--verbose` (Verbose output in `/config`), in the ctrl+o transcript and in unfolded groups. A subagent's thinking stays in its own transcript. Thinking cut off by a new prompt draws nowhere. Only the terminal draws it; other surfaces are left as they are.

Known gap: in the ctrl+o transcript, thinking before a reply draws twice, once by Claude Code and once by the mod. A reply's row doesn't say when ctrl+o is open, as a tool row's does, so the mod can't tell.

## Setup

What draws is the summary of the thinking that the API sends back. The API sends it only when `~/.claude/settings.json` has:

```json
"showThinkingSummaries": true
```

Without it there is nothing to draw.

## Install

At the prompt of a terminal session:

```
/plugin install inline-thinking --marketplace astrosteveo/astro-plugins
```

## Test

```
claude plugin validate plugins/inline-thinking
claude plugin test plugins/inline-thinking
```
