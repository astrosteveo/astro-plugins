# ledger

A small expense ledger. Add expenses one line at a time, keep them in a JSON file, and print a month's totals.

## Use

```
python3 -m ledger book.json add "$(printf '2026-03-14\t$12.50\tfood\tlunch,work')"
python3 -m ledger book.json report 2026 3
python3 -m ledger book.json report 2026 3 --by-tag
```

A line has three or four tab-separated fields: the date (`YYYY-MM-DD`), the amount, the category, and optional comma-separated tags.

Amounts are written like `12.34`, `-5`, `1,234.50` or `$7.10`, with at most two decimal places, and are kept as whole cents. A negative amount is a refund.

`report` prints the month's total, the average spent per day that had an expense, and with `--by-tag` each tag's total. An entry with several tags counts toward each of them; an entry with no tags counts toward none.

## From Python

```python
from ledger import Ledger, parse_line, monthly_total

book = Ledger.load("book.json")
book.add(parse_line("2026-03-14\t12.50\tfood"))
book.save("book.json")
print(monthly_total(book, 2026, 3))
```

## Tests

```
python3 -m unittest discover -s tests
```

Run one test file with `python3 -m unittest tests/test_parse.py`.
