import json
import re
import sys
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
SKILL = PLUGIN / "skills" / "hunt" / "SKILL.md"
HUNTER = PLUGIN / "agents" / "hunter.md"
README = PLUGIN / "README.md"
sys.path.insert(0, str(SKILL.parent / "scripts"))
import inventory


def split(path):
    _, front, body = path.read_text().split("---\n", 2)
    fields = {}
    for line in front.splitlines():
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip()
    return fields, body


class SkillTest(unittest.TestCase):
    def setUp(self):
        self.front, self.body = split(SKILL)
        self.allowed = self.front["allowed-tools"]
        self.hunter_front, self.hunter_body = split(HUNTER)

    def section(self, start, end=None):
        begin = self.body.index(start)
        return (
            self.body[begin : self.body.index(end, begin)] if end else self.body[begin:]
        )

    def test_the_description_fits_the_skill_listing(self):
        # Claude Code cuts a skill's description at 1,536 characters in the listing.
        self.assertLess(len(self.front["description"]), 1536)
        self.assertEqual(self.front["name"], SKILL.parent.name)

    def test_every_git_and_gh_command_it_runs_is_pre_approved(self):
        # An unapproved command stops the skill for a permission prompt, or fails under -p.
        runs = set(re.findall(r"`(git [a-z-]+)", self.body)) | set(
            re.findall(r"^(git [a-z-]+)", self.body, re.MULTILINE)
        )
        runs |= set(re.findall(r"`(gh [a-z]+ [a-z]+)", self.body))
        forbidden = {
            "git checkout",
            "git restore",
            "git reset",
            "git stash",
            "git clean",
        }
        self.assertEqual(
            runs - forbidden,
            {
                "git rev-parse",
                "git status",
                "git branch",
                "git ls-files",
                "git merge-base",
                "gh pr view",
            },
        )
        for command in runs - forbidden:
            self.assertIn(f"Bash({command} *)", self.allowed)

    def test_commands_that_lose_uncommitted_work_are_named_only_to_forbid_them(self):
        for command in ("checkout", "restore", "reset", "stash", "clean"):
            self.assertNotIn(f"git {command}", self.allowed)
            mentions = [
                line for line in self.body.splitlines() if f"git {command}" in line
            ]
            self.assertEqual(len(mentions), 1, command)
            self.assertIn("Never run", mentions[0])

    def test_the_map_script_is_pre_approved_with_and_without_paths(self):
        run = "python3 ${CLAUDE_SKILL_DIR}/scripts/inventory.py"
        self.assertIn(run, self.body)
        self.assertIn(f"Bash({run})", self.allowed)
        self.assertIn(f"Bash({run} *)", self.allowed)
        self.assertTrue((SKILL.parent / "scripts" / "inventory.py").is_file())

    def test_the_hunter_it_sends_is_the_plugins_own_agent(self):
        manifest = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text())
        agent = f"{manifest['name']}:{self.hunter_front['name']}"
        self.assertEqual(agent, "bug-hunt:hunter")
        self.assertIn(f"`{agent}`", self.section("## 3. Hunt", "## 4."))

    def test_hunters_can_only_read(self):
        # Hunters run side by side in the user's working tree: one that wrote a file could break
        # another's reading or the user's work, and Bash would bring permission prompts.
        tools = {t.strip() for t in self.hunter_front["tools"].split(",")}
        self.assertEqual(tools, {"Read", "Grep", "Glob"})

    def test_the_skill_reads_the_sections_the_hunter_reports(self):
        for heading in ("Findings", "Checked", "Not read"):
            self.assertIn(f"## {heading}", self.hunter_body)
        self.assertIn("Checked and Not read", self.section("## 3. Hunt", "## 4."))
        self.assertIn("- Repro:", self.hunter_body)

    def test_hunters_are_capped_well_under_the_subagent_limit(self):
        self.assertIn("at most 6 at a time", self.body)
        self.assertIn("at most 6 at a time", README.read_text())

    def test_the_component_size_matches_the_scripts_budget(self):
        budget = f"{inventory.DEFAULT_BUDGET:,}"
        self.assertIn(f"at most {budget} lines", self.section("## 2. Map", "## 3."))
        self.assertIn(f"under about {budget} lines", self.body)

    def test_confirming_waits_for_every_hunter(self):
        # A repro added while hunters still read could be taken for part of the code.
        self.assertIn(
            "Don't start confirming before then", self.section("## 3. Hunt", "## 4.")
        )

    def test_changes_go_to_code_review_with_a_fallback_the_user_can_run(self):
        review = self.section("## 4. Review a change", "## 5.")
        self.assertIn("skill `code-review`", review)
        self.assertIn("Don't send hunters at the change as well", review)
        self.assertIn(
            "run `/code-review TARGET` and then `/bug-hunt:hunt confirm`", review
        )
        self.assertIn("the working tree, so it has to hold the change", review)

    def test_a_finding_is_confirmed_only_by_a_repro_failing_for_its_reason(self):
        confirm = self.section("## 5. Confirm", "## 6.")
        self.assertIn("fails the way the finding says", confirm)
        self.assertIn("is not a confirmation", confirm)
        self.assertIn("check it matches the baseline", confirm)
        for outcome in ("**Confirmed:**", "**Ruled out:**", "**Suspected:**"):
            self.assertIn(outcome, confirm)

    def test_cleanup_is_checked_outside_a_git_repo_too(self):
        # The check after each repro relied on git status, which fails in a folder without git,
        # and the skill hunts such folders.
        confirm = self.section("## 5. Confirm", "## 6.")
        self.assertIn(
            "Outside a git repo, keep a list of the files you add or change", confirm
        )

    def test_confirmed_needs_a_real_input_and_a_written_expectation(self):
        # On a large repo, repros on hand-made input the program may never produce, and
        # expectations nobody wrote down, were marked confirmed with the gap noted beside them.
        confirm = self.section("## 5. Confirm", "## 6.")
        self.assertIn(
            "an input the program can really receive through one of its entry points",
            confirm,
        )
        self.assertIn("an expectation its docs, tests or callers state", confirm)
        self.assertIn("stays suspected, saying what's left to check", confirm)

    def test_claude_passes_a_target_when_it_starts_a_hunt_itself(self):
        # With no arguments it hunts the whole codebase, which costs far more than a change.
        self.assertIn(
            "When starting it yourself after a change, pass `diff`",
            self.front["description"],
        )

    def test_the_run_file_is_kept_on_a_short_run_too(self):
        # With compaction as its only reason, runs that confirmed a few findings skipped the run
        # file, and their repros were lost when the temp folder was deleted.
        self.assertIn("The run file holds the state, however short the run.", self.body)
        self.assertIn("the only place its code survives", self.body)

    def test_the_run_folder_ignores_itself(self):
        self.assertIn(
            "If `.bug-hunt/.gitignore` doesn't exist, create it holding the single line `*`",
            self.body,
        )

    def test_the_run_file_has_one_layout_with_the_sections_the_steps_fill(self):
        # Runs left to choose their own layout wrote it differently each time, one with an empty
        # Coverage section; a fixed layout is what a run reads back after a compaction.
        layout = re.search(
            r"^````markdown\n(.*?)^````$", self.body, re.MULTILINE | re.DOTALL
        ).group(1)
        for heading in ("## Map", "## Findings", "## Coverage"):
            self.assertIn(heading, layout)
        self.assertIn(
            "(suspected | confirmed | ruled out; critical | major | minor)", layout
        )
        self.assertIn("| Component | Files | Lines | Risk | Status |", layout)
        self.assertIn(
            "as a numbered table: component, files, lines, risk, status", self.body
        )

    def test_the_report_names_what_was_not_hunted(self):
        report = self.section("## 6. Report")
        self.assertIn("Code that wasn't hunted wasn't checked", report)

    def test_the_argument_hint_names_every_kind_of_target(self):
        hint = self.front["argument-hint"]
        for target in (
            "whole codebase",
            "paths",
            "area",
            "symptom",
            "diff",
            "PR",
            "branch",
            "confirm",
        ):
            self.assertIn(target, hint)


if __name__ == "__main__":
    unittest.main()
