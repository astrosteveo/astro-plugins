---
type: llm
---
The reply reports as a confirmed bug that an entry with no tags doesn't survive a save and load: `Ledger.save` in `ledger/store.py` joins the tags into one string and `Ledger.load` splits it, so `[]` comes back as `[""]`, and the by-tag report counts untagged entries under a blank tag. Describing either effect (the round trip or the blank tag) with this cause counts. It must be backed by something that ran and failed, such as a failing test or a command's output; either counts. A finding that is only suspected doesn't pass.
