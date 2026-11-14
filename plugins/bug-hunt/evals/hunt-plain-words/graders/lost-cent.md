---
type: llm
---
The reply reports as a confirmed bug that `parse_amount` in `ledger/parse.py` loses a cent on some amounts because it multiplies a float by 100 and truncates with `int()`. An example such as `19.99` giving 1998, `0.29` giving 28 or similar counts. It must be backed by something that ran and showed the wrong value, such as a failing test or a command's output; either counts. A finding that is only suspected doesn't pass.
