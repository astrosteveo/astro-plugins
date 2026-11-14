"""The command line: ``python3 -m ledger FILE add LINE`` or ``python3 -m ledger FILE report YEAR MONTH``."""

from __future__ import annotations

import argparse

from ledger.parse import parse_line
from ledger.report import daily_average, monthly_total, totals_by_tag
from ledger.store import Ledger


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="ledger", description="A small expense ledger."
    )
    parser.add_argument("file", help="the ledger's JSON file")
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add", help="add one tab-separated line")
    add.add_argument("line")
    report = commands.add_parser("report", help="print a month's totals")
    report.add_argument("year", type=int)
    report.add_argument("month", type=int, choices=range(1, 13), metavar="MONTH")
    report.add_argument(
        "--by-tag", action="store_true", help="also print each tag's total"
    )
    args = parser.parse_args(argv)

    book = Ledger.load(args.file)
    if args.command == "add":
        try:
            entry = parse_line(args.line)
        except ValueError as err:
            parser.error(str(err))
        book.add(entry)
        book.save(args.file)
        print(f"added {entry.cents / 100:.2f} to {entry.category}")
        return 0

    print(f"total: {monthly_total(book, args.year, args.month)}")
    print(f"daily average: {daily_average(book, args.year, args.month)}")
    if args.by_tag:
        for tag, total in totals_by_tag(book, args.year, args.month).items():
            print(f"  {tag}: {total}")
    return 0
