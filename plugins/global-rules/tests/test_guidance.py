import os
import sys
import tempfile
import time
import unittest
from datetime import date
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "guidance.py"
sys.path.insert(0, str(SCRIPT.parent))
import guidance  # noqa: E402

# A page shaped like the docs: an example CLAUDE.md in a fence carries headings of its own.
PAGE = """> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt

# Best practices

## Keep it short

Every line costs attention.

```markdown CLAUDE.md theme={null}
# Commands
- Install: pnpm install
```

### Kept with its section

A subsection.

## Enforce rules

Make it a hook.

### Long example

Many lines of hook setup.

## Something else

Not wanted.
"""


class SectionsTest(unittest.TestCase):
    def test_a_heading_in_a_code_fence_is_not_a_section(self):
        names = [name for _, _, name in guidance.headings(PAGE)]
        self.assertNotIn("Commands", names)
        self.assertIn("Kept with its section", names)

    def test_a_longer_fence_holds_a_shorter_one(self):
        text = "````markdown\n```\n# Inside\n```\n````\n## Outside\n"
        self.assertEqual([name for _, _, name in guidance.headings(text)], ["Outside"])

    def test_a_whole_section_keeps_its_subsections_and_stops_at_the_next_peer(self):
        kept, missing = guidance.sections(PAGE, [("Keep it short", True)])
        self.assertEqual(missing, [])
        self.assertIn("# Commands", kept[0])
        self.assertIn("A subsection.", kept[0])
        self.assertNotIn("Make it a hook.", kept[0])

    def test_an_intro_only_section_stops_at_its_first_subsection(self):
        kept, _ = guidance.sections(PAGE, [("Enforce rules", False)])
        self.assertIn("Make it a hook.", kept[0])
        self.assertNotIn("Many lines", kept[0])

    def test_a_heading_the_page_lacks_is_named(self):
        kept, missing = guidance.sections(PAGE, [("Keep it short", True), ("Gone", True)])
        self.assertEqual(len(kept), 1)
        self.assertEqual(missing, ["Gone"])

    def test_a_curly_apostrophe_matches_a_straight_one(self):
        kept, missing = guidance.sections("## Rules that can’t bend\n\nText.\n",
                                          [("Rules that can't bend", True)])
        self.assertEqual(missing, [])
        self.assertIn("Text.", kept[0])


class BuildTest(unittest.TestCase):
    def test_each_page_is_named_and_unfetched_pages_say_how_to_read_them(self):
        def get(url):
            if url == guidance.MEMORY:
                raise OSError("timed out")
            return PAGE
        text = guidance.build(get, date(2026, 11, 12))
        self.assertTrue(text.startswith("Fetched 2026-11-12"))
        self.assertIn(f"# {guidance.MEMORY}\n\nCouldn't fetch this page (timed out). Read it with WebFetch.", text)
        self.assertIn(f"# {guidance.BEST_PRACTICES}", text)

    def test_sections_the_page_no_longer_has_are_listed(self):
        text = guidance.build(lambda url: PAGE, date(2026, 11, 12))
        self.assertIn("Not found on this page, which may have changed: Deterministic and", text)
        self.assertIn("Read the page with WebFetch", text)

    def test_the_documentation_index_note_is_left_out(self):
        self.assertNotIn("Documentation Index", guidance.build(lambda url: PAGE))


class CacheTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cache = Path(self.tmp.name) / "global-rules" / "guidance.md"
        self.fetches = []

    def get(self, url):
        self.fetches.append(url)
        return "## Keep CLAUDE.md short\n\nShort.\n"

    def fail(self, url):
        raise OSError("offline")

    def test_a_fresh_copy_is_used_without_fetching(self):
        self.cache.parent.mkdir(parents=True)
        self.cache.write_text("kept\n")
        self.assertEqual(guidance.guidance(self.cache, False, self.get), "kept\n")
        self.assertEqual(self.fetches, [])

    def test_a_copy_over_a_day_old_is_fetched_again_and_kept(self):
        self.cache.parent.mkdir(parents=True)
        self.cache.write_text("old\n")
        old = time.time() - guidance.MAX_AGE - 60
        os.utime(self.cache, (old, old))
        text = guidance.guidance(self.cache, False, self.get)
        self.assertIn("Short.", text)
        self.assertEqual(self.cache.read_text(), text)
        self.assertEqual(len(self.fetches), 2)

    def test_refresh_fetches_even_a_fresh_copy(self):
        self.cache.parent.mkdir(parents=True)
        self.cache.write_text("kept\n")
        self.assertIn("Short.", guidance.guidance(self.cache, True, self.get))

    def test_offline_falls_back_to_the_old_copy_and_says_how_old(self):
        self.cache.parent.mkdir(parents=True)
        self.cache.write_text("old\n")
        old = time.time() - 3 * 86400
        os.utime(self.cache, (old, old))
        text = guidance.guidance(self.cache, False, self.fail)
        self.assertTrue(text.startswith("Couldn't fetch the docs now, so this is the copy kept 3 days ago."), text)
        self.assertTrue(text.endswith("old\n"))

    def test_a_failed_fetch_is_never_kept(self):
        text = guidance.guidance(self.cache, False, self.fail)
        self.assertIn("Read it with WebFetch", text)
        self.assertFalse(self.cache.exists())


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = self.root / "config"
        (self.config / "rules" / "lang").mkdir(parents=True)
        (self.config / "CLAUDE.md").write_text("x")
        (self.config / "rules" / "lang" / "python.md").write_text("x")
        self.repo = self.root / "game"
        (self.repo / ".git").mkdir(parents=True)
        (self.repo / "src").mkdir()
        (self.repo / "AGENTS.md").write_text("x")

    def test_it_lists_the_files_that_exist_from_a_subfolder_of_the_repo(self):
        text = guidance.inventory(self.config, self.repo / "src")
        self.assertIn(f"- Global CLAUDE.md ({self.config / 'CLAUDE.md'}): {self.config / 'CLAUDE.md'}", text)
        self.assertIn(str(self.config / "rules" / "lang" / "python.md"), text)
        self.assertIn("- Global settings: none", text)
        self.assertIn(f"- Project instruction files in {self.repo}: {self.repo / 'AGENTS.md'}", text)

    def test_outside_a_repo_it_says_there_are_no_project_files(self):
        self.assertIn("No git repo at", guidance.inventory(self.config, self.root))


if __name__ == "__main__":
    unittest.main()
