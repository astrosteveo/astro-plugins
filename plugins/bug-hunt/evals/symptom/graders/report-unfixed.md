---
type: regex
target:
  source: file
  path: ledger/report.py
pattern: for tag in entry\.tags:\n\s+cents\[tag\] \+= entry\.cents
---
