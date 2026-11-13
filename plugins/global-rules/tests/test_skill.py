import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
SKILL = PLUGIN / "skills" / "suggest" / "SKILL.md"
CLAUDE_MD = PLUGIN / "skills" / "claude-md" / "SKILL.md"


class SuggestTest(unittest.TestCase):
    def setUp(self):
        _, self.front, self.body = SKILL.read_text().split("---\n", 2)
        self.allowed = self.field("allowed-tools")

    def field(self, key):
        return next(line for line in self.front.splitlines() if line.startswith(f"{key}:"))

    def test_it_reads_this_session_not_the_transcripts(self):
        # Memory carries corrections between sessions; scanning every transcript found the same
        # items run after run.
        self.assertIn("this session", self.field("description"))
        self.assertFalse((SKILL.parent / "scripts").exists())
        self.assertNotIn("Bash", self.allowed)

    def test_it_hands_its_candidates_to_claude_md_with_no_prompt(self):
        # The guidance, the wording and the write live in one skill, so the two can't drift apart.
        self.assertEqual(self.allowed, "allowed-tools: Skill(skill:global-rules:claude-md)")
        self.assertIn("Invoke the Skill tool with `global-rules:claude-md`", self.body)
        self.assertIn("/global-rules:suggest", CLAUDE_MD.read_text())

    def test_a_candidate_needs_a_second_time_or_a_rule_for_everywhere(self):
        for kind in ["Broke a line the global CLAUDE.md already has",
                     "Repeats a correction a memory already records",
                     "Was said to hold everywhere"]:
            self.assertIn(kind, self.body)
        self.assertIn("A correction given once, with no memory of it before", self.body)

    def test_a_session_with_nothing_new_stops(self):
        self.assertIn("If nothing qualifies, say so in one line and stop.", self.body)


if __name__ == "__main__":
    unittest.main()
