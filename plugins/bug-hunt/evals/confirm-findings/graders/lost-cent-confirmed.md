---
type: llm
---
The reply says finding 1 is a real bug, shown by a repro or command that ran: `parse_amount("19.99")` (or a similar amount) gives 1998 instead of 1999, because of float arithmetic truncated by `int()`.
