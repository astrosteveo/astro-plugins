import re
import unittest
from pathlib import Path
from urllib.parse import urlparse

SKILL = Path(__file__).resolve().parents[1] / "skills" / "suggest" / "SKILL.md"
GUIDANCE = (
    "https://code.claude.com/docs/en/memory.md",
    "https://code.claude.com/docs/en/best-practices.md",
)


class SkillTest(unittest.TestCase):
    def setUp(self):
        _, self.front, self.body = SKILL.read_text().split("---\n", 2)
        self.allowed = next(line for line in self.front.splitlines() if line.startswith("allowed-tools:"))

    def test_reads_the_claude_md_guidance_before_finding_candidates(self):
        candidates = self.body.index("Find candidates")
        for url in GUIDANCE:
            self.assertIn(url, self.body)
            self.assertLess(self.body.index(url), candidates, url)

    def test_every_docs_page_it_fetches_is_pre_approved(self):
        # An unapproved fetch stops the skill for a permission prompt, or fails outright under -p.
        domains = set(re.findall(r"WebFetch\(domain:([^)]+)\)", self.allowed))
        urls = re.findall(r"https://[^\s)]+", self.body)
        self.assertTrue(urls)
        for url in urls:
            self.assertIn(urlparse(url).hostname, domains, url)

    # The memory and best-practices pages name these; each run reads the pages, but the checks are
    # spelled out so a run doesn't skip them.
    def test_git_rules_are_checked_against_the_settings_that_compete_with_them(self):
        candidates = self.body[self.body.index("## 3. Find candidates"):]
        self.assertIn("includeGitInstructions", candidates)
        self.assertIn("attribution", candidates)

    def test_a_hook_that_enforces_only_a_preference_is_noted(self):
        candidates = self.body[self.body.index("## 3. Find candidates"):]
        self.assertIn("enforces only a preference", candidates)

    def test_the_written_file_is_handed_to_the_prompt_audit(self):
        write = self.body[self.body.index("## 5. Write"):]
        self.assertIn("/doctor prompt-audit", write)

    # allowed-tools holds only for the turn that invokes the skill, and the writes come a turn
    # later, after the user picks. A command the user types grants them again with no prompt;
    # Claude invoking the skill itself asks first in default mode.
    def test_the_user_is_asked_to_reply_with_the_apply_command(self):
        propose = self.body[self.body.index("## 4. Propose"):self.body.index("## 5. Write")]
        self.assertIn("`/global-memory:suggest apply 1, 3`", propose)
        self.assertIn("invoke this skill again", propose)

    # Claude Code asks before cp or diff touches a path outside the working folders, which the
    # global CLAUDE.md always is, even when allowed-tools lists them.
    def test_the_backup_and_the_diff_run_through_the_pre_approved_script(self):
        write = self.body[self.body.index("## 5. Write"):]
        self.assertIn("python3 ${CLAUDE_SKILL_DIR}/scripts/claude_md.py backup", write)
        self.assertIn("python3 ${CLAUDE_SKILL_DIR}/scripts/claude_md.py diff", write)
        self.assertIn("Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/claude_md.py *)", self.allowed)
        self.assertNotIn("Bash(cp", self.allowed)
        self.assertNotIn("Bash(diff", self.allowed)

    def test_a_failed_backup_stops_the_write(self):
        write = self.body[self.body.index("## 5. Write"):]
        self.assertIn("stop and write nothing", write)

    def test_settings_json_is_read_with_the_read_tool(self):
        self.assertIn("settings.json in the same folder, with the Read tool", self.body)

    def test_apply_skips_the_guidance_and_the_digest(self):
        front = self.body[:self.body.index("## 1. Read")]
        self.assertIn("$ARGUMENTS", front)
        self.assertIn("start with `apply`", front)
        self.assertIn("go to step 5", front)

    def test_the_argument_hint_shows_apply(self):
        hint = next(line for line in self.front.splitlines() if line.startswith("argument-hint:"))
        self.assertIn("apply", hint)

    def test_a_promoted_memory_is_deleted_with_the_tool_that_clears_its_index_line(self):
        # A plain rm leaves its MEMORY.md line in every later session's system prompt.
        write = self.body[self.body.index("## 5. Write"):]
        self.assertIn("global_memory_delete", write)


if __name__ == "__main__":
    unittest.main()
