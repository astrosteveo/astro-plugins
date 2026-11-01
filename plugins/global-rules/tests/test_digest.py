import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "skills" / "suggest" / "scripts" / "digest.py"
sys.path.insert(0, str(SCRIPT.parent))
import digest  # noqa: E402

ALPHA = "/home/u/Projects/alpha"
BETA = "/home/u/Projects/beta"


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

    def run_digest(self, *argv):
        out = self.config / "digest.md"
        with contextlib.redirect_stdout(io.StringIO()):
            digest.main(["--config-dir", str(self.config), "--out", str(out), *argv])
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
            human('Fix this crash <pasted_content id="p1">Traceback line one\nline two</pasted_content>'),
            human("Skill instructions the harness expanded", isMeta=True),
            human("A message from before the cutoff", ts="2026-01-01T10:00:00Z"),
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

    def test_keeps_typed_messages_and_drops_tool_output_and_meta(self):
        self.fixture()
        text = self.run_digest()
        self.assertIn("Add a settings screen with a volume slider", text)
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
        repeated = text.split("## Said in more than one project")[1].split("\n## ")[0]
        self.assertIn("Use uv for Python, never pip", repeated)
        self.assertIn("×2 in 2 projects", repeated)
        self.assertIn("/home/u/Projects/beta", repeated)
        self.assertNotIn("worktrees", repeated)

    def test_short_replies_and_bare_commands_are_tallied(self):
        self.fixture()
        text = self.run_digest()
        tallies = text.split("## Short replies and commands")[1]
        self.assertIn("merge it ×2", tallies)
        self.assertIn("/code-review ×1", tallies)
        self.assertIn("/plugin-authoring Is there skill guidance?", text)

    def test_pasted_text_is_replaced_by_its_size(self):
        self.fixture()
        text = self.run_digest()
        self.assertIn("Fix this crash [pasted 27 chars]", text)
        self.assertNotIn("Traceback", text)

    def test_paste_whose_closing_tag_carries_its_id_is_replaced(self):
        self.session("-home-u-Projects-alpha", "s1", [
            human('See <pasted_content id="f17d">secret log\n</pasted_content id="f17d">\n')])
        text = self.run_digest()
        self.assertIn("See [pasted 10 chars]", text)
        self.assertNotIn("secret log", text)

    def test_a_resumed_session_does_not_count_its_copied_messages_again(self):
        first = {**human("Keep replies short and lead with the outcome"), "uuid": "u1"}
        refused = claude({"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "rm -rf build"}})
        records = [first, refused, denial("t1", "keep the build folder")]
        self.session("-home-u-Projects-alpha", "s1", records)
        self.session("-home-u-Projects-alpha", "s2", records + [human("Now add the export button")])
        text = self.run_digest()
        self.assertEqual(text.count("Keep replies short and lead with the outcome"), 1)
        self.assertEqual(text.count("keep the build folder"), 1)
        self.assertIn("Now add the export button", text)

    def test_punctuation_only_replies_are_dropped(self):
        self.session("-home-u-Projects-alpha", "s1", [human("."), human("!!"), human("ok")])
        tallies = self.run_digest().split("## Short replies and commands")[1]
        self.assertIn("Short replies: ok ×1\n", tallies)

    def test_scripted_and_tmp_sessions_are_skipped_unless_asked(self):
        self.fixture()
        text = self.run_digest()
        self.assertNotIn("What is 8+8", text)
        self.assertNotIn("Call the probe tool once", text)
        self.assertIn("Skipped 2 messages from scripted or /tmp sessions", text)
        text = self.run_digest("--include-tests")
        self.assertIn("What is 8+8", text)
        self.assertIn("Call the probe tool once", text)

    def test_since_drops_older_messages(self):
        self.fixture()
        self.assertIn("A message from before the cutoff", self.run_digest())
        self.assertNotIn("A message from before the cutoff", self.run_digest("--since", "2026-06-01"))

    def test_memories_are_listed_with_their_type(self):
        self.fixture()
        text = self.run_digest()
        self.assertIn("### use-uv (feedback)", text)
        self.assertIn("Run Python through uv.", text)
        self.assertIn("### /home/u/Projects/alpha · renderer (project)", text)
        self.assertNotIn("MEMORY.md", text)

    def test_header_reports_whether_claude_md_exists(self):
        self.fixture()
        self.assertIn("does not exist", self.run_digest())
        (self.config / "CLAUDE.md").write_text("# About me\n- Solo developer.\n")
        self.assertIn("2 lines", self.run_digest())

    def test_long_messages_are_cut(self):
        self.session("-home-u-Projects-alpha", "s1", [human("word " * 400)])
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

    def test_since_accepts_a_day_count_and_rejects_nonsense(self):
        self.assertEqual(digest.parse_since("2026-06-01"), "2026-06-01")
        self.assertRegex(digest.parse_since("30d"), r"^\d{4}-\d{2}-\d{2}$")
        with self.assertRaises(ValueError):
            digest.parse_since("last week")


if __name__ == "__main__":
    unittest.main()
