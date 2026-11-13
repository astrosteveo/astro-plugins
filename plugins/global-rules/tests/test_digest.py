import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "skills" / "suggest" / "scripts" / "digest.py"
sys.path.insert(0, str(SCRIPT.parent))
import digest  # noqa: E402

# The sample lives with the plugin that writes memory files, and is shared, not copied.
FIXTURE = Path(__file__).resolve().parents[2] / "global-memory" / "tests" / "memory-file.fixture.ts"

ALPHA = "/home/u/Projects/alpha"
BETA = "/home/u/Projects/beta"


# The sample memory file both suites share: a TS module whose default export is plain JSON.
def shared_sample():
    text = FIXTURE.read_text()
    start = "\nexport default "
    return json.loads(text[text.index(start) + len(start):])


def human(text, cwd=ALPHA, ts="2026-10-01T10:00:00Z", **extra):
    return {"type": "user", "message": {"role": "user", "content": text}, "origin": {"kind": "human"},
            "entrypoint": "cli", "cwd": cwd, "timestamp": ts, **extra}


def blocks(content, cwd=ALPHA, ts="2026-10-01T10:00:00Z"):
    return {"type": "user", "message": {"role": "user", "content": content}, "entrypoint": "cli",
            "cwd": cwd, "timestamp": ts}


def claude(*content, cwd=ALPHA, ts="2026-10-01T10:00:00Z"):
    return {"type": "assistant", "message": {"role": "assistant", "content": list(content)}, "cwd": cwd,
            "timestamp": ts}


def denial(tool_id, reason=None):
    text = ("The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a "
            "file edit, the new_string was NOT written to the file).")
    if reason:
        text += (" To tell you how to proceed, the user said:\n" + reason +
                 "\n\nNote: The user's next message may contain a correction or preference.")
    return blocks([{"type": "tool_result", "tool_use_id": tool_id, "content": text, "is_error": True}])


def edited(path, ts, result):
    """The tool result of an Edit or Write of `path`, as Claude Code records it."""
    record = blocks([{"type": "tool_result", "tool_use_id": "e", "content": "updated"}], ts=ts)
    return {**record, "toolUseResult": {"filePath": str(path), **result} if isinstance(result, dict) else result}


class DigestTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def session(self, slug, name, records):
        folder = self.config / "projects" / slug
        folder.mkdir(parents=True, exist_ok=True)
        with open(folder / f"{name}.jsonl", "w") as fh:
            fh.write(json.dumps({"type": "mode", "mode": "normal"}) + "\n")
            for record in records:
                fh.write(json.dumps(record) + "\n")

    def memory(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def run_digest(self, *argv, now=None):
        # The fixtures are dated, so a test reads all of them unless it sets a window of its own.
        if "--since" not in argv and now is None:
            argv = ("--since", "2000-01-01", *argv)
        out = self.config / "digest.md"
        with contextlib.redirect_stdout(io.StringIO()):
            digest.main(["--config-dir", str(self.config), "--out", str(out), *argv], now=now)
        return out.read_text()

    def fixture(self):
        self.session("-home-u-Projects-alpha", "s1", [
            human("Use uv for Python, never pip.", ts="2026-10-01T10:00:00Z"),
            claude({"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "pip install foo"}}),
            denial("t1", "use uv, not pip"),
            claude({"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": "git push --force"}}),
            denial("t2"),
            claude({"type": "text", "text": "I'll stop the game with pkill godot now."}),
            blocks([{"type": "text", "text": "[Request interrupted by user for tool use]"}]),
            human("never use pkill, it kills the shell", ts="2026-10-02T10:00:00Z"),
            claude({"type": "text", "text": "Opened the PR."}),
            human("Add a settings screen with a volume slider and a fullscreen toggle", ts="2026-10-02T11:00:00Z"),
            human("merge it", ts="2026-10-03T10:00:00Z"),
            human("Merge it.", ts="2026-10-04T10:00:00Z"),
            human("<command-message>code-review</command-message>\n<command-name>/code-review</command-name>"),
            human("<command-message>plugin-authoring</command-message>\n<command-name>/plugin-authoring</command-name>"
                  "\n<command-args>Is there skill guidance?</command-args>"),
            human('No, fix this crash <pasted_content id="p1">Traceback line one\nline two</pasted_content>'),
            human("Skill instructions the harness expanded", isMeta=True),
            human("Don't forget a message from before the cutoff", ts="2026-01-01T10:00:00Z"),
        ])
        self.session("-home-u-Projects-beta--claude-worktrees-x", "s2", [
            human("Use uv for Python, never pip", cwd=BETA + "/.claude/worktrees/x", ts="2026-10-05T10:00:00Z"),
        ])
        self.session("-tmp-probe", "s3", [human("What is 8+8? Answer in one word.", cwd="/tmp/probe")])
        self.session("-home-u-Projects-alpha", "s4", [
            {**human("Call the probe tool once"), "entrypoint": "sdk-ts"},
        ])
        self.memory(self.config / "memory" / "use-uv.md",
                    "---\nname: use-uv\ndescription: Use uv for Python\nmetadata:\n  type: feedback\n---\n\n"
                    "Run Python through uv.\n\n**Why:** said so.")
        self.memory(self.config / "memory" / "MEMORY.md", "- [use-uv](use-uv.md) — Use uv for Python\n")
        self.memory(self.config / "projects" / "-home-u-Projects-alpha" / "memory" / "renderer.md",
                    "---\nname: renderer\ndescription: Alpha draws with Vulkan\ntype: project\n---\n\nVulkan only.")

    def test_keeps_corrections_and_drops_one_offs_tool_output_and_meta(self):
        self.fixture()
        text = self.run_digest()
        self.assertIn("never use pkill, it kills the shell", text)
        # A one-off task isn't evidence of a rule.
        self.assertNotIn("Add a settings screen with a volume slider", text)
        self.assertNotIn("Skill instructions the harness expanded", text)
        self.assertNotIn("Request interrupted", text)

    def test_refusals_carry_the_tool_and_the_reason(self):
        self.fixture()
        text = self.run_digest()
        self.assertIn('Bash `pip install foo` — "use uv, not pip"', text)
        self.assertIn("Bash `git push --force`", text)
        self.assertIn("## Refusals without a reason (1)", text)

    def test_message_after_an_interrupt_is_a_correction_with_claudes_last_words(self):
        self.fixture()
        text = self.run_digest()
        corrections = text.split("## Likely corrections")[1].split("\n## ")[0]
        self.assertIn("never use pkill, it kills the shell", corrections)
        self.assertIn("after interrupt", corrections)
        self.assertIn("I'll stop the game with pkill godot now.", corrections)

    def test_message_repeated_in_two_projects_is_grouped(self):
        self.fixture()
        text = self.run_digest()
        repeated = text.split("## Said more than once")[1].split("\n## ")[0]
        self.assertIn("Use uv for Python, never pip", repeated)
        self.assertIn("×2 in 2 projects", repeated)
        self.assertIn("/home/u/Projects/beta", repeated)
        self.assertNotIn("worktrees", repeated)

    def test_short_replies_and_bare_commands_are_not_rules(self):
        self.fixture()
        text = self.run_digest()
        self.assertNotIn("merge it", text.lower())
        self.assertNotIn("/code-review", text)
        self.assertNotIn("Short replies", text)

    def test_the_same_thing_said_twice_in_one_project_is_grouped(self):
        self.session("-home-u-Projects-alpha", "s1", [human("Keep the changelog in plain English", ts="2026-10-01T10:00:00Z")])
        self.session("-home-u-Projects-alpha", "s2", [human("keep the changelog in plain English.", ts="2026-10-03T10:00:00Z")])
        repeated = self.run_digest().split("## Said more than once (1)")[1]
        self.assertIn("×2 in 1 project (/home/u/Projects/alpha), last 2026-10-03", repeated)

    def test_pasted_text_is_replaced_by_its_size(self):
        self.fixture()
        text = self.run_digest()
        self.assertIn("No, fix this crash [pasted 27 chars]", text)
        self.assertNotIn("Traceback", text)

    def test_paste_whose_closing_tag_carries_its_id_is_replaced(self):
        self.session("-home-u-Projects-alpha", "s1", [
            human('No, see <pasted_content id="f17d">secret log\n</pasted_content id="f17d">\n')])
        text = self.run_digest()
        self.assertIn("No, see [pasted 10 chars]", text)
        self.assertNotIn("secret log", text)

    def test_a_resumed_session_does_not_count_its_copied_messages_again(self):
        first = {**human("No, keep replies short and lead with the outcome"), "uuid": "u1"}
        refused = claude({"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "rm -rf build"}})
        records = [first, refused, denial("t1", "keep the build folder")]
        self.session("-home-u-Projects-alpha", "s1", records)
        self.session("-home-u-Projects-alpha", "s2", records + [human("Now add the export button")])
        text = self.run_digest()
        self.assertEqual(text.count("keep replies short and lead with the outcome"), 1)
        self.assertEqual(text.count("keep the build folder"), 1)
        # The copy isn't the user saying it twice.
        self.assertIn("## Said more than once (0)", text)

    def test_punctuation_only_replies_are_dropped(self):
        self.session("-home-u-Projects-alpha", "s1", [human("."), human("."), human("!!"), human("!!")])
        text = self.run_digest()
        self.assertIn("0 typed messages", text)
        self.assertIn("## Said more than once (0)", text)

    def test_scripted_and_tmp_sessions_are_skipped_unless_asked(self):
        self.fixture()
        text = self.run_digest()
        self.assertNotIn("What is 8+8", text)
        self.assertNotIn("Call the probe tool once", text)
        self.assertIn("Skipped 2 messages from scripted or /tmp sessions", text)
        kept = self.run_digest("--include-tests")
        self.assertNotIn("Skipped", kept)
        typed = lambda t: int(t.split(" typed messages")[0].rsplit(" ", 1)[1])  # noqa: E731
        self.assertEqual(typed(kept), typed(text) + 2)

    def test_skipped_count_leaves_out_messages_before_since(self):
        self.session("-tmp-probe", "s1", [human("What is 8+8? Answer in one word.", cwd="/tmp/probe",
                                                ts="2026-01-01T10:00:00Z")])
        # --include-tests does not bring it back: it is before the cutoff.
        self.assertNotIn("What is 8+8", self.run_digest("--since", "2026-06-01", "--include-tests"))
        self.assertNotIn("Skipped 1 messages", self.run_digest("--since", "2026-06-01"))

    def test_skipped_count_counts_a_resumed_sessions_copied_messages_once(self):
        probe = {**human("What is 8+8? Answer in one word.", cwd="/tmp/probe"), "uuid": "u1"}
        self.session("-tmp-probe", "s1", [probe])
        self.session("-tmp-probe", "s2", [probe, human("And 9+9?", cwd="/tmp/probe")])
        self.assertIn("Skipped 2 messages", self.run_digest())

    def test_since_drops_older_messages(self):
        self.fixture()
        self.assertIn("forget a message from before the cutoff", self.run_digest())
        self.assertNotIn("forget a message from before the cutoff", self.run_digest("--since", "2026-06-01"))

    def test_memories_are_listed_with_their_type(self):
        self.fixture()
        text = self.run_digest()
        self.assertIn("### use-uv (feedback)", text)
        self.assertIn("Run Python through uv.", text)
        self.assertIn("### /home/u/Projects/alpha · renderer (project)", text)
        self.assertNotIn("MEMORY.md", text)

    def test_reads_a_memory_file_as_global_memory_writes_it(self):
        # global-memory's own test checks its hooks/memory.ts still writes this sample.
        sample = shared_sample()
        path = self.config / "memory" / f"{sample['entry']['name']}.md"
        self.memory(path, sample["file"])
        memory = digest.read_memory(path, "global")
        entry = sample["entry"]
        self.assertEqual(
            (memory.name, memory.type, memory.description, memory.body),
            (entry["name"], entry["type"], entry["description"], entry["body"].strip()),
        )

    def test_an_unquoted_description_ending_in_a_quoted_word_keeps_its_closing_quote(self):
        path = self.config / "memory" / "close-means-merge.md"
        self.memory(path, '---\nname: close-means-merge\ndescription: Say "merge" when told "close"\n'
                          'type: feedback\n---\n\nMerge the PR.\n')
        memory = digest.read_memory(path, "global")
        self.assertEqual(memory.description, 'Say "merge" when told "close"')
        self.assertEqual(digest.front_matter_value('"merge" means merge'), '"merge" means merge')
        self.assertEqual(digest.front_matter_value('"merge" or "close"'), '"merge" or "close"')

    def test_a_quoted_front_matter_value_loses_the_quotes_around_it(self):
        self.assertEqual(digest.front_matter_value("'Use uv for Python'"), "Use uv for Python")
        # Not JSON (\U is no JSON escape), but still quoted.
        self.assertEqual(digest.front_matter_value('"C:\\Users"'), "C:\\Users")

    def test_header_reports_whether_claude_md_exists(self):
        self.fixture()
        self.assertIn("does not exist", self.run_digest())
        (self.config / "CLAUDE.md").write_text("# About me\n- Solo developer.\n")
        self.assertIn("2 lines", self.run_digest())

    def claude_md_history(self, current):
        path = self.config / "CLAUDE.md"
        first = "# Git\n- Rebase-merge.\n"
        self.session("-home-u-Projects-alpha", "s1", [
            edited(path, "2026-09-20T08:00:00Z", {"type": "update", "originalFile": first,
                                                   "content": first + "- Stage by name.\n"}),
            edited(path, "2026-10-01T09:30:00Z", {"originalFile": first + "- Stage by name.\n",
                                                   "oldString": "- Rebase-merge.", "newString": "- Fast-forward.",
                                                   "replaceAll": False}),
            # A refused edit leaves a string, not the file, and changed nothing.
            edited(path, "2026-10-02T10:00:00Z", "User rejected tool use"),
            human("never squash", ts="2026-10-02T11:15:00Z"),
        ])
        path.write_text(current)
        stamp = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc).timestamp()
        os.utime(path, (stamp, stamp))

    def claude_md_lines(self, *argv):
        return self.run_digest(*argv).split("## When each global CLAUDE.md line was put in place")[1].split("\n## ")[0]

    def test_claude_md_lines_are_timed_by_the_edit_that_wrote_them(self):
        self.claude_md_history("# Git\n- Fast-forward.\n- Stage by name.\n")
        lines = self.claude_md_lines()
        self.assertIn("- 2 · since 2026-10-01 09:30 · - Fast-forward.", lines)
        self.assertIn("- 3 · since 2026-09-20 08:00 · - Stage by name.", lines)

    def test_a_line_there_before_the_first_recorded_edit_is_timed_at_the_latest(self):
        self.claude_md_history("# Git\n- Fast-forward.\n- Stage by name.\n")
        self.assertIn("- 1 · by 2026-09-20 08:00 · # Git", self.claude_md_lines())

    def test_a_line_changed_by_hand_is_timed_by_the_files_last_change(self):
        self.claude_md_history("# Git\n- Fast-forward.\n- Never squash.\n")
        text = self.run_digest()
        self.assertIn("- 3 · by 2026-10-03 12:00 · - Never squash.", text)
        self.assertIn("last changed 2026-10-03 12:00 UTC", text)

    def test_a_line_added_by_hand_between_two_edits_is_timed_by_not_since(self):
        path = self.config / "CLAUDE.md"
        first = "# Git\n- Rebase-merge.\n"
        self.session("-home-u-Projects-alpha", "s1", [
            edited(path, "2026-09-20T08:00:00Z", {"type": "update", "originalFile": first,
                                                   "content": first + "- Stage by name.\n"}),
            # The user added "- Never squash." by hand; this edit found it already there.
            edited(path, "2026-10-01T09:30:00Z", {"originalFile": first + "- Stage by name.\n- Never squash.\n",
                                                   "oldString": "- Rebase-merge.", "newString": "- Fast-forward.",
                                                   "replaceAll": False}),
        ])
        path.write_text("# Git\n- Fast-forward.\n- Stage by name.\n- Never squash.\n")
        lines = self.claude_md_lines()
        self.assertIn("- 4 · by 2026-10-01 09:30 · - Never squash.", lines)
        # The line that edit did write keeps its since.
        self.assertIn("- 2 · since 2026-10-01 09:30 · - Fast-forward.", lines)

    def test_since_does_not_hide_the_edits_that_wrote_a_line(self):
        self.claude_md_history("# Git\n- Fast-forward.\n- Stage by name.\n")
        self.assertIn("since 2026-10-01 09:30 · - Fast-forward.", self.claude_md_lines("--since", "2026-10-02"))

    def test_claude_md_with_no_recorded_edits_is_timed_by_its_last_change(self):
        (self.config / "CLAUDE.md").write_text("# Git\n- Fast-forward.\n")
        stamp = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc).timestamp()
        os.utime(self.config / "CLAUDE.md", (stamp, stamp))
        self.assertIn("No edits to it in the transcripts; every line was in place by 2026-10-03 12:00.",
                      self.claude_md_lines())

    def test_corrections_and_refusals_carry_the_time_of_day(self):
        self.fixture()
        text = self.run_digest()
        self.assertIn("- 2026-10-02 10:00 · /home/u/Projects/alpha · after interrupt", text)
        self.assertIn("- 2026-10-01 10:00 · /home/u/Projects/alpha · Bash `git push --force`", text)

    def test_long_messages_are_cut(self):
        self.session("-home-u-Projects-alpha", "s1", [human("No, " + "word " * 400)])
        text = self.run_digest("--max-chars", "100")
        self.assertIn("…[+", text)
        self.assertNotIn("word " * 30, text)

    def test_cli_prints_where_it_wrote(self):
        self.fixture()
        out = self.config / "nested" / "digest.md"
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), "--config-dir", str(self.config), "--out", str(out)],
                                capture_output=True, text=True, check=True)
        self.assertIn(f"Wrote {out}", result.stdout)
        self.assertTrue(out.exists())

    def test_digest_goes_in_its_own_folder_by_default(self):
        self.fixture()
        subprocess.run([sys.executable, "-I", str(SCRIPT), "--config-dir", str(self.config)],
                       capture_output=True, text=True, check=True)
        self.assertTrue((self.config / "global-rules" / "digest.md").exists())
        # memory_files() reads every .md in memory/, so the digest must never land there.
        self.assertFalse((self.config / "memory" / "digest.md").exists())

    def test_since_accepts_a_day_count_and_rejects_nonsense(self):
        self.assertEqual(digest.parse_since("2026-06-01"), "2026-06-01")
        self.assertRegex(digest.parse_since("30d"), r"^\d{4}-\d{2}-\d{2}$")
        with self.assertRaises(ValueError):
            digest.parse_since("last week")



NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)


class WindowTest(unittest.TestCase):
    """Each run reads only what came after the last one, so a declined item isn't proposed again
    from the same evidence."""

    setUp, tearDown = DigestTest.setUp, DigestTest.tearDown
    session, memory, run_digest = DigestTest.session, DigestTest.memory, DigestTest.run_digest

    def correction(self, text, ts):
        return human(text, ts=ts, uuid=text)

    def old_memory(self, name, when):
        path = self.config / "memory" / f"{name}.md"
        self.memory(path, f"---\nname: {name}\ndescription: {name}\ntype: feedback\n---\n\nBody.")
        stamp = when.timestamp()
        os.utime(path, (stamp, stamp))

    def test_a_first_run_reads_the_last_30_days_and_every_memory(self):
        self.session("-home-u-Projects-alpha", "s1", [
            self.correction("No, the old one from September", "2026-09-01T10:00:00Z"),
            self.correction("No, the new one from November", "2026-11-01T10:00:00Z"),
        ])
        self.old_memory("ancient", datetime(2026, 1, 1, tzinfo=timezone.utc))
        text = self.run_digest(now=NOW)
        self.assertIn("First run: history from the last 30 days, since 2026-10-13 12:00 UTC", text)
        self.assertIn("the new one from November", text)
        self.assertNotIn("the old one from September", text)
        self.assertIn("### ancient (feedback)", text)
        self.assertEqual((self.config / "global-rules" / "last-run").read_text(), "2026-11-12 12:00:00\n")

    def test_a_later_run_reads_only_what_came_after_the_last_one(self):
        (self.config / "global-rules").mkdir(parents=True)
        (self.config / "global-rules" / "last-run").write_text("2026-11-05 09:30\n")
        self.session("-home-u-Projects-alpha", "s1", [
            self.correction("No, seen in the last run", "2026-11-05T09:29:00Z"),
            self.correction("No, new since the last run", "2026-11-05T09:30:00Z"),
        ])
        self.old_memory("seen-before", datetime(2026, 11, 1, tzinfo=timezone.utc))
        self.old_memory("written-since", datetime(2026, 11, 6, tzinfo=timezone.utc))
        text = self.run_digest(now=NOW)
        self.assertIn("History and memories since the last run, 2026-11-05 09:30 UTC.", text)
        self.assertIn("new since the last run", text)
        self.assertNotIn("seen in the last run", text)
        self.assertIn("### written-since (feedback)", text)
        self.assertNotIn("seen-before", text)

    def test_since_reads_further_back_and_still_moves_the_last_run(self):
        (self.config / "global-rules").mkdir(parents=True)
        (self.config / "global-rules" / "last-run").write_text("2026-11-05 09:30\n")
        self.session("-home-u-Projects-alpha", "s1", [self.correction("No, from October", "2026-10-20T10:00:00Z")])
        text = self.run_digest("--since", "2026-10-01", now=NOW)
        self.assertIn("History and memories from 2026-10-01 on (--since).", text)
        self.assertIn("from October", text)
        self.assertEqual((self.config / "global-rules" / "last-run").read_text(), "2026-11-12 12:00:00\n")

    def test_what_came_in_the_same_minute_as_the_last_run_is_read_once(self):
        # A correction typed just before running suggest was in that run, not the next.
        (self.config / "global-rules").mkdir(parents=True)
        (self.config / "global-rules" / "last-run").write_text("2026-11-05 09:30:40\n")
        self.session("-home-u-Projects-alpha", "s1", [
            self.correction("No, typed just before the run", "2026-11-05T09:30:10Z"),
            self.correction("No, typed just after the run", "2026-11-05T09:30:50Z"),
        ])
        self.old_memory("saved-just-before", datetime(2026, 11, 5, 9, 30, 20, tzinfo=timezone.utc))
        text = self.run_digest(now=NOW)
        self.assertNotIn("typed just before the run", text)
        self.assertIn("typed just after the run", text)
        self.assertNotIn("saved-just-before", text)

    def test_an_unreadable_last_run_counts_as_a_first_run(self):
        (self.config / "global-rules").mkdir(parents=True)
        (self.config / "global-rules" / "last-run").write_text("yesterday\n")
        self.assertIn("First run:", self.run_digest(now=NOW))

if __name__ == "__main__":
    unittest.main()
