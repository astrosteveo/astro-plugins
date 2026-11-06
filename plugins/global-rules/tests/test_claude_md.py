import contextlib
import io
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "skills" / "suggest" / "scripts" / "claude_md.py"
sys.path.insert(0, str(SCRIPT.parent))
import claude_md  # noqa: E402

TODAY = date(2026, 11, 3)


class ClaudeMdTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.path = self.dir / "CLAUDE.md"

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_backup_is_the_file_byte_for_byte(self):
        self.path.write_bytes("# About me\n- Arch Linux — zsh\n".encode())
        made = claude_md.backup(self.path, TODAY)
        self.assertEqual(made, self.dir / "CLAUDE.md.bak-2026-11-03")
        self.assertEqual(made.read_bytes(), self.path.read_bytes())

    def test_a_second_backup_the_same_day_keeps_the_first(self):
        self.path.write_text("original\n")
        first = claude_md.backup(self.path, TODAY)
        self.path.write_text("edited\n")
        second = claude_md.backup(self.path, TODAY)
        self.assertEqual(second, self.dir / "CLAUDE.md.bak-2026-11-03-2")
        self.assertEqual(first.read_text(), "original\n")
        self.assertEqual(second.read_text(), "edited\n")

    def test_no_file_makes_no_backup(self):
        self.assertIsNone(claude_md.backup(self.path, TODAY))
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_the_diff_shows_the_lines_that_changed(self):
        old = self.dir / "CLAUDE.md.bak"
        old.write_text("# Code\n- Keep it simple.\n")
        self.path.write_text("# Code\n- Build the simplest thing.\n")
        text = claude_md.diff(old, self.path)
        self.assertIn("-- Keep it simple.\n", text)
        self.assertIn("+- Build the simplest thing.\n", text)

    def test_the_cli_prints_the_backup_or_says_there_was_no_file(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            claude_md.main(["backup", str(self.path)])
        self.assertIn("no backup", out.getvalue())
        self.path.write_text("x\n")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            claude_md.main(["backup", str(self.path)])
        self.assertEqual(out.getvalue().strip(), str(self.dir / f"CLAUDE.md.bak-{date.today().isoformat()}"))

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
