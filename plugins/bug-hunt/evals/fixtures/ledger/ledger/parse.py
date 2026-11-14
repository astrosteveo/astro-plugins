"""Parse ledger lines such as ``2026-03-14<TAB>$12.50<TAB>food<TAB>lunch,work``."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

# An optional minus, an optional dollar sign, whole dollars with or without thousands separators,
# and at most two decimal places.
AMOUNT = re.compile(r"-?\$?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?")


@dataclass
class Entry:
    """One expense. ``cents`` is the amount in whole cents; ``tags`` may be empty."""

    day: date
    cents: int
    category: str
    tags: list[str] = field(default_factory=list)


def parse_amount(text: str) -> int:
    """Parse an amount such as ``12.34``, ``-5``, ``1,234.50`` or ``$7.10`` into whole cents.

    Raises ValueError when the text isn't an amount.
    """
    text = text.strip()
    if not AMOUNT.fullmatch(text):
        raise ValueError(f"not an amount: {text!r}")
    cleaned = text.replace("$", "").replace(",", "")
    return int(float(cleaned) * 100)


def parse_line(line: str) -> Entry:
    """Parse one line: a date, an amount, a category and optional comma-separated tags, split by tabs."""
    fields = line.rstrip("\n").split("\t")
    if len(fields) not in (3, 4):
        raise ValueError(
            f"expected 3 or 4 tab-separated fields, got {len(fields)}: {line!r}"
        )
    day = date.fromisoformat(fields[0].strip())
    cents = parse_amount(fields[1])
    category = fields[2].strip()
    if not category:
        raise ValueError(f"missing category: {line!r}")
    tags = []
    if len(fields) == 4:
        # A tag named twice counts once.
        tags = list(
            dict.fromkeys(tag.strip() for tag in fields[3].split(",") if tag.strip())
        )
    return Entry(day, cents, category, tags)
