import contextlib
import io
import re
import sys
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN / "scripts"))
import board  # noqa: E402

SKILLS = ["track", "init"]


def skill(name):
    _, front, body = (PLUGIN / "skills" / name / "SKILL.md").read_text().split("---\n", 2)
    return front, body


def field(front, key):
    return next(line for line in front.splitlines() if line.startswith(f"{key}:"))


class BothSkillsTest(unittest.TestCase):
    def test_every_board_py_command_each_runs_is_pre_approved(self):
        # An unapproved run stops the skill for a permission prompt, or fails outright under -p.
        for name in SKILLS:
            with self.subTest(name):
                front, body = skill(name)
                runs = re.findall(r"python3 (\S+board\.py) ", body)
                self.assertTrue(runs)
                for script in set(runs):
                    self.assertIn(f"Bash(python3 {script} *)", field(front, "allowed-tools"))

    def test_both_run_the_one_board_py_at_the_plugin_root(self):
        # ${CLAUDE_SKILL_DIR} is each skill's own folder, so a script both skills share is reached
        # from ${CLAUDE_PLUGIN_ROOT}, which Claude Code substitutes in a plugin skill's body and
        # allowed-tools alike.
        for name in SKILLS:
            with self.subTest(name):
                front, body = skill(name)
                scripts = set(re.findall(r"python3 (\S+board\.py)", front + body))
                self.assertEqual(scripts, {"${CLAUDE_PLUGIN_ROOT}/scripts/board.py"})
        self.assertTrue((PLUGIN / "scripts" / "board.py").is_file())

    def test_every_command_they_name_is_one_board_py_has(self):
        named = {}
        for name in SKILLS:
            named[name] = set(re.findall(r"board\.py (?:--\S+ \S+ )*([a-z]+)", skill(name)[1]))
        self.assertEqual(named["track"], {"show", "move", "sub", "update"})
        self.assertEqual(named["init"], {"show", "views", "move", "update"})
        for command in named["track"] | named["init"]:
            with self.assertRaises(SystemExit) as done, contextlib.redirect_stdout(io.StringIO()):
                board.main([command, "--help"])
            self.assertEqual(done.exception.code, 0, command)

    def test_every_gh_command_init_pre_approves_only_reads(self):
        # Making a board, a label or a milestone changes GitHub, so the user sees each one asked for.
        approved = re.findall(r"Bash\((gh [a-z]+ [a-z]+) \*\)", field(skill("init")[0], "allowed-tools"))
        self.assertEqual(set(approved), {"gh repo view", "gh label list", "gh issue list"})
        body = skill("init")[1]
        for command in approved:
            self.assertRegex(body, rf"(?m)^{command} ")


class TrackTest(unittest.TestCase):
    def setUp(self):
        self.front, self.body = skill("track")

    def test_every_update_status_it_names_is_one_board_py_takes(self):
        named = set(re.findall(r"`(on-track|at-risk|off-track|complete|inactive)`", self.body))
        self.assertEqual(named, set(board.UPDATE_STATUSES))

    def test_setting_up_a_board_is_left_to_init(self):
        # Setup runs once per repo; track loads for every change, so it only points the way.
        self.assertIn("/github-tracking:init", field(self.front, "description"))
        no_board = self.body[self.body.index("## A repo with no board"):]
        self.assertIn("/github-tracking:init", no_board)
        self.assertIn("save that in the project's memory", no_board)
        self.assertNotIn("gh project create", self.body)


class InitTest(unittest.TestCase):
    def setUp(self):
        self.front, self.body = skill("init")

    def test_it_makes_and_links_the_board_then_gives_it_views(self):
        self.assertLess(self.body.index("gh project create"), self.body.index("gh project link"))
        self.assertLess(self.body.index("gh project link"), self.body.index("Run `board.py views`"))

    def test_a_second_run_adds_only_what_is_missing(self):
        self.assertIn("Skip this if `show` printed a board", self.body)
        self.assertIn("so a second run changes nothing", self.body)

    def test_it_asks_for_the_workflows_the_api_cannot_turn_on(self):
        for workflow in ["Item closed", "Pull request merged", "Auto-add sub-issues"]:
            self.assertIn(workflow, self.body)
        self.assertIn("the API can't turn on a workflow", self.body)


if __name__ == "__main__":
    unittest.main()
