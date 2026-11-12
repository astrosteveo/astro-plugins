import re
import unittest
from pathlib import Path

SKILLS = Path(__file__).resolve().parents[1] / "skills"

# The sections the skills' steps name. Renaming one in the template without the skills would send
# a review looking for a section the file doesn't have.
NAMED_SECTIONS = ["Goals", "Non-goals", "Priorities", "Constraints", "Decisions", "Open questions", "Status"]


def skill(name):
    _, front, body = (SKILLS / name / "SKILL.md").read_text().split("---\n", 2)
    return front, body


def field(front, key):
    return next(line for line in front.splitlines() if line.startswith(f"{key}:"))


def step(body, start, end=None):
    return body[body.index(start):body.index(end) if end else None]


def write_step(body):
    return body[re.search(r"^## \d\. Write$", body, re.M).start():]


class BothSkillsTest(unittest.TestCase):
    def test_every_git_command_each_runs_is_pre_approved(self):
        # An unapproved run stops the skill for a permission prompt, or fails outright under -p.
        for name, expected in [("init", {"rev-parse", "log"}), ("review", {"rev-parse", "status", "log", "diff"})]:
            with self.subTest(name):
                front, body = skill(name)
                runs = set(re.findall(r"^git ([a-z-]+)", body, re.M))
                runs |= set(re.findall(r"`git ([a-z-]+)", body))
                self.assertEqual(runs, expected)
                for command in runs:
                    self.assertIn(f"Bash(git {command} *)", field(front, "allowed-tools"))

    def test_nothing_is_written_without_approval(self):
        for name in ["init", "review"]:
            with self.subTest(name):
                write = write_step(skill(name)[1])
                self.assertIn("Write nothing until the user approves", write)

    def test_questions_are_asked_in_plain_text(self):
        for name in ["init", "review"]:
            with self.subTest(name):
                self.assertIn("in plain text, not with AskUserQuestion", skill(name)[1])

    def test_each_leaves_loading_project_md_to_the_hook(self):
        # The plugin's prompt.context hook loads PROJECT.md. An @PROJECT.md a skill added as well
        # would be one more line to get right in CLAUDE.md, .claude/CLAUDE.md or AGENTS.md.
        for name in ["init", "review"]:
            with self.subTest(name):
                body = skill(name)[1]
                self.assertNotIn("@PROJECT.md", body)
                self.assertNotIn("@../PROJECT.md", body)
                self.assertIn("Don't add an import of PROJECT.md to CLAUDE.md", write_step(body))

    def test_each_hands_the_other_case_to_the_other_skill(self):
        # Init on a repo with PROJECT.md would overwrite it; review on one without has nothing to read.
        for name, other in [("init", "/project-md:review"), ("review", "/project-md:init")]:
            with self.subTest(name):
                front, body = skill(name)
                self.assertIn(other, field(front, "description"))
                self.assertIn(other, step(body, "## 1. Look", "## 2."))


class InitTest(unittest.TestCase):
    def setUp(self):
        _, self.body = skill("init")
        # The template sits in the skill, not a file beside it: Claude Code asks before the Read tool
        # or cat opens a file outside the project, which an installed plugin always is.
        self.template = re.search(r"^````markdown\n(.*?)^````$", self.body, re.M | re.S).group(1)
        self.steps = self.body.replace(self.template, "")
        self.headings = re.findall(r"^## (.+)$", self.template, re.M)

    def test_the_template_is_in_the_draft_step(self):
        self.assertIn(self.template, step(self.body, "## 2. Draft", "## 3. Write"))
        self.assertNotIn("CLAUDE_SKILL_DIR", self.body)

    def test_every_section_named_is_a_template_heading(self):
        review = skill("review")[1]
        for section in NAMED_SECTIONS:
            self.assertIn(section, self.headings)
            self.assertIn(section, review)

    def test_review_checks_for_the_template_sections_in_order(self):
        # Review can't read the template from init's SKILL.md without a permission prompt, so it
        # keeps the list of sections itself.
        listed = re.search(r"one copy of each section, in this order: (.+?)\. ", skill("review")[1]).group(1)
        self.assertEqual(listed.split(", "), self.headings)

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

    def test_the_decisions_format_is_the_same_in_the_template_and_review(self):
        line = "- YYYY-MM-DD: what was decided. Why: the reason."
        self.assertIn(line, self.template)
        self.assertIn(line, skill("review")[1])

    def test_it_does_not_overwrite_a_project_md_that_exists(self):
        look = step(self.body, "## 1. Look", "## 2.")
        self.assertIn("If PROJECT.md already exists at the repo root, don't draft another", look)


class ReviewTest(unittest.TestCase):
    def setUp(self):
        self.front, self.body = skill("review")

    def test_a_review_stays_off_the_code(self):
        # A run once tried to write test files to check the code mid-review.
        self.assertIn("don't run, test or change the code", step(self.body, "## 2. Review", "## 3. Record"))

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

    def test_status_is_kept_free_of_what_goes_stale_with_each_commit(self):
        self.assertIn("Status that holds something that changes with every commit", self.body)

    def test_the_argument_hint_names_both_uses(self):
        hint = field(self.front, "argument-hint")
        self.assertIn("section", hint)
        self.assertIn("idea", hint)


if __name__ == "__main__":
    unittest.main()
