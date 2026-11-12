import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "skills" / "track" / "scripts" / "board.py"
sys.path.insert(0, str(SCRIPT.parent))
import board  # noqa: E402

STATUS = {"id": "FIELD", "options": [{"id": "T", "name": "Todo"}, {"id": "P", "name": "In Progress"},
                                     {"id": "D", "name": "Done"}]}


def project(number=20, title="Printborn", closed=False, field=STATUS):
    return {"id": f"PVT{number}", "number": number, "title": title, "url": f"https://github.com/users/o/projects/{number}",
            "closed": closed, "field": field}


def item(status, number=None, title="t", state="OPEN", kind="Issue"):
    content = {"__typename": kind, "title": title}
    if number is not None:
        content |= {"number": number, "state": state}
    return {"status": {"name": status} if status else None, "content": content}


class FakeGh:
    """Answers gh's calls the way GitHub would for one repo, o/r, and records them."""

    def __init__(self, boards=(project(),), contents=None, pages=None, workflows=(), updates=(), milestones=()):
        self.boards = list(boards)
        self.contents = contents or {7: ("I7", "Issue"), 8: ("I8", "Issue"), 9: ("PR9", "PullRequest")}
        self.pages = pages or [[]]
        self.workflows = list(workflows)
        self.updates = list(updates)
        self.milestones = list(milestones)
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)
        if args[:2] == ("repo", "view"):
            return "o/r\n"
        if args[0] == "api" and args[1] != "graphql":
            return json.dumps(self.milestones)
        query = args[3].removeprefix("query=")
        vars = dict(a.split("=", 1) for a in args[5::2])
        if "projectsV2" in query:
            data = {"repository": {"projectsV2": {"nodes": self.boards}}}
        elif "issueOrPullRequest" in query:
            found = self.contents.get(int(vars["number"]))
            data = {"repository": {"issueOrPullRequest": found and {"id": found[0], "__typename": found[1]}}}
        elif "addProjectV2ItemById" in query:
            data = {"addProjectV2ItemById": {"item": {"id": "ITEM-" + vars["c"]}}}
        elif "createProjectV2StatusUpdate" in query:
            data = {"createProjectV2StatusUpdate": {"statusUpdate": {"createdAt": "2026-11-02T01:00:00Z"}}}
        elif "items(" in query:
            index = 0 if "after" not in vars else int(vars["after"])
            data = {"node": {
                "workflows": {"nodes": self.workflows},
                "statusUpdates": {"nodes": self.updates},
                "items": {"nodes": self.pages[index],
                          "pageInfo": {"hasNextPage": index + 1 < len(self.pages), "endCursor": str(index + 1)}}}}
        else:
            data = {}
        return json.dumps({"data": data})

    def mutations(self, name):
        return [dict(a.split("=", 1) for a in call[5::2]) for call in self.calls
                if call[:2] == ("api", "graphql") and name in call[3]]

    def query(self, needle):
        return next(call[3] for call in self.calls if call[:2] == ("api", "graphql") and needle in call[3])


class BoardTest(unittest.TestCase):
    def use(self, fake):
        self.fake = fake
        original = board.gh
        board.gh = fake
        self.addCleanup(setattr, board, "gh", original)
        return fake

    def run_main(self, *argv, stdin=""):
        out, err = io.StringIO(), io.StringIO()
        original = sys.stdin
        sys.stdin = io.StringIO(stdin)
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = board.main(list(argv))
        finally:
            sys.stdin = original
        return code, out.getvalue(), err.getvalue()


class FindsTheBoard(BoardTest):
    def test_the_repo_s_one_open_board(self):
        self.use(FakeGh(boards=[project(3, "Old", closed=True), project(20)]))
        self.assertEqual(board.board("o/r", None)["number"], 20)

    def test_a_repo_with_no_board_is_told_how_to_set_one_up(self):
        self.use(FakeGh(boards=[]))
        code, _, err = self.run_main("show")
        self.assertEqual(code, 1)
        self.assertIn("no board is linked to o/r", err)
        self.assertIn("gh project link", err)

    def test_several_boards_need_a_number(self):
        self.use(FakeGh(boards=[project(20, "A"), project(21, "B")]))
        with self.assertRaisesRegex(board.Fail, r"several boards: 20 \(A\), 21 \(B\)"):
            board.board("o/r", None)
        self.assertEqual(board.board("o/r", 21)["title"], "B")

    def test_a_board_without_a_status_field_says_so(self):
        self.use(FakeGh(boards=[project(field={})]))
        with self.assertRaisesRegex(board.Fail, "no Status field"):
            board.board("o/r", None)

    def test_a_repo_that_isn_t_owner_slash_name_is_an_error_not_a_traceback(self):
        for repo in ("r", "https://github.com/o/r"):
            for command in (["show"], ["sub", "7", "8"]):
                with self.subTest(repo=repo, command=command[0]):
                    fake = self.use(FakeGh())
                    code, _, err = self.run_main("--repo", repo, *command)
                    self.assertEqual(code, 1)
                    self.assertIn(f"board.py: --repo is OWNER/NAME, not {repo}", err)
                    self.assertEqual(fake.calls, [])

    def test_strings_go_as_strings_and_numbers_as_numbers(self):
        # -F would send the owner "123" as a number and the query would fail.
        fake = self.use(FakeGh())
        board.graphql("query", owner="123", number=7)
        self.assertEqual(fake.calls[-1][4:], ("-f", "owner=123", "-F", "number=7"))


class Move(BoardTest):
    def test_adds_the_item_and_sets_the_status_by_name_in_any_case(self):
        fake = self.use(FakeGh())
        code, out, _ = self.run_main("move", "#7", "in progress")
        self.assertEqual((code, out), (0, "#7 is In Progress on Printborn\n"))
        self.assertEqual(fake.mutations("addProjectV2ItemById"), [{"p": "PVT20", "c": "I7"}])
        self.assertEqual(fake.mutations("updateProjectV2ItemFieldValue"),
                         [{"p": "PVT20", "i": "ITEM-I7", "f": "FIELD", "o": "P"}])

    def test_a_pr_by_its_url_in_another_repo(self):
        fake = self.use(FakeGh())
        board.move("o/r", None, "https://github.com/x/y/pull/9", "Done")
        lookup = next(c for c in fake.calls if "issueOrPullRequest" in c[3])
        self.assertIn("owner=x", lookup)
        self.assertIn("name=y", lookup)
        self.assertEqual(fake.mutations("addProjectV2ItemById"), [{"p": "PVT20", "c": "PR9"}])

    def test_an_unknown_status_names_the_board_s_and_changes_nothing(self):
        fake = self.use(FakeGh())
        with self.assertRaisesRegex(board.Fail, "no status 'Doing'; it has Todo, In Progress, Done"):
            board.move("o/r", None, "7", "Doing")
        self.assertEqual(fake.mutations("addProjectV2ItemById"), [])

    def test_a_missing_issue_or_a_bad_ref(self):
        self.use(FakeGh())
        with self.assertRaisesRegex(board.Fail, "no issue or PR #40"):
            board.move("o/r", None, "40", "Todo")
        with self.assertRaisesRegex(board.Fail, "neither an issue or PR number nor its URL"):
            board.move("o/r", None, "seven", "Todo")


class Sub(BoardTest):
    def test_links_each_child_to_the_parent(self):
        fake = self.use(FakeGh())
        code, out, _ = self.run_main("sub", "7", "8", "https://github.com/o/r/issues/8")
        self.assertEqual(code, 0)
        self.assertEqual(out, "#8 is a sub-issue of #7\n#8 is a sub-issue of #7\n")
        self.assertEqual(fake.mutations("addSubIssue"), [{"p": "I7", "c": "I8"}] * 2)

    def test_a_pull_request_is_neither_parent_nor_child(self):
        fake = self.use(FakeGh())
        with self.assertRaisesRegex(board.Fail, "#9 is a pull request"):
            board.sub("o/r", "9", ["8"])
        with self.assertRaisesRegex(board.Fail, "#9 is a pull request"):
            board.sub("o/r", "7", ["9"])
        self.assertEqual(fake.mutations("addSubIssue"), [])

    def test_a_refused_child_links_none_of_the_others(self):
        # Linking #8 and then failing on a later child would leave #8 linked without saying so.
        for bad, why in (("9", "#9 is a pull request"), ("40", "no issue or PR #40")):
            with self.subTest(child=bad):
                fake = self.use(FakeGh())
                code, out, err = self.run_main("sub", "7", "8", bad)
                self.assertEqual((code, out), (1, ""))
                self.assertIn(why, err)
                self.assertEqual(fake.mutations("addSubIssue"), [])


class Update(BoardTest):
    def test_posts_the_body_from_a_file_with_the_status_graphql_spells(self):
        fake = self.use(FakeGh())
        with tempfile.NamedTemporaryFile("w", suffix=".md") as f:
            f.write("**Step 1 is done.**\n\n**Next:** #8\n")
            f.flush()
            code, out, _ = self.run_main("update", "at-risk", f.name)
        self.assertEqual(code, 0)
        self.assertIn("Posted a status update (at-risk) on Printborn", out)
        self.assertEqual(fake.mutations("createProjectV2StatusUpdate"),
                         [{"p": "PVT20", "s": "AT_RISK", "b": "**Step 1 is done.**\n\n**Next:** #8"}])

    def test_reads_stdin_and_refuses_an_empty_body(self):
        fake = self.use(FakeGh())
        self.assertEqual(self.run_main("update", "complete", "-", stdin="All done.\n")[0], 0)
        self.assertEqual(fake.mutations("createProjectV2StatusUpdate")[0]["s"], "COMPLETE")
        code, _, err = self.run_main("update", "on-track", "-", stdin="  \n")
        self.assertEqual(code, 1)
        self.assertIn("body is empty", err)

    def test_a_missing_file_is_an_error_not_a_traceback(self):
        self.use(FakeGh())
        code, _, err = self.run_main("update", "on-track", "/nonexistent/update.md")
        self.assertEqual(code, 1)
        self.assertIn("board.py:", err)


class Show(BoardTest):
    def test_groups_what_isn_t_done_by_the_board_s_order_and_flags_items_out_of_step(self):
        self.use(FakeGh(
            pages=[[item("In Progress", 32, "travel"), item("Done", 31, "merged", "CLOSED"),
                    item("Todo", 7, "terrain")],
                   [item("Todo", 30, "finished", "CLOSED"), item("Done", 29, "reopened"), item(None, 28, "loose"),
                    item("Todo", title="an idea", kind="DraftIssue")]],
            workflows=[{"name": "Item closed", "enabled": True}, {"name": "Pull request merged", "enabled": False}],
            milestones=[{"title": "Slice 4", "open_issues": 3, "closed_issues": 1}],
            updates=[{"createdAt": "2026-11-02T00:59:22Z", "status": "ON_TRACK", "body": "**Slices 2 and 3 are done.**"}]))
        out = board.show("o/r", None).splitlines()
        self.assertEqual(out[1:], [
            "Workflows off: Pull request merged",
            "Open milestones: Slice 4 (1 of 4 closed)",
            "Todo:",
            "  #7 terrain",
            "  #30 finished (closed)",
            "  (draft) an idea",
            "In Progress:",
            "  #32 travel",
            "Done:",
            "  #29 reopened (open)",
            "No status:",
            "  #28 loose",
            "Latest status update (2026-11-02, on-track):",
            "  **Slices 2 and 3 are done.**",
        ])

    def test_asks_for_the_newest_status_update(self):
        # GitHub lists a board's status updates oldest first, so last:1 or an unordered first:1 gets the oldest.
        fake = self.use(FakeGh())
        board.show("o/r", None)
        self.assertRegex(fake.query("statusUpdates"),
                         r"statusUpdates\(first:1,orderBy:\{field:CREATED_AT,direction:DESC\}\)")

    def test_a_board_with_nothing_open_and_no_update(self):
        self.use(FakeGh())
        self.assertEqual(board.show("o/r", None).splitlines()[1:], ["Open milestones: none", "No status update yet"])

    def test_a_draft_at_done_is_done(self):
        # A draft has no open or closed state, so it can't be closed to match Done.
        self.use(FakeGh(pages=[[item("Done", title="an idea", kind="DraftIssue")]]))
        self.assertEqual(board.show("o/r", None).splitlines()[1:], ["Open milestones: none", "No status update yet"])


if __name__ == "__main__":
    unittest.main()
