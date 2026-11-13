#!/usr/bin/env python3
"""Print Claude Code's guidance on writing instruction files, for /global-rules:claude-md.

Fetches the memory and best-practices pages at most once a day and prints only their sections on
writing CLAUDE.md, rules and memory, so a run reads a fraction of the two pages and still reads
the current docs. Then lists the instruction files that exist, globally and in the repo the
session runs in, so the skill knows what to read without a permission prompt. Stdlib only.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
import urllib.request
from datetime import date
from pathlib import Path

MEMORY = "https://code.claude.com/docs/en/memory.md"
BEST_PRACTICES = "https://code.claude.com/docs/en/best-practices.md"

# Each page's sections, by heading. True keeps a section's subsections; False keeps only the text
# before its first one, where a long section opens with what matters and then gives examples.
SECTIONS = {
    MEMORY: [
        ("CLAUDE.md vs auto memory", True),
        ("When to add to CLAUDE.md", True),
        ("Choose where to put CLAUDE.md files", True),
        ("Write effective instructions", True),
        ("Path-specific rules", True),
        ("User-level rules", True),
        ("Claude isn't following my CLAUDE.md", True),
        ("My CLAUDE.md is too large", True),
    ],
    BEST_PRACTICES: [
        ("Deterministic and non-deterministic instructions", True),
        ("Keep CLAUDE.md short", True),
        ("Scope rules to one part of the codebase", True),
        ("Put team procedures in skills", False),
        ("Enforce the rules that can't have exceptions", False),
        ("What you can stop doing", True),
    ],
}

# Kept for a day: the docs change with Claude Code's releases, not by the hour.
MAX_AGE = 24 * 60 * 60

HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def key(heading: str) -> str:
    return heading.replace("’", "'").strip().lower()


def headings(text: str) -> list[tuple[int, int, str]]:
    """Each heading as (line index, level, text), leaving out # lines inside code fences."""
    found = []
    fence = ""
    for i, line in enumerate(text.splitlines()):
        opened = FENCE.match(line)
        if fence:
            # A fence closes on a run of its own character at least as long as the one that opened it.
            if opened and opened.group(1)[0] == fence[0] and len(opened.group(1)) >= len(fence) \
                    and not line.strip()[len(opened.group(1)):].strip():
                fence = ""
            continue
        if opened:
            fence = opened.group(1)
            continue
        match = HEADING.match(line)
        if match:
            found.append((i, len(match.group(1)), match.group(2)))
    return found


def sections(text: str, wanted: list[tuple[str, bool]]) -> tuple[list[str], list[str]]:
    """The wanted sections' text, in the page's order, and the headings the page doesn't have."""
    lines = text.splitlines()
    marks = headings(text)
    by_key = {key(name): whole for name, whole in wanted}
    kept: list[str] = []
    seen = set()
    for n, (start, level, name) in enumerate(marks):
        if key(name) not in by_key or key(name) in seen:
            continue
        seen.add(key(name))
        whole = by_key[key(name)]
        end = len(lines)
        for later, later_level, _ in marks[n + 1:]:
            if later_level <= level or not whole:
                end = later
                break
        kept.append("\n".join(lines[start:end]).strip())
    missing = [name for name, _ in wanted if key(name) not in seen]
    return kept, missing


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "global-rules-plugin"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.read().decode("utf-8")


def build(get=fetch, today: date | None = None) -> str:
    """The guidance from both pages, with a note for each page or section that couldn't be read."""
    parts = [f"Fetched {(today or date.today()).isoformat()} from Claude Code's docs. "
             "Judge every line by these sections, not by what you remember."]
    for url, wanted in SECTIONS.items():
        try:
            text = get(url)
        except Exception as error:  # noqa: BLE001 - any failure means: read the page another way
            parts.append(f"# {url}\n\nCouldn't fetch this page ({error}). Read it with WebFetch.")
            continue
        kept, missing = sections(text, wanted)
        parts.append(f"# {url}")
        parts.extend(kept)
        if missing:
            listed = "; ".join(missing)
            parts.append(f"Not found on this page, which may have changed: {listed}. "
                         f"Read the page with WebFetch for what it says now.")
    return "\n\n".join(parts) + "\n"


def config_dir() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude").expanduser()


def repo_root(start: Path) -> Path | None:
    for folder in [start, *start.parents]:
        if (folder / ".git").exists():
            return folder
    return None


def inventory(config: Path, cwd: Path) -> str:
    """The instruction files there are, so the skill reads them without listing folders."""
    lines = ["# Instruction files", ""]

    def add(label: str, paths: list[Path]) -> None:
        there = [p for p in paths if p.is_file()]
        lines.append(f"- {label}: " + (", ".join(str(p) for p in there) if there else "none"))

    rules = lambda folder: sorted(folder.rglob("*.md")) if folder.is_dir() else []  # noqa: E731
    add(f"Global CLAUDE.md ({config / 'CLAUDE.md'})", [config / "CLAUDE.md"])
    add(f"Global rules ({config / 'rules'})", rules(config / "rules"))
    add("Global settings", [config / "settings.json"])
    add("Global memory index (global-memory plugin)", [config / "memory" / "MEMORY.md"])
    root = repo_root(cwd)
    if root is None:
        lines.append(f"- No git repo at {cwd}, so no project files.")
    else:
        add(f"Project instruction files in {root}",
            [root / "CLAUDE.md", root / ".claude" / "CLAUDE.md", root / "CLAUDE.local.md", root / "AGENTS.md"])
        add(f"Project rules ({root / '.claude' / 'rules'})", rules(root / ".claude" / "rules"))
        add("Project settings", [root / ".claude" / "settings.json", root / ".claude" / "settings.local.json"])
    return "\n".join(lines) + "\n"


def guidance(cache: Path, refresh: bool, get=fetch, now: float | None = None) -> str:
    """The kept guidance while it's under a day old, else a new fetch, else the old copy with a note."""
    now = time.time() if now is None else now
    fresh = cache.is_file() and now - cache.stat().st_mtime < MAX_AGE
    if fresh and not refresh:
        return cache.read_text()
    text = build(get)
    if "Couldn't fetch" in text and cache.is_file():
        days = int((now - cache.stat().st_mtime) // 86400)
        return f"Couldn't fetch the docs now, so this is the copy kept {days} days ago.\n\n" + cache.read_text()
    if "Couldn't fetch" not in text:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(text)
    return text


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--refresh", action="store_true", help="fetch the pages even if the kept copy is fresh")
    args = parser.parse_args(argv)
    config = config_dir()
    sys.stdout.write(guidance(config / "global-rules" / "guidance.md", args.refresh))
    sys.stdout.write("\n" + inventory(config, Path.cwd()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
