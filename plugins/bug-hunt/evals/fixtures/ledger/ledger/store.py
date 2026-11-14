"""Keep a ledger in a JSON file."""

from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path

from ledger.parse import Entry


class Ledger:
    """A list of entries kept in a JSON file. A new ledger starts empty."""

    def __init__(self, entries=None):
        self.entries = list(entries) if entries else []

    def add(self, entry: Entry) -> None:
        self.entries.append(entry)

    def save(self, path) -> None:
        """Write the ledger to path as JSON. Ledger.load(path) gives back the same entries."""
        data = [
            {
                "day": entry.day.isoformat(),
                "cents": entry.cents,
                "category": entry.category,
                "tags": ",".join(entry.tags),
            }
            for entry in self.entries
        ]
        path = Path(path)
        # Write beside the file and rename over it, so a crash never leaves half a ledger.
        partial = path.with_name(path.name + ".partial")
        partial.write_text(json.dumps(data, indent=2))
        os.replace(partial, path)

    @classmethod
    def load(cls, path) -> Ledger:
        """Read a ledger written by save(). A file that doesn't exist yet is an empty ledger."""
        path = Path(path)
        if not path.exists():
            return cls()
        data = json.loads(path.read_text())
        return cls(
            Entry(
                date.fromisoformat(item["day"]),
                item["cents"],
                item["category"],
                item["tags"].split(","),
            )
            for item in data
        )
