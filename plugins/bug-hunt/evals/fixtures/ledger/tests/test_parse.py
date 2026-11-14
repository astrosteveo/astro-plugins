import unittest
from datetime import date

from ledger.parse import Entry, parse_amount, parse_line


class ParseAmountTest(unittest.TestCase):
    def test_amounts_become_cents(self):
        self.assertEqual(parse_amount("12.34"), 1234)
        self.assertEqual(parse_amount("1,234.50"), 123450)
        self.assertEqual(parse_amount("-5"), -500)
        self.assertEqual(parse_amount("$3"), 300)

    def test_text_that_isnt_an_amount_is_refused(self):
        for text in ("", "abc", "1,2,3", "1.234", "$"):
            with self.assertRaises(ValueError, msg=text):
                parse_amount(text)


class ParseLineTest(unittest.TestCase):
    def test_a_line_with_tags(self):
        entry = parse_line("2026-03-14\t12.50\tfood\tlunch, work\n")
        self.assertEqual(
            entry, Entry(date(2026, 3, 14), 1250, "food", ["lunch", "work"])
        )

    def test_a_line_without_tags(self):
        self.assertEqual(parse_line("2026-03-14\t-5\trefund").tags, [])

    def test_a_line_with_too_few_fields_is_refused(self):
        with self.assertRaises(ValueError):
            parse_line("2026-03-14\t12.50")


if __name__ == "__main__":
    unittest.main()
