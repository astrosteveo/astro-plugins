import contextlib
import io
import os
import sys
import tempfile
import unittest
from unittest import mock
from datetime import date
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "claude_md.py"
sys.path.insert(0, str(SCRIPT.parent))
import claude_md  # noqa: E402

TODAY = date(2026, 11, 3)


class ClaudeMdTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.path = self.dir / "CLAUDE.md"
        self.into = self.dir / "backups"
        self.name = str(self.path.resolve()).strip("/").replace("/", "-")

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_backup_is_the_file_byte_for_byte(self):
        self.path.write_bytes("# About me\n- Arch Linux — zsh\n".encode())
        made = claude_md.backup(self.path, TODAY, self.into)
        self.assertEqual(made, self.into / f"{self.name}.bak-2026-11-03")
        self.assertEqual(made.read_bytes(), self.path.read_bytes())

    def test_a_backup_leaves_nothing_beside_the_file(self):
        # A project's CLAUDE.md sits in a repo, where a .bak file would show up as a change.
        self.path.write_text("x\n")
        claude_md.backup(self.path, TODAY, self.into)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["CLAUDE.md", "backups"])

    def test_two_projects_files_get_their_own_backups(self):
        other = self.dir / "other" / "CLAUDE.md"
        other.parent.mkdir()
        other.write_text("other\n")
        self.path.write_text("this\n")
        first = claude_md.backup(self.path, TODAY, self.into)
        second = claude_md.backup(other, TODAY, self.into)
        self.assertNotEqual(first, second)
        self.assertEqual(second.read_text(), "other\n")

    def test_a_second_backup_the_same_day_keeps_the_first(self):
        self.path.write_text("original\n")
        first = claude_md.backup(self.path, TODAY, self.into)
        self.path.write_text("edited\n")
        second = claude_md.backup(self.path, TODAY, self.into)
        self.assertEqual(second, self.into / f"{self.name}.bak-2026-11-03-2")
        self.assertEqual(first.read_text(), "original\n")
        self.assertEqual(second.read_text(), "edited\n")

    def test_no_file_makes_no_backup(self):
        self.assertIsNone(claude_md.backup(self.path, TODAY, self.into))
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_the_diff_shows_the_lines_that_changed(self):
        old = self.dir / "CLAUDE.md.bak"
        old.write_text("# Code\n- Keep it simple.\n")
        self.path.write_text("# Code\n- Build the simplest thing.\n")
        text = claude_md.diff(old, self.path)
        self.assertIn("-- Keep it simple.\n", text)
        self.assertIn("+- Build the simplest thing.\n", text)

    def test_a_rule_added_after_a_last_line_with_no_newline_keeps_diff_lines_apart(self):
        old = self.dir / "CLAUDE.md.bak-2026-11-03"
        old.write_text("# Code\n- Keep it simple.")
        self.path.write_text("# Code\n- Keep it simple.\n- Test first.")
        text = claude_md.diff(old, self.path)
        self.assertNotIn("simple.+- Keep", text)
        # As diff -u marks a last line with no newline.
        self.assertIn("-- Keep it simple.\n\\ No newline at end of file\n+- Keep it simple.\n", text)
        self.assertTrue(text.endswith("+- Test first.\n\\ No newline at end of file\n"), text)

    def test_the_cli_prints_the_backup_or_says_there_was_no_file(self):
        patched = mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.dir / "config")})
        patched.start()
        self.addCleanup(patched.stop)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            claude_md.main(["backup", str(self.path)])
        self.assertIn("no backup", out.getvalue())
        self.path.write_text("x\n")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            claude_md.main(["backup", str(self.path)])
        backups = self.dir / "config" / "global-rules" / "backups"
        self.assertEqual(out.getvalue().strip(), str(backups / f"{self.name}.bak-{date.today().isoformat()}"))

    def test_the_cli_says_when_nothing_changed(self):
        self.path.write_text("same\n")
        old = self.dir / "old.md"
        old.write_text("same\n")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            claude_md.main(["diff", str(old), str(self.path)])
        self.assertEqual(out.getvalue(), "No changes.\n")


if __name__ == "__main__":
    unittest.main()
