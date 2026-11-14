import unittest
from datetime import date
from decimal import Decimal

from ledger.parse import Entry
from ledger.report import daily_average, month_range, monthly_total, totals_by_tag
from ledger.store import Ledger


def march():
    book = Ledger()
    book.add(Entry(date(2026, 3, 1), 1250, "food", ["lunch"]))
    book.add(Entry(date(2026, 3, 1), 500, "food", []))
    book.add(Entry(date(2026, 3, 31), 2000, "rent", ["home", "lunch"]))
    book.add(Entry(date(2026, 4, 1), 9999, "food", []))
    return book


class ReportTest(unittest.TestCase):
    def test_month_range(self):
        self.assertEqual(month_range(2026, 3), (date(2026, 3, 1), date(2026, 4, 1)))

    def test_monthly_total_counts_only_that_month(self):
        self.assertEqual(monthly_total(march(), 2026, 3), Decimal("37.50"))

    def test_daily_average_is_per_day_with_an_expense(self):
        self.assertEqual(daily_average(march(), 2026, 3), Decimal("18.75"))
        self.assertEqual(daily_average(march(), 2026, 5), Decimal("0.00"))

    def test_totals_by_tag(self):
        self.assertEqual(
            totals_by_tag(march(), 2026, 3),
            {"home": Decimal("20.00"), "lunch": Decimal("32.50")},
        )


if __name__ == "__main__":
    unittest.main()
