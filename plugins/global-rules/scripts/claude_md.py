#!/usr/bin/env python3
"""Back up an instruction file, and show what changed in it since, for the global-rules skills.

The skills run this instead of cp and diff: Claude Code asks before cp or diff touches a path
outside the session's working folders, which the global CLAUDE.md always is, even when the skill
pre-approves them. A bundled script the skill pre-approves runs without asking.

Backups go to <config>/global-rules/backups/, not beside the file, so editing a project's
CLAUDE.md leaves no stray file in the repo.
"""
from __future__ import annotations

import argparse
import difflib
import os
import shutil
from datetime import date
from pathlib import Path


def backups_dir() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude").expanduser() / "global-rules" / "backups"


# The file's whole path in the name, so two projects' CLAUDE.md files don't share one.
# A backup is never written over: a second run the same day would replace the original with a
# file the skill already edited.
def backup(path: Path, today: date, into: Path) -> Path | None:
    if not path.exists():
        return None
    name = f"{str(path.resolve()).strip('/').replace('/', '-')}.bak-{today.isoformat()}"
    into.mkdir(parents=True, exist_ok=True)
    target = into / name
    n = 2
    while target.exists():
        target = into / f"{name}-{n}"
        n += 1
    shutil.copy2(path, target)
    return target


# A last line with no newline would run into the next line of the diff, so it is ended and marked
# the way diff -u marks it.
def diff(old: Path, new: Path) -> str:
    return "".join(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n"
                   for line in difflib.unified_diff(
                       old.read_text().splitlines(keepends=True),
                       new.read_text().splitlines(keepends=True),
                       str(old), str(new),
                   ))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    actions = parser.add_subparsers(dest="action", required=True)
    backup_args = actions.add_parser("backup", help="copy the file to the backups folder, and print where")
    backup_args.add_argument("path")
    diff_args = actions.add_parser("diff", help="print a unified diff of the backup and the file")
    diff_args.add_argument("backup")
    diff_args.add_argument("path")
    args = parser.parse_args(argv)
    if args.action == "backup":
        path = Path(args.path).expanduser()
        made = backup(path, date.today(), backups_dir())
        print(made if made is not None else f"There is no file at {path}, so no backup was made.")
    else:
        changed = diff(Path(args.backup).expanduser(), Path(args.path).expanduser())
        print(changed or "No changes.", end="" if changed else "\n")


if __name__ == "__main__":
    main()
