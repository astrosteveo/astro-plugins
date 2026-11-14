"""A month's totals, in dollars."""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal

CENT = Decimal("0.01")


def month_range(year: int, month: int) -> tuple[date, date]:
    """The first day of the month and the first day of the next month, for months 1 to 12."""
    start = date(year, month, 1)
    end = date(year, month + 1, 1)
    return start, end


def entries_in(ledger, year: int, month: int) -> list:
    start, end = month_range(year, month)
    return [entry for entry in ledger.entries if start <= entry.day < end]


def dollars(cents: int) -> Decimal:
    return (Decimal(cents) / 100).quantize(CENT)


def monthly_total(ledger, year: int, month: int) -> Decimal:
    """The month's total in dollars."""
    return dollars(sum(entry.cents for entry in entries_in(ledger, year, month)))


def daily_average(ledger, year: int, month: int) -> Decimal:
    """The average spent per day that had an expense, rounded to the cent, half to even.

    0.00 for a month with no entries.
    """
    entries = entries_in(ledger, year, month)
    if not entries:
        return Decimal("0.00")
    days = {entry.day for entry in entries}
    total = Decimal(sum(entry.cents for entry in entries)) / 100
    return (total / len(days)).quantize(CENT)


def totals_by_tag(ledger, year: int, month: int) -> dict:
    """Each tag's total in dollars for the month, by tag name.

    An entry with several tags counts toward each of them; an entry with no tags counts toward none.
    """
    cents = defaultdict(int)
    for entry in entries_in(ledger, year, month):
        for tag in entry.tags:
            cents[tag] += entry.cents
    return {tag: dollars(total) for tag, total in sorted(cents.items())}
