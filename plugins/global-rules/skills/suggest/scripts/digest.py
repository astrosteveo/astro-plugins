#!/usr/bin/env python3
"""Pull what the user said out of Claude Code's session transcripts, as a Markdown digest.

The digest holds the user's own typed messages (not tool output or text the harness
injected), the reasons they gave for refusing a tool call, likely corrections with
Claude's last words before each, and their global and project memories. The suggest
skill reads it to propose global CLAUDE.md content. Stdlib only, so any python3 runs it.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

DENIAL = "The user doesn't want to proceed with this tool use."
REASON_START = "the user said:\n"
REASON_END = "\n\nNote: The user's next message"
INTERRUPT = "[Request interrupted by user"

# A hint for the reader, not a verdict: the first alternative is anchored to the start.
CORRECTION = re.compile(
    r"^(no\b|nope\b|don'?t\b|do not\b|stop\b|wait\b|actually\b|instead\b|never\b|always\b|wrong\b"
    r"|why (did|do|are|is|would)\b|that'?s not\b|not what\b|you (should|shouldn'?t|didn'?t|forgot)\b"
    r"|i (told|asked|said)\b|undo\b|revert\b)"
    r"|\b(from now on|going forward|every time|in the future|next time)\b",
    re.IGNORECASE,
)
SHORT_REPLY_WORDS = 2
CONTEXT_CHARS = 240


@dataclass
class Message:
    text: str
    date: str
    project: str
    flags: list[str]
    context: str | None


@dataclass
class Refusal:
    date: str
    project: str
    tool: str
    reason: str | None


@dataclass
class Memory:
    scope: str
    name: str
    type: str
    description: str
    body: str


@dataclass
class Digest:
    messages: list[Message] = field(default_factory=list)
    refusals: list[Refusal] = field(default_factory=list)
    memories: list[Memory] = field(default_factory=list)
    sessions: set[str] = field(default_factory=set)
    skipped: int = 0
    # A resumed session's transcript repeats the records it was resumed from, ids and all.
    seen: set[str] = field(default_factory=set)

    def first_time(self, key: str | None) -> bool:
        if not key:
            return True
        if key in self.seen:
            return False
        self.seen.add(key)
        return True


def parse_since(value: str) -> str:
    """An ISO date, from 'YYYY-MM-DD' or 'Nd' (the last N days)."""
    if m := re.fullmatch(r"(\d+)d", value):
        return (date.today() - timedelta(days=int(m.group(1)))).isoformat()
    return date.fromisoformat(value).isoformat()


def one_line(text: str) -> str:
    return " ".join(text.split())


def cut(text: str, limit: int) -> str:
    return text if len(text) <= limit else f"{text[:limit]}…[+{len(text) - limit} chars]"


def tail(text: str, limit: int) -> str:
    text = one_line(text)
    return text if len(text) <= limit else "…" + text[-limit:]


def project_name(cwd: str) -> str:
    # A worktree belongs to the repo it was made from.
    cwd = re.sub(r"/\.claude/worktrees/.*$", "", cwd)
    home = str(Path.home())
    return "~" + cwd[len(home):] if cwd == home or cwd.startswith(home + "/") else cwd


def is_test(record: dict) -> bool:
    entry = record.get("entrypoint") or ""
    cwd = record.get("cwd") or ""
    tmp = tempfile.gettempdir().rstrip("/")
    return entry.startswith("sdk") or cwd.startswith(("/tmp/", tmp + "/"))


def clean(text: str) -> str:
    """The words the user typed: reminders dropped, pastes reduced to their size, commands as typed."""
    text = re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.S)
    text = re.sub(r"<pasted_content\b[^>]*>(.*?)</pasted_content\b[^>]*>",
                  lambda m: f"[pasted {len(m.group(1).strip())} chars]", text, flags=re.S)
    if name := re.search(r"<command-name>(.*?)</command-name>", text, re.S):
        command = "/" + name.group(1).strip().lstrip("/")
        args = re.search(r"<command-args>(.*?)</command-args>", text, re.S)
        text = f"{command} {args.group(1).strip()}" if args and args.group(1).strip() else command
    return text.strip()


def content_text(content) -> str:
    if isinstance(content, str):
        return content
    parts = []
    for block in content if isinstance(content, list) else []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
        elif isinstance(block, dict) and block.get("type") == "image":
            parts.append("[image]")
    return "\n".join(parts)


def tool_summary(name: str, tool_input) -> str:
    if isinstance(tool_input, dict):
        for key in ("command", "file_path", "path", "pattern", "url", "description", "prompt"):
            if isinstance(tool_input.get(key), str):
                return f"{name} `{cut(one_line(tool_input[key]), 160)}`"
    return name


def refusal_reason(text: str) -> str | None:
    start = text.find(REASON_START)
    if start == -1:
        return None
    reason = text[start + len(REASON_START):]
    end = reason.find(REASON_END)
    return (reason[:end] if end != -1 else reason).strip() or None


def scan_session(path: Path, since: str | None, include_tests: bool, digest: Digest) -> str | None:
    """Add one transcript's messages and refusals to the digest; return its project, if it has one."""
    tools: dict[str, str] = {}
    last_claude: str | None = None
    pending: str | None = None
    project: str | None = None
    with open(path, errors="replace") as fh:
        for line in fh:
            # Cheap skip for the many record kinds that are neither, before paying for json.loads.
            if '"user"' not in line and '"assistant"' not in line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            kind = record.get("type")
            if kind not in ("user", "assistant") or record.get("isSidechain"):
                continue
            content = (record.get("message") or {}).get("content")
            if kind == "assistant":
                for block in content if isinstance(content, list) else []:
                    if block.get("type") == "text" and block.get("text", "").strip():
                        last_claude = block["text"]
                    elif block.get("type") == "tool_use":
                        tools[block.get("id", "")] = tool_summary(block.get("name", "?"), block.get("input"))
                        last_claude = "ran " + tools[block.get("id", "")]
                continue

            human = (record.get("origin") or {}).get("kind") == "human" and not record.get("isMeta")
            if not include_tests and is_test(record):
                digest.skipped += human
                continue
            if project is None and record.get("cwd"):
                project = project_name(record["cwd"])
            day = (record.get("timestamp") or "")[:10]
            if since and day and day < since:
                continue

            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_result":
                    text = content_text(block.get("content"))
                    tool_id = block.get("tool_use_id", "")
                    if text.startswith(DENIAL):
                        pending = "after refusal"
                        if digest.first_time(tool_id and "tool:" + tool_id):
                            tool = tools.get(tool_id, "a tool")
                            digest.refusals.append(Refusal(day, project or "?", tool, refusal_reason(text)))
                elif block.get("type") == "text" and block.get("text", "").startswith(INTERRUPT):
                    pending = "after interrupt"

            if not human:
                continue
            text = clean(content_text(content))
            if not re.search(r"\w", text) or not digest.first_time(record.get("uuid")):
                pending = None
                continue
            flags = [pending] if pending else []
            if CORRECTION.search(text):
                flags.append("correction")
            context = tail(last_claude, CONTEXT_CHARS) if flags and last_claude else None
            digest.messages.append(Message(text, day, project or "?", flags, context))
            digest.sessions.add(str(path))
            pending = None
    return project


def read_memory(path: Path, scope: str) -> Memory:
    text = path.read_text(errors="replace")
    meta: dict[str, str] = {}
    body = text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            body = text[end + 4:]
            for line in text[3:end].splitlines():
                m = re.match(r"\s*(name|description|type):\s*(.*)", line)
                if m and m.group(1) not in meta:
                    meta[m.group(1)] = m.group(2).strip().strip("\"'")
    return Memory(scope, meta.get("name", path.stem), meta.get("type", "untyped"),
                  meta.get("description", ""), body.strip())


def memory_files(folder: Path) -> list[Path]:
    return sorted(p for p in folder.glob("*.md") if p.name != "MEMORY.md") if folder.is_dir() else []


def scan(config: Path, since: str | None, include_tests: bool) -> Digest:
    digest = Digest()
    projects = config / "projects"
    slugs: dict[str, str] = {}
    for path in sorted(projects.glob("*/*.jsonl")):
        if project := scan_session(path, since, include_tests, digest):
            slugs.setdefault(path.parent.name, project)
    digest.messages.sort(key=lambda m: m.date)
    digest.refusals.sort(key=lambda r: r.date)
    for path in memory_files(config / "memory"):
        digest.memories.append(read_memory(path, "global"))
    for folder in sorted(projects.glob("*/memory")):
        scope = slugs.get(folder.parent.name, folder.parent.name)
        if not include_tests and (scope.startswith("/tmp/") or folder.parent.name.startswith("-tmp")):
            continue
        for path in memory_files(folder):
            digest.memories.append(read_memory(path, scope))
    return digest


def norm(text: str) -> str:
    return one_line(text).lower().rstrip(".!?")


def quote(text: str, limit: int) -> str:
    return '"' + cut(one_line(text), limit) + '"'


def render(digest: Digest, claude_md: Path, max_chars: int) -> str:
    out: list[str] = ["# Session history digest", ""]
    messages = digest.messages
    projects = {m.project for m in messages}
    dates = [m.date for m in messages if m.date]
    span = f", {dates[0]} to {dates[-1]}" if dates else ""
    out.append(f"Scanned {len(digest.sessions)} sessions in {len(projects)} projects{span}: "
               f"{len(messages)} typed messages, {len(digest.refusals)} refusals.")
    if digest.skipped:
        out.append(f"Skipped {digest.skipped} messages from scripted or /tmp sessions (--include-tests keeps them).")
    if claude_md.is_file():
        lines = len(claude_md.read_text(errors="replace").splitlines())
        out.append(f"Global CLAUDE.md: {claude_md} ({lines} lines).")
    else:
        out.append(f"Global CLAUDE.md: {claude_md} does not exist.")

    global_mems = [m for m in digest.memories if m.scope == "global"]
    project_mems = [m for m in digest.memories if m.scope != "global"]
    out += ["", f"## Global memories ({len(global_mems)})"]
    for mem in global_mems:
        out += ["", f"### {mem.name} ({mem.type})", mem.description, "", cut(mem.body, 1000)]
    out += ["", f"## Project memories ({len(project_mems)})"]
    for mem in project_mems:
        out += ["", f"### {mem.scope} · {mem.name} ({mem.type})", mem.description, "", cut(mem.body, 600)]

    with_reason = [r for r in digest.refusals if r.reason]
    without = [r for r in digest.refusals if not r.reason]
    out += ["", f"## Refusals with a reason ({len(with_reason)})", ""]
    out += [f"- {r.date} · {r.project} · {r.tool} — {quote(r.reason, max_chars)}" for r in with_reason]
    out += ["", f"## Refusals without a reason ({len(without)})", ""]
    out += [f"- {r.date} · {r.project} · {r.tool}" for r in without]

    flagged = [m for m in messages if m.flags]
    out += ["", f"## Likely corrections ({len(flagged)})",
            "Messages that read like a correction, or came right after an interrupt or refusal.", ""]
    for m in flagged:
        out.append(f"- {m.date} · {m.project} · {', '.join(m.flags)}")
        if m.context:
            out.append(f"  Claude before: {quote(m.context, CONTEXT_CHARS + 1)}")
        out.append(f"  User: {quote(m.text, max_chars)}")

    groups: dict[str, list[Message]] = defaultdict(list)
    for m in messages:
        if not m.flags:
            groups[norm(m.text)].append(m)
    short: Counter[str] = Counter()
    commands: Counter[str] = Counter()
    repeated, by_project = [], defaultdict(list)
    for key, group in groups.items():
        if re.fullmatch(r"/\S+", key):
            commands[group[0].text] += len(group)
        elif len(key.split()) <= SHORT_REPLY_WORDS:
            short[key] += len(group)
        elif len({m.project for m in group}) > 1:
            repeated.append(group)
        else:
            by_project[group[0].project].append(group)

    def count(group: list[Message]) -> str:
        return f" (×{len(group)})" if len(group) > 1 else ""

    out += ["", f"## Said in more than one project ({len(repeated)})", ""]
    for group in sorted(repeated, key=len, reverse=True):
        names = sorted({m.project for m in group})
        out.append(f"- ×{len(group)} in {len(names)} projects ({', '.join(names)}): {quote(group[0].text, max_chars)}")
    out += ["", "## Other messages, by project"]
    for project in sorted(by_project, key=lambda p: -len(by_project[p])):
        out += ["", f"### {project} ({len(by_project[project])})", ""]
        out += [f"- {g[0].date}: {quote(g[0].text, max_chars)}{count(g)}" for g in by_project[project]]
    out += ["", "## Short replies and commands", ""]
    out.append("- Short replies: " + (", ".join(f"{k} ×{n}" for k, n in short.most_common(40)) or "none"))
    out.append("- Commands without arguments: " + (", ".join(f"{k} ×{n}" for k, n in commands.most_common(40)) or "none"))
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--since", type=parse_since, metavar="WHEN",
                        help="only messages from this day on: YYYY-MM-DD, or Nd for the last N days")
    parser.add_argument("--include-tests", action="store_true",
                        help="keep scripted (SDK) sessions and sessions run under /tmp")
    parser.add_argument("--max-chars", type=int, default=500, help="cut each message after this many characters")
    parser.add_argument("--config-dir", default=os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude",
                        help="Claude Code's config folder (default: $CLAUDE_CONFIG_DIR or ~/.claude)")
    parser.add_argument("--out", help="where to write the digest (default: <config-dir>/global-rules/digest.md)")
    args = parser.parse_args(argv)

    config = Path(args.config_dir).expanduser()
    digest = scan(config, args.since, args.include_tests)
    text = render(digest, config / "CLAUDE.md", args.max_chars)
    out = Path(args.out).expanduser() if args.out else config / "global-rules" / "digest.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    print(f"Wrote {out} ({len(text):,} chars, {text.count(chr(10)):,} lines).")
    print(text.split("\n\n## ")[0].split("\n", 2)[2])
    return 0


if __name__ == "__main__":
    sys.exit(main())
