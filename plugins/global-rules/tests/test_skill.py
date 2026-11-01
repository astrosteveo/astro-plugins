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


if __name__ == "__main__":
    unittest.main()
