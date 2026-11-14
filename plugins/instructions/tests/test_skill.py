import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def skill():
    _, front, body = (
        (ROOT / "skills" / "init" / "SKILL.md").read_text().split("---\n", 2)
    )
    return front, body


def field(front, key):
    return next(line for line in front.splitlines() if line.startswith(f"{key}:"))


def section(body, start, end=None):
    return body[body.index(start) : body.index(end) if end else None]


class InitTest(unittest.TestCase):
    def setUp(self):
        self.front, self.body = skill()

    def test_every_command_it_runs_is_pre_approved(self):
        # An unapproved command stops the skill for a permission prompt.
        allowed = field(self.front, "allowed-tools")
        runs = set(re.findall(r"`((?:git|which|cp) [^`]+)`", self.body))
        self.assertEqual(
            runs,
            {
                "git worktree list",
                "git remote -v",
                "which gh",
                "cp ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.bak",
            },
        )
        for command in runs:
            self.assertIn(f"Bash({command})", allowed)

    def test_drafts_are_the_reply_that_ends_the_turn(self):
        # On Claude Code 2.1.325, a draft Claude was told to print after a tool call and before
        # AskUserQuestion stayed in its thinking in 3 of 3 runs, so /init asked "Does this look
        # right?" about nothing on screen. Shown as the reply that ends the turn, it showed 3 of 3.
        show = section(self.body, "## Phase 4", "## Phase 5")
        self.assertIn("End your turn there", show)
        self.assertIn("Write nothing until the user replies", show)
        self.assertIn("in full", show)
        self.assertNotIn("AskUserQuestion", show)

    def test_approval_is_never_asked_with_ask_user_question(self):
        self.assertIn("Don't ask for approval with AskUserQuestion", self.body)
        self.assertNotRegex(self.body, r"(?i)look right\?")
        self.assertNotIn("Apply these edits?", self.body)

    def test_the_primer_prints_before_any_tool_call(self):
        # Text before the turn's first tool call reaches the screen; /init's primer, printed after
        # its first read, was skipped in 5 of 5 runs.
        primer = section(self.body, "## Phase 0", "## Phase 1")
        self.assertIn("first text of your reply, before any tool call", primer)
        self.assertLess(primer.index("Quick context"), primer.index("Read tool"))

    def test_the_first_question_offers_the_global_file_in_four_options(self):
        # AskUserQuestion takes at most four options. Multi-select stands in for /init's "Both".
        q1 = section(self.body, "## Phase 1", "How the answer routes")
        options = re.findall(r'^  - "([^"]+)":', q1, re.MULTILINE)
        self.assertEqual(
            options,
            [
                "Project CLAUDE.md",
                "Personal CLAUDE.local.md",
                "Global ~/.claude/CLAUDE.md",
                "Let Claude decide",
            ],
        )
        self.assertIn("`multiSelect: true`", q1)

    def test_global_skills_and_hooks_go_in_the_home_folder(self):
        where = section(self.body, "Where skills and hooks go", "## Phase 2")
        self.assertIn("`~/.claude/skills/`", where)
        self.assertIn("`~/.claude/settings.json`", where)
        self.assertIn(
            "`~/.claude/skills/<skill-name>/SKILL.md`",
            section(self.body, "## Phase 6", "## Phase 7"),
        )

    def test_the_global_file_is_backed_up_before_it_changes(self):
        # The global file isn't in git, so a replace with no backup can't be undone.
        write = section(self.body, "## Phase 5", "### What goes in each file")
        self.assertIn(
            "before you replace or edit an existing one, back it up with "
            "`cp ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.bak`",
            write,
        )

    def test_the_global_survey_looks_past_one_repo(self):
        survey = section(self.body, "**Global survey**", "## Phase 3")
        for source in [
            "`~/.claude/settings.json`",
            "output style",
            "`cwd`",
            "~/.claude/projects/*/",
        ]:
            self.assertIn(source, survey)

    def test_a_rerun_names_this_skill_not_the_built_in(self):
        self.assertIn("run `/instructions:init` again", self.body)
        self.assertNotRegex(self.body, r"`/init`")

    def test_the_body_has_no_placeholder_claude_code_would_fill_in(self):
        # Claude Code replaces $ARGUMENTS, $ARGUMENTS[N] and $N in a skill's body when it loads,
        # even inside backticks. "use `$ARGUMENTS` to take input" reached Claude as "use `` to take
        # input".
        self.assertNotRegex(self.body, r"\$(ARGUMENTS|\d)")

    def test_the_description_fits_the_skill_listing(self):
        # Claude Code cuts a skill's description off at 1,536 characters in its listing.
        description = field(self.front, "description")
        self.assertLessEqual(len(description), 1536)
        self.assertIn("~/.claude/CLAUDE.md", description)


if __name__ == "__main__":
    unittest.main()
