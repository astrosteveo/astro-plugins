---
type: llm
---
The reply reports as a confirmed bug that untagged entries show up under a blank tag because `Ledger.save` in `ledger/store.py` joins the tags into one string and `Ledger.load` splits it, so `[]` comes back as `[""]`. It names the save and load round trip as the cause, not the report code alone. It must be backed by something that ran and failed, such as a failing test or the command line's output; either counts. A finding that is only suspected doesn't pass.
