---
type: llm
---
The reply reports as a confirmed bug that a report for December crashes: `month_range` in `ledger/report.py` builds `date(year, month + 1, 1)`, so month 12 raises `ValueError` (month 13). It must be backed by something that ran and failed, such as a failing test or the command line's traceback; either counts. A finding that is only suspected, or that names a different cause, doesn't pass.
