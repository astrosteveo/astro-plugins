// One memory file as hooks/memory.ts writes it: global-memory.test.ts checks memoryFile() writes
// `file` from `entry`.
export default {
  "entry": {
    "name": "say-merge-not-close",
    "description": "When told to \"close\" a PR: merge it. A \\ backslash and a colon: both survive",
    "type": "feedback",
    "body": "Say \"merge\" when the user says \"close\" a pull request.\n\n**Why:** they mean merge it, not close it unmerged.\n\n**How to apply:** follow [[merge-steps]] for how to merge.",
    "modified": 1793750400000
  },
  "file": "---\nname: say-merge-not-close\ndescription: \"When told to \\\"close\\\" a PR: merge it. A \\\\ backslash and a colon: both survive\"\nmetadata:\n  type: feedback\n  modified: 2026-11-04T00:00:00.000Z\n---\n\nSay \"merge\" when the user says \"close\" a pull request.\n\n**Why:** they mean merge it, not close it unmerged.\n\n**How to apply:** follow [[merge-steps]] for how to merge.\n"
}
