import contextlib
import io
import re
import sys
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1] / "skills" / "track" / "SKILL.md"
sys.path.insert(0, str(SKILL.parent / "scripts"))
import board  # noqa: E402


class SkillTest(unittest.TestCase):
    def setUp(self):
        _, front, self.body = SKILL.read_text().split("---\n", 2)
        self.allowed = next(line for line in front.splitlines() if line.startswith("allowed-tools:"))

    def test_every_board_py_command_it_runs_is_pre_approved(self):
        # An unapproved run stops the skill for a permission prompt, or fails outright under -p.
        runs = re.findall(r"python3 (\S+board\.py) ", self.body)
        self.assertTrue(runs)
        for script in set(runs):
            self.assertIn(f"Bash(python3 {script} *)", self.allowed)

    def test_every_command_it_names_is_one_board_py_has(self):
        named = set(re.findall(r"board\.py (?:--\S+ \S+ )*([a-z]+)", self.body))
        self.assertEqual(named, {"show", "move", "sub", "update", "views"})
        for command in named:
            with self.assertRaises(SystemExit) as done, contextlib.redirect_stdout(io.StringIO()):
                board.main([command, "--help"])
            self.assertEqual(done.exception.code, 0, command)

    def test_every_update_status_it_names_is_one_board_py_takes(self):
        named = set(re.findall(r"`(on-track|at-risk|off-track|complete|inactive)`", self.body))
        self.assertEqual(named, set(board.UPDATE_STATUSES))


if __name__ == "__main__":
    unittest.main()
