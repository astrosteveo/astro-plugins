import re
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
SKILL = PLUGIN / "skills" / "suggest" / "SKILL.md"
CLAUDE_MD = PLUGIN / "skills" / "claude-md" / "SKILL.md"


class SkillTest(unittest.TestCase):
    def setUp(self):
        _, self.front, self.body = SKILL.read_text().split("---\n", 2)
        self.allowed = self.field("allowed-tools")

    def field(self, key):
        return next(line for line in self.front.splitlines() if line.startswith(f"{key}:"))

    def step(self, start, end=None):
        return self.body[self.body.index(start):self.body.index(end) if end else None]

    def test_every_script_it_runs_is_pre_approved(self):
        # An unapproved run stops the skill for a permission prompt, or fails outright under -p.
        scripts = set(re.findall(r"python3 (\S+\.py)", self.body))
        self.assertEqual(scripts, {"${CLAUDE_SKILL_DIR}/scripts/digest.py"})
        self.assertIn("Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/digest.py)", self.allowed)
        self.assertIn("Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/digest.py *)", self.allowed)

    def test_it_hands_its_candidates_to_claude_md_with_no_prompt(self):
        # The guidance, the wording and the write live in one skill, so the two can't drift apart.
        self.assertIn("Skill(skill:global-rules:claude-md)", self.allowed)
        self.assertIn("Invoke the Skill tool with `global-rules:claude-md`", self.step("## 3."))
        self.assertIn("/global-rules:suggest", CLAUDE_MD.read_text())

    def test_it_writes_nothing_itself(self):
        for tool in ["Edit", "Write", "WebFetch", "claude_md.py"]:
            self.assertNotIn(tool, self.allowed)

    def test_a_candidate_needs_the_docs_test(self):
        # A rule from one message came back on every run, however often the user turned it down.
        candidates = self.step("## 2.", "## 3.")
        self.assertIn("at least twice", candidates)
        self.assertIn("when a global CLAUDE.md line already covered it", candidates)
        self.assertIn("Anything said or corrected once, unless a line already covered it", candidates)

    def test_a_run_with_nothing_new_stops(self):
        self.assertIn("If nothing meets the test", self.step("## 2.", "## 3."))

    def test_it_reads_only_since_the_last_run(self):
        self.assertIn("since the last run", self.field("description"))
        self.assertIn("since the last run", self.step("## 1.", "## 2."))

    def test_the_digest_is_all_it_reads(self):
        self.assertIn("Don't search the transcripts", self.step("## 2.", "## 3."))

    def test_the_argument_hint_shows_since(self):
        self.assertIn("--since", self.field("argument-hint"))
        self.assertNotIn("apply", self.field("argument-hint"))

    def test_it_names_its_own_plugin_in_every_command(self):
        self.assertNotIn("global-memory:suggest", self.body)


if __name__ == "__main__":
    unittest.main()
