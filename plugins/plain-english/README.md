# plain-english

Makes Claude write in plain English, the way good technical docs read: the answer first, short sentences, common words, and the actual file, command or number named. It leaves out hedging ("I think", "probably", "should work"), filler ("just", "really", "it's worth noting"), openers and closers ("Great question", "Hope this helps"), buzzwords and em dashes. The rules apply to everything Claude writes: replies, plans, code comments, commit messages, docs and subagent reports. They're in [`output-styles/plain-english.md`](output-styles/plain-english.md).

```
/plugin install plain-english --marketplace astrosteveo/astro-plugins
```

## Where the instructions reach

| Where Claude writes | How it gets the instructions |
| --- | --- |
| The main conversation, including `claude -p` and a session resumed with `--fork-session` | The Plain English output style, which turns itself on (`force-for-plugin`) |
| A fork (`subagent_type: fork`) | The output style, in the system prompt the fork inherits |
| Every other subagent: Explore, Plan, general-purpose, a plugin's agents, workflow agents | The same text as `SubagentStart` context, from the hooks module |
| An agent-team teammate | Both: its lead's system prompt and `SubagentStart` context |

A subagent other than a fork runs on its own system prompt, which leaves out the output style. That's why the hook hands it the text. A teammate gets it twice, because the hook names a teammate by the name it was given and can't tell it apart from a subagent.

## What it changes

While the plugin is enabled, Plain English replaces any output style you pick in `/config` or with `/output-style`. To go back to another style, disable the plugin. The style keeps Claude Code's software engineering instructions (`keep-coding-instructions: true`).

Claude Code reads output style files when it starts, so after editing `plain-english.md`, restart Claude Code. Subagents read the file each time one starts.

## Check it

In a session with the plugin enabled, ask:

```
Use no tools. Quote the first sentence of the Writing style section of your system prompt exactly, or reply: none.
```

Claude answers with the first sentence of the style. Ask a subagent the same thing, such as "Spawn an Explore subagent with this task: …", and it gives the same answer. Each subagent's transcript in `~/.claude/projects/<project>/<session>/subagents/` holds the text as a `hook_additional_context` row from `SubagentStart`.

```
claude plugin validate plugins/plain-english
claude plugin test plugins/plain-english
python3 -m unittest discover -s plugins/plain-english/tests
```
