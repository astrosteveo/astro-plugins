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
        _, front, self.body = SKILL.read_text().split("---\n", 2)
        self.allowed = next(line for line in front.splitlines() if line.startswith("allowed-tools:"))

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

    def test_a_promoted_memory_is_deleted_with_the_tool_that_clears_its_index_line(self):
        # A plain rm leaves its MEMORY.md line in every later session's system prompt.
        write = self.body[self.body.index("## 5. Write"):]
        self.assertIn("global_memory_delete", write)


if __name__ == "__main__":
    unittest.main()
