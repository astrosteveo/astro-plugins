import unittest
from pathlib import Path

STYLE = Path(__file__).resolve().parents[1] / "output-styles" / "plain-english.md"


def style():
    _, front, body = STYLE.read_text().split("---\n", 2)
    return dict(line.split(": ", 1) for line in front.strip().splitlines()), body


class StyleTest(unittest.TestCase):
    def test_the_style_turns_itself_on_and_keeps_the_coding_instructions(self):
        # Claude Code ignores a misspelled field without an error, so a typo here would leave the
        # style off, or drop Claude Code's software engineering instructions.
        front, _ = style()
        self.assertEqual(front["force-for-plugin"], "true")
        self.assertEqual(front["keep-coding-instructions"], "true")
        self.assertEqual(front["name"], "Plain English")

    def test_the_instructions_open_with_the_heading_subagents_see(self):
        _, body = style()
        self.assertTrue(body.strip().startswith("# Writing style\n"))

    def test_the_instructions_follow_their_own_rule_on_em_dashes(self):
        _, body = style()
        self.assertNotIn("—", body)


if __name__ == "__main__":
    unittest.main()
