import re
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1] / "skills" / "review" / "SKILL.md"

# The sections the skill's steps name. Renaming one in the template without the skill would send
# a review looking for a section the file doesn't have.
NAMED_SECTIONS = ["Goals", "Non-goals", "Priorities", "Constraints", "Decisions", "Open questions", "Status"]


class SkillTest(unittest.TestCase):
    def setUp(self):
        _, self.front, self.body = SKILL.read_text().split("---\n", 2)
        self.allowed = next(line for line in self.front.splitlines() if line.startswith("allowed-tools:"))
        # The template sits in the skill, not a file beside it: Claude Code asks before the Read tool
        # or cat opens a file outside the project, which an installed plugin always is.
        self.template = re.search(r"^````markdown\n(.*?)^````$", self.body, re.M | re.S).group(1)
        self.steps = self.body.replace(self.template, "")
        self.headings = re.findall(r"^## (.+)$", self.template, re.M)

    def test_the_template_is_in_the_draft_step(self):
        draft = self.body[self.body.index("## 2. Draft"):self.body.index("## 3. Review")]
        self.assertIn(self.template, draft)
        self.assertNotIn("CLAUDE_SKILL_DIR", self.body)

    def test_every_section_it_names_is_a_template_heading(self):
        for section in NAMED_SECTIONS:
            self.assertIn(section, self.headings)
            self.assertIn(section, self.steps)

    def test_every_template_section_says_what_goes_there(self):
        sections = re.split(r"^## .+$", self.template, flags=re.M)[1:]
        self.assertEqual(len(sections), len(self.headings))
        for heading, text in zip(self.headings, sections):
            self.assertRegex(text, r"<!-- \S.+ -->", heading)

    def test_the_template_has_no_date_to_bump(self):
        # A date that changes on each review would make every run rewrite the file.
        self.assertNotRegex(self.template, r"(?im)last (updated|reviewed)|^date:")

    def test_status_holds_nothing_that_goes_stale_with_each_commit(self):
        # A first run once wrote "one commit" into Status, and every later review flagged it.
        status = self.template[self.template.index("## Status"):]
        self.assertIn("nothing that changes with every commit", status)

    def test_a_review_stays_off_the_code(self):
        # A run once tried to write test files to check the code mid-review.
        review = self.steps[self.steps.index("## 3. Review"):self.steps.index("## 4. Record")]
        self.assertIn("don't run, test or change the code", review)

    def test_the_decisions_format_is_the_same_in_both(self):
        line = "- YYYY-MM-DD: what was decided. Why: the reason."
        self.assertIn(line, self.template)
        self.assertIn(line, self.body)

    def test_every_git_command_it_runs_is_pre_approved(self):
        # An unapproved run stops the skill for a permission prompt, or fails outright under -p.
        runs = set(re.findall(r"^git ([a-z-]+)", self.body, re.M))
        runs |= set(re.findall(r"`git ([a-z-]+)", self.body))
        self.assertEqual(runs, {"rev-parse", "status", "log", "diff"})
        for command in runs:
            self.assertIn(f"Bash(git {command} *)", self.allowed)

    def test_git_finds_the_root_project_md_from_any_folder(self):
        # A pathspec after -- is read from the current folder, so in a subfolder
        # `git log -1 -- PROJECT.md` prints nothing for a committed PROJECT.md. :/ starts at the root.
        specs = re.findall(r"git (?:log|diff)[^`\n]* -- ([^\s`]+)", self.body)
        self.assertTrue(specs)
        self.assertEqual(set(specs), {":/PROJECT.md"})
        self.assertIn("git log -1 --format='%h %cs' -- :/PROJECT.md", self.body)

    def test_answered_findings_are_recorded_so_they_are_not_raised_again(self):
        self.assertIn("Otherwise the next review raises it again", self.body)
        self.assertIn("Drop any finding the file already answers", self.body)

    def test_nothing_is_written_without_approval(self):
        write = self.body[self.body.index("## 6. Write"):]
        self.assertIn("Write nothing until the user approves", write)

    def test_questions_are_asked_in_plain_text(self):
        self.assertIn("in plain text, not with AskUserQuestion", self.body)

    def test_it_leaves_loading_project_md_to_the_hook(self):
        # The plugin's prompt.context hook loads PROJECT.md. An @PROJECT.md the skill added as well
        # would be one more line to get right in CLAUDE.md, .claude/CLAUDE.md or AGENTS.md.
        self.assertNotIn("@PROJECT.md", self.body)
        self.assertNotIn("@../PROJECT.md", self.body)
        write = self.body[self.body.index("## 6. Write"):]
        self.assertIn("Don't add an import of PROJECT.md to CLAUDE.md", write)

    def test_the_argument_hint_names_both_uses(self):
        hint = next(line for line in self.front.splitlines() if line.startswith("argument-hint:"))
        self.assertIn("section", hint)
        self.assertIn("idea", hint)


if __name__ == "__main__":
    unittest.main()
