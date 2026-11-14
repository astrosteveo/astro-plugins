import tempfile
import unittest
from datetime import date
from pathlib import Path

from ledger.parse import Entry
from ledger.store import Ledger


class LedgerTest(unittest.TestCase):
    def test_a_saved_ledger_loads_back(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "book.json"
            book = Ledger()
            book.add(Entry(date(2026, 3, 14), 1250, "food", ["lunch", "work"]))
            book.save(path)
            self.assertEqual(Ledger.load(path).entries, book.entries)

    def test_a_missing_file_is_an_empty_ledger(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(Ledger.load(Path(folder) / "none.json").entries, [])


if __name__ == "__main__":
    unittest.main()
