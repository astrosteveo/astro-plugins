import re
import unittest
from pathlib import Path
from urllib.parse import urlparse

PLUGIN = Path(__file__).resolve().parents[1]
SKILL = PLUGIN / "skills" / "claude-md" / "SKILL.md"


class ClaudeMdSkillTest(unittest.TestCase):
    def setUp(self):
        _, self.front, self.body = SKILL.read_text().split("---\n", 2)
        self.allowed = self.field("allowed-tools")
        self.description = self.field("description")

    def field(self, key):
        return next(line for line in self.front.splitlines() if line.startswith(f"{key}:"))

    def step(self, start, end=None):
        return self.body[self.body.index(start):self.body.index(end) if end else None]

    def test_it_is_loaded_before_any_change_is_even_proposed(self):
        # The description is what makes Claude load a skill on its own, before it acts.
        self.assertTrue(self.description.startswith(
            "description: Use before you propose, draft, recommend or make any change"), self.description)

    def test_the_description_names_every_instruction_file(self):
        for name in ["~/.claude/CLAUDE.md", "~/.claude/rules/", "CLAUDE.local.md", "AGENTS.md", ".claude/rules/"]:
            self.assertIn(name, self.description)

    def test_the_description_fits_the_skill_listing(self):
        # Claude Code cuts a skill's description in the listing at 1,536 characters.
        self.assertLessEqual(len(self.description) - len("description: "), 1536)

    def test_every_script_it_runs_is_pre_approved_and_exists(self):
        # An unapproved run stops the skill for a permission prompt, or fails outright under -p.
        scripts = set(re.findall(r"python3 (\S+\.py)", self.body))
        self.assertEqual(scripts, {"${CLAUDE_PLUGIN_ROOT}/scripts/guidance.py",
                                   "${CLAUDE_PLUGIN_ROOT}/scripts/claude_md.py"})
        for script in scripts:
            self.assertIn(f"Bash(python3 {script} *)", self.allowed)
            self.assertTrue((PLUGIN / script.replace("${CLAUDE_PLUGIN_ROOT}/", "")).is_file(), script)
        self.assertIn("Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/guidance.py)", self.allowed)

    def test_the_guidance_is_read_before_anything_is_placed_or_proposed(self):
        guidance = self.body.index("scripts/guidance.py")
        self.assertLess(guidance, self.body.index("## 3. Place"))
        self.assertIn("Read all of it before you propose or write anything", self.step("## 1.", "## 2."))

    def test_every_page_it_fetches_is_on_the_pre_approved_domain(self):
        domains = set(re.findall(r"WebFetch\(domain:([^)]+)\)", self.allowed))
        urls = re.findall(r"https://[^\s)]+", self.body)
        self.assertTrue(urls)
        for url in urls:
            self.assertIn(urlparse(url).hostname, domains, url)

    def test_a_project_with_no_claude_md_is_left_to_init(self):
        # Claude Code's /init starts a project's file from its code; this skill doesn't redo that.
        self.assertIn("offer `/init`", self.step("## 2.", "## 3."))

    def test_conflicts_across_files_are_left_to_the_prompt_audit(self):
        self.assertIn("/doctor prompt-audit", self.step("## 3.", "## 4."))
        self.assertIn("/doctor prompt-audit", self.step("## 5."))

    def test_it_never_edits_settings(self):
        self.assertIn("don't edit settings.json", self.step("## 3.", "## 4."))

    def test_apply_goes_straight_to_the_write(self):
        top = self.body[:self.body.index("## 1.")]
        self.assertIn("$ARGUMENTS", top)
        self.assertIn("start with `apply`", top)
        self.assertIn("Go to step 5", top)
        self.assertIn("apply", self.field("argument-hint"))

    # allowed-tools holds only for the turn that invokes the skill, and the writes come a turn
    # later, after the user picks. A command the user types grants them again with no prompt.
    def test_the_user_answers_with_the_apply_command(self):
        propose = self.step("## 4. Propose", "## 5. Write")
        self.assertIn("`/global-rules:claude-md apply 1, 3`", propose)
        self.assertIn("invoke this skill yourself", propose)
        self.assertIn("Write nothing until the user answers", propose)

    def test_an_exact_request_the_guidance_leaves_as_it_is_needs_no_second_yes(self):
        # A user who said "add this line under Commands, just make the edit" was asked to type
        # /global-rules:claude-md apply 1 for a line the skill didn't change.
        propose = self.step("## 4. Propose", "## 5. Write")
        self.assertIn("their request is their approval", propose)
        self.assertIn("Anything you'd reword, move or leave out, propose first", propose)

    def test_the_backup_and_the_diff_run_through_the_pre_approved_script(self):
        write = self.step("## 5. Write")
        self.assertIn("python3 ${CLAUDE_PLUGIN_ROOT}/scripts/claude_md.py backup", write)
        self.assertIn("python3 ${CLAUDE_PLUGIN_ROOT}/scripts/claude_md.py diff", write)
        self.assertIn("stop and write nothing", write)
        self.assertNotIn("Bash(cp", self.allowed)
        self.assertNotIn("Bash(diff", self.allowed)

    def test_a_repeated_memory_is_deleted_only_with_the_tool_that_clears_its_index_line(self):
        write = self.step("## 5. Write")
        self.assertIn("`global_memory_delete` tool is available", write)
        self.assertIn("global-memory plugin is not installed", write)

    def test_questions_are_asked_in_plain_text(self):
        self.assertIn("in plain text, not with AskUserQuestion", self.step("## 2.", "## 3."))
        self.assertIn("in plain text, not with AskUserQuestion", self.step("## 4.", "## 5."))


if __name__ == "__main__":
    unittest.main()
