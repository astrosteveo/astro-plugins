"""Tests for scripts/ledger.py, against throwaway git repos. Run: python3 -m unittest discover -s tests"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEDGER = os.path.join(os.path.dirname(HERE), "scripts", "ledger.py")
spec = importlib.util.spec_from_file_location("ledger", LEDGER)
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)

GIT_ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


class Repo:
    def __init__(self, path, bare_origin=None):
        self.path = path
        os.makedirs(path, exist_ok=True)
        if bare_origin:
            self.git("clone", "-q", bare_origin, ".")
        else:
            self.git("init", "-q", "-b", "main")

    def git(self, *args, check=True):
        r = subprocess.run(["git", *args], cwd=self.path, capture_output=True, text=True, env=GIT_ENV)
        if check and r.returncode:
            raise AssertionError(f"git {args} failed: {r.stderr}")
        return r.stdout.strip()

    def write(self, rel, text):
        full = os.path.join(self.path, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(text)

    def commit(self, msg, *paths):
        self.git("add", "-A", *paths)
        self.git("commit", "-q", "-m", msg)
        return self.git("rev-parse", "HEAD")

    def run(self, *args, input=None, ok=True):
        r = subprocess.run([sys.executable, LEDGER, *args], cwd=self.path, capture_output=True, text=True,
                           input=input, env=GIT_ENV)
        if ok and r.returncode:
            raise AssertionError(f"ledger {args} exited {r.returncode}: {r.stdout}{r.stderr}")
        return r

    def json(self, *args):
        return json.loads(self.run(*args).stdout)

    def record(self, findings=(), **extra):
        os.makedirs(os.path.join(self.path, ".solo-review"), exist_ok=True)
        self.write(".solo-review/record.json", json.dumps({"findings": list(findings), **extra}))
        return self.run("record", "--file", ".solo-review/record.json").stdout

    def events(self):
        path = os.path.join(self.path, ".git", "solo-review", "ledger.jsonl")
        with open(path) as f:
            return [json.loads(l) for l in f if l.strip()]


IMPORTANT = {"file": "app.py", "line": 2, "severity": "important", "category": "logic", "title": "off by one",
             "evidence": None, "fix": None, "verified": None}


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="solo-review-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def new_repo(self, name="repo"):
        r = Repo(os.path.join(self.tmp, name))
        r.write("app.py", "def f(xs):\n    return xs[0]\n")
        r.commit("init")
        return r

    def with_origin(self):
        bare = os.path.join(self.tmp, "origin.git")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", bare], check=True, env=GIT_ENV)
        seed = Repo(os.path.join(self.tmp, "seed"))
        seed.write("app.py", "def f(xs):\n    return xs[0]\n")
        seed.commit("init")
        seed.git("remote", "add", "origin", bare)
        seed.git("push", "-q", "origin", "main")
        repo = Repo(os.path.join(self.tmp, "repo"), bare_origin=bare)
        return repo, seed


class GlobAndTierTest(unittest.TestCase):
    def test_one_glob_dialect(self):
        m = ledger.matches
        self.assertTrue(m("a.snap", ["*.snap"]))
        self.assertFalse(m("x/a.snap", ["*.snap"]))  # `*` stays in its segment, as in git's glob magic
        self.assertTrue(m("x/y/a.snap", ["**/*.snap"]))
        self.assertTrue(m("a.snap", ["**/*.snap"]))
        self.assertTrue(m("dist/a/b.js", ["dist/**"]))
        self.assertTrue(m("dist", ["dist/**"]))  # a symlinked folder is recorded as the bare path
        self.assertFalse(m("docs/a/b.md", ["docs/*"]))
        self.assertTrue(m("SRC/Auth/x.py", ["src/auth/**"]))  # case is ignored
        self.assertTrue(m("a1.txt", ["a[0-9].txt"]))
        self.assertFalse(m("ab.txt", ["a[!b].txt"]))

    def test_tier(self):
        cfg = {**ledger.DEFAULTS, "high": ["src/billing/**"]}
        self.assertEqual(ledger.risk_tier(["README.md", "docs/x.md"], cfg), "low")
        self.assertEqual(ledger.risk_tier(["src/app.py", "README.md"], cfg), "medium")
        self.assertEqual(ledger.risk_tier(["package.json"], cfg), "high")
        self.assertEqual(ledger.risk_tier(["src/billing/charge.py"], cfg), "high")
        self.assertEqual(ledger.risk_tier(["docs/link.md"], cfg, symlinks={"docs/link.md"}), "high")

    def test_norm_id(self):
        self.assertEqual(ledger.norm_id("f-12"), "F-12")
        self.assertEqual(ledger.norm_id("12"), "F-12")
        self.assertEqual(ledger.norm_id("F12"), "F-12")
        self.assertIsNone(ledger.norm_id("E-3"))
        self.assertIsNone(ledger.norm_id("-12"))
        self.assertEqual(ledger.norm_id("e-3", "E"), "E-3")

    def test_checklist_sections(self):
        text = ("# Review guide\n## What Important means here\n<!-- - example -->\n- A save loses data\n"
                "  without an error\n## Always check:\n1. Exit codes\n## Do not report\n- Style\n")
        self.assertEqual(ledger.review_checklist(text), ["A save loses data without an error", "Exit codes"])


class ScopeTest(TempDirCase):
    def test_scope_record_and_open(self):
        r = self.new_repo()
        r.write("app.py", "def f(xs):\n    return xs[1]\n")
        scope = r.json("scope")
        self.assertEqual((scope["round"], scope["depth"], scope["files"]), (1, "quick", ["app.py"]))
        self.assertEqual(scope["label"], "uncommitted changes")
        out = r.record([IMPORTANT], candidates=2, check="passed: 3 tests")
        self.assertIn("1 finding (1 important)", out)
        self.assertFalse(os.path.exists(os.path.join(r.path, ".solo-review")))  # handoff file and folder are gone
        finding = [e for e in r.events() if e["type"] == "finding"][0]
        self.assertEqual((finding["id"], finding["evidence"], finding["verified"]), ("F-1", "", ""))
        self.assertIn("F-1", r.run("open").stdout)
        self.assertEqual(r.git("status", "--porcelain"), "M app.py")  # nothing of ours shows up in git

    def test_record_needs_a_handoff_file_in_scratch(self):
        r = self.new_repo()
        r.write("app.py", "x = 1\n")
        r.run("scope")
        r.write("elsewhere.json", "{}")
        bad = r.run("record", "--file", "elsewhere.json", ok=False)
        self.assertNotEqual(bad.returncode, 0)
        self.assertTrue(os.path.exists(os.path.join(r.path, "elsewhere.json")))  # never deleted

    def test_cycle_on_main_without_remote_with_committed_fixes(self):
        """v1 bug: on a default branch with no remote the base was HEAD, so each fix commit started a new cycle."""
        r = self.new_repo()
        r.write("app.py", "def f(xs):\n    return xs[1]\n")
        r.commit("change")  # nothing uncommitted: the change is the last commit, reviewed with --base
        self.assertEqual(r.json("scope", "--base", "HEAD~1")["round"], 1)
        r.record([IMPORTANT])
        for n in (2, 3):
            r.write("app.py", f"def f(xs):\n    return xs[{n}]\n")
            sha = r.commit(f"Fix review finding F-{n - 1}")
            r.run("resolve", f"F-{n - 1}", "--as", "fixed", "--by", "agent", "--commit", sha)
            scope = r.json("scope")
            self.assertEqual((scope["round"], scope["incremental"]), (n, True))
            r.record([{**IMPORTANT, "title": f"still off by one {n}"}])
        r.write("app.py", "def f(xs):\n    return xs[4]\n")
        sha = r.commit("Fix review finding F-3")
        r.run("resolve", "F-3", "--as", "fixed", "--by", "agent", "--commit", sha)
        stop = r.json("scope")
        self.assertTrue(stop["stop"])
        self.assertIn("round cap", stop["summary"])
        self.assertEqual(r.json("scope", "--force")["round"], 4)

    def test_uncommitted_fix_continues_the_cycle_and_other_edits_start_a_new_one(self):
        r = self.new_repo()
        r.write("app.py", "def f(xs):\n    return xs[1]\n")
        r.run("scope")
        r.record([IMPORTANT])
        r.write("app.py", "def f(xs):\n    return xs[0] if xs else None\n")
        r.run("resolve", "F-1", "--as", "fixed", "--by", "agent")
        scope = r.json("scope")
        self.assertEqual((scope["round"], scope["incremental"], scope["open_to_recheck"]), (2, True, []))
        r.record([{**IMPORTANT, "title": "another"}])
        r.write("other.py", "y = 2\n")  # new work, not a recorded fix
        self.assertEqual(r.json("scope")["round"], 1)

    def test_nits_do_not_keep_the_loop_going(self):
        r = self.new_repo()
        r.write("app.py", "def f(xs):\n    return xs[1]\n")
        r.run("scope")
        out = r.record([{**IMPORTANT, "severity": "nit"}])
        self.assertIn("Round is clean", out)
        stop = r.json("scope")
        self.assertTrue(stop["stop"])  # nothing changed since the clean round
        self.assertIn("Nothing to review", stop["message"])

    def test_skip_never_hides_a_high_risk_file(self):
        r = self.new_repo()
        r.write(".claude/solo-review.json", json.dumps({"skip": ["**/*.json"]}))
        r.commit("config")
        r.write("data.json", "{}\n")
        r.write("package.json", "{}\n")
        r.write("app.py", "x = 1\n")
        scope = r.json("scope")
        self.assertEqual(sorted(scope["files"]), ["app.py", "package.json"])
        self.assertEqual(scope["high_files"], ["package.json"])
        self.assertTrue(scope["security"])
        self.assertNotEqual(scope["depth"], "quick")  # a built-in High-risk path is never only skimmed

    def test_own_high_paths_get_a_deep_review(self):
        r = self.new_repo()
        r.write(".claude/solo-review.json", json.dumps({"high": ["src/billing/**"]}))
        r.commit("config")
        r.write("src/billing/charge.py", "amount = 1\n")
        self.assertEqual(r.json("scope")["depth"], "deep")

    def test_bad_config_and_bad_ledger_lines_are_survivable(self):
        r = self.new_repo()
        r.write(".claude/solo-review.json", '{"max_rounds": "lots", "depth": "huge", "check": "make go", "x": 1}')
        r.commit("config")
        cfg = r.run("config")
        self.assertIn("bad value for `max_rounds`", cfg.stderr)
        self.assertIn("unknown setting `x`", cfg.stderr)
        data = json.loads(cfg.stdout)
        self.assertEqual((data["max_rounds"], data["depth"], data["check"]), (3, "auto", "make go"))
        r.write("app.py", "x = 1\n")
        r.run("scope")
        r.record([IMPORTANT])
        with open(os.path.join(r.path, ".git", "solo-review", "ledger.jsonl"), "a") as f:
            f.write('{"type": "finding", "id": "F-9"\n')  # a write cut short
        self.assertIn("F-1", r.run("open").stdout)

    def test_resolve_validates_its_input(self):
        r = self.new_repo()
        r.write("app.py", "x = 1\n")
        r.run("scope")
        r.record([IMPORTANT])
        self.assertNotEqual(r.run("resolve", "F-1", "--as", "fixed", ok=False).returncode, 0)  # --by is required
        bad = r.run("resolve", "F-1", "--as", "fixed", "--by", "agent", "--commit", "HEAD..HEAD~1", ok=False)
        self.assertIn("doesn't name a commit", bad.stderr)
        self.assertIn("reason is required", r.run("resolve", "F-1", "--as", "wrong", "--by", "user", ok=False).stderr)
        r.run("resolve", "1", "--as", "wrong", "--by", "user", "--reason", "guarded by caller")
        self.assertIn("0 open", r.run("open").stdout)
        self.assertIn("guarded by caller", r.run("reasons").stdout)


class ShipCheckTest(TempDirCase):
    def test_reviewed_current_stale_and_rebased(self):
        repo, seed = self.with_origin()
        repo.git("switch", "-q", "-c", "feat/x")
        repo.write("app.py", "def f(xs):\n    return xs[0] if xs else None\n")
        repo.commit("Handle empty input")
        repo.run("scope")
        repo.record([])
        check = repo.json("ship-check")
        self.assertEqual((check["reviewed"], check["problems"], check["tier"]), ("current", [], "medium"))

        seed.write("README.md", "hello\n")  # main moves on elsewhere
        seed.commit("docs")
        seed.git("push", "-q", "origin", "main")
        repo.git("fetch", "-q", "origin")
        repo.git("rebase", "-q", "origin/main")
        self.assertEqual(repo.json("ship-check")["reviewed"], "rebased")
        stop = repo.json("scope")  # the review skill doesn't redo it either
        self.assertTrue(stop["stop"])
        self.assertIn("before a rebase", stop["message"])

        repo.write("app.py", "def f(xs):\n    return None\n")
        check = repo.json("ship-check")
        self.assertEqual(check["reviewed"], "stale")
        self.assertEqual(check["changed_since_review"], ["app.py"])
        self.assertIn("changed since the last review round", check["problems"])

    def test_review_on_main_carries_over_to_the_branch_ship_makes(self):
        repo, _ = self.with_origin()
        repo.write("app.py", "def f(xs):\n    return xs[0] if xs else None\n")
        repo.commit("Handle empty input")
        scope = repo.json("scope")
        self.assertEqual(scope["label"], "unpushed vs origin/main")
        repo.record([{**IMPORTANT, "severity": "nit", "title": "name the None case"}])
        before = repo.json("ship-check")
        self.assertTrue(before["on_default"])
        self.assertEqual((before["reviewed"], before["open_nits"]), ("current", ["F-1"]))
        repo.git("switch", "-q", "-c", "fix/empty-input")
        repo.git("branch", "-f", "main", "origin/main")
        after = repo.json("ship-check")
        self.assertEqual((after["on_default"], after["reviewed"], after["review_branch"]), (False, "current", "main"))
        self.assertEqual(after["open_nits"], ["F-1"])
        self.assertEqual(after["problems"], [])
        summary = repo.run("pr-summary", "--run", after["review_run"]).stdout
        self.assertIn("| F-1 name the None case | nit |", summary)

    def test_open_important_blocks(self):
        repo, _ = self.with_origin()
        repo.git("switch", "-q", "-c", "feat/y")
        repo.write("app.py", "def f(xs):\n    return xs[1]\n")
        repo.commit("change")
        repo.run("scope")
        repo.record([IMPORTANT])
        check = repo.json("ship-check")
        self.assertIn("open Important findings: F-1", check["problems"])
        self.assertTrue(repo.json("ship-check")["github"] is False)


class LearnLoopTest(TempDirCase):
    def test_escape_evals_stats_and_learned(self):
        r = self.new_repo()
        r.write("app.py", "def f(xs):\n    return xs[1]\n")
        bad = r.commit("change")
        r.write("app.py", "def f(xs):\n    return xs[0]\n")
        fix = r.commit("fix")
        r.run("escape", "--commit", bad, "--fix", fix, "--file", "app.py", "--summary", "index off by one")
        self.assertIn("E-1", r.run("evals").stdout)
        r.write("app.py", "x = 1\n")
        r.run("scope")
        r.record([IMPORTANT], rejected=1, rejected_guide=0, nits_found=0, candidates=2)
        r.run("resolve", "F-1", "--as", "fixed", "--by", "user")
        stats = r.run("stats").stdout
        self.assertIn("1 runs, 1 findings", stats)
        self.assertIn("Escapes: 1", stats)
        r.run("learned", "--rev-before", "none", "--summary", "eval", "--eval", "1/1", "--eval-only")
        self.assertIn("eval", r.run("evals").stdout)
        self.assertIn("1 unlabeled", r.run("clean-sample", "--n", "1").stdout)


class SetupInfoTest(TempDirCase):
    def test_setup_info(self):
        r = self.new_repo()
        r.write("src/auth/login.py", "x = 1\n")
        r.write("scripts/release.sh", "echo\n")
        r.write("CLAUDE.md", "# Project\n\n## Verify\n- run tests\n")
        r.write("package.json", json.dumps({"scripts": {"test": "vitest"}}))
        r.commit("more")
        info = r.json("setup-info")
        self.assertEqual(info["inferred_check"], "npm test")
        self.assertEqual(info["claude_md"], "CLAUDE.md")
        self.assertTrue(info["claude_md_has_verify"])
        self.assertIn("src/auth/**", info["candidate_high"])
        self.assertIn("scripts/release.sh", info["candidate_high"])
        self.assertFalse(info["review_md"])
        self.assertTrue(os.path.isfile(info["templates"]["REVIEW.md"]))


class BrownfieldTest(TempDirCase):
    def test_setup_info_before_there_is_a_repo(self):
        path = os.path.join(self.tmp, "fresh")
        os.makedirs(os.path.join(path, "node_modules", "x"))
        with open(os.path.join(path, "package.json"), "w") as f:
            f.write(json.dumps({"scripts": {"test": "vitest run"}}))
        with open(os.path.join(path, ".env"), "w") as f:
            f.write("TOKEN=1\n")
        r = subprocess.run([sys.executable, LEDGER, "setup-info"], cwd=path, capture_output=True, text=True,
                           env=GIT_ENV)
        self.assertEqual(r.returncode, 0, r.stderr)
        info = json.loads(r.stdout)
        self.assertEqual((info["is_repo"], info["has_commits"], info["inferred_check"]), (False, False, "npm test"))
        self.assertEqual({g["pattern"] for g in info["ignore_gaps"]}, {"node_modules/", ".env"})
        self.assertFalse(os.path.exists(os.path.join(path, ".git")))  # it only looks

    def test_setup_info_in_an_established_repo(self):
        r = self.new_repo()
        r.write(".github/workflows/check.yml", "on: push\n")
        r.write("CLAUDE.md", "# x\n\n## Commands\n- `make test`\n")
        r.commit("ci")
        r.write("app.py", "x = 2\n")  # the user's work in progress: an edit, listed first as ` M app.py`
        r.write("wip.py", "x = 1\n")  # and a new file
        info = r.json("setup-info")
        self.assertEqual(info["ci_files"], [".github/workflows/check.yml"])
        self.assertTrue(info["claude_md_has_verify"])  # a Commands section counts
        self.assertEqual(info["uncommitted"], ["app.py", "wip.py"])  # v2.0 cut this to "pp.py"
        self.assertIsNone(info["v1"])

    def test_publish_scan(self):
        r = self.new_repo()
        token = "ghp_" + "a1B2" * 9
        r.write("config.py", f'TOKEN = "{token}"\n')
        r.commit("add token")
        r.write("config.py", "TOKEN = None\n")
        r.write("README.md", "Mail me@private.dev or 1+x@users.noreply.github.com\n")
        r.write(".env", "X=1\n")
        r.commit("remove token")
        scan = r.json("publish-scan")
        self.assertEqual(scan["secrets"], [])  # gone from the files...
        self.assertIn("GitHub token", scan["secrets_in_history"])  # ...but still in what a push publishes
        self.assertEqual(scan["secret_files"], [".env"])
        self.assertEqual(scan["emails"], ["me@private.dev"])
        self.assertFalse(scan["clean"])
        self.assertNotIn(token, json.dumps(scan))  # values are never printed

    def test_v1_migration(self):
        r = self.new_repo()
        r.write("REVIEW.md", (
            "---\n# solo-review settings\ndepth: auto            # auto | quick\n"
            'check: "make test # all"  # the one command\nmax_nits: 2\ngate: push\nworkflow: auto\n'
            "sensitive:             # reviewed deep\n  - \"**/install.sh\"\n  - \"src/billing/**\"\n"
            'skip: ["dist/**"]\n---\n\n# Review guide\n\n## What failure looks like here\n- Data loss\n\n'
            "## Always check\n<!-- /solo-review:review-learn adds to this list. -->\n\n## Don't flag\n- Style\n\n"
            "## Intentional patterns\n\n## Evidence\n- Cite file:line\n"))
        r.write(".review/ledger.jsonl", json.dumps({"type": "finding", "id": "F-7", "ts": "2026-10-01T00:00:00Z",
                                                    "run": "R-1", "branch": "main", "file": "a.py",
                                                    "severity": "important", "title": "t"}) + "\n")
        r.write(".github/pull_request_template.md", "## Summary\n## Changes\n## Review\n## Testing\n"
                                                    "## Risk and rollback\n## Checklist\n")
        r.write("src/billing/charge.py", "x = 1\n")
        r.commit("v1 setup")
        v1 = r.json("setup-info")["v1"]
        self.assertEqual(v1["settings"], {"check": "make test # all", "max_nits": 2, "high": ["src/billing/**"],
                                          "skip": ["dist/**"]})
        self.assertEqual(sorted(v1["dropped_keys"]), ["gate", "workflow"])
        self.assertEqual(v1["dropped_globs"], ["**/install.sh"])  # a v1 template glob that matches nothing here
        self.assertEqual(v1["pr_template_v1"], ".github/pull_request_template.md")
        md = v1["review_md"]
        self.assertFalse(md.startswith("---"))
        for heading in ("## What Important means here", "## Do not report", "## Intentional", "/solo-review:learn",
                        "## Cap the nits\nReport at most 2 nits"):
            self.assertIn(heading, md)
        self.assertLess(md.index("## Cap the nits"), md.index("## Evidence"))
        self.assertEqual(ledger.review_checklist(md), ["Data loss"])
        self.assertIn("Imported 1 of 1", r.run("import-v1").stdout)
        self.assertIn("Imported 0 of 1", r.run("import-v1").stdout)  # running it again adds nothing
        self.assertEqual(r.run("open", "--all").stdout.count("F-7"), 1)


class GuardTest(TempDirCase):
    def guard(self, cwd, tool, **tool_input):
        payload = {"tool_name": tool, "tool_input": tool_input, "cwd": cwd}
        r = subprocess.run([sys.executable, LEDGER, "guard"], cwd=self.tmp, input=json.dumps(payload),
                           capture_output=True, text=True, env=GIT_ENV)
        self.assertEqual(r.returncode, 0, r.stderr)  # a hook that fails must fail open
        return json.loads(r.stdout)["hookSpecificOutput"]["permissionDecision"] if r.stdout.strip() else "allow"

    def guarded_repo(self):
        r = self.new_repo()
        r.write(".gitignore", "local.env\n")
        r.commit("ignore")
        r.run("enable")
        return r

    def test_not_set_up_means_no_guard(self):
        r = self.new_repo()
        self.assertEqual(self.guard(r.path, "Edit", file_path="app.py"), "allow")
        self.assertEqual(self.guard(r.path, "Bash", command="git commit -m x"), "allow")

    def test_edits_on_the_default_branch_are_refused(self):
        r = self.guarded_repo()
        self.assertEqual(self.guard(r.path, "Edit", file_path="app.py"), "deny")
        self.assertEqual(self.guard(r.path, "Write", file_path=os.path.join(r.path, "new/dir/x.py")), "deny")
        self.assertEqual(self.guard(r.path, "NotebookEdit", notebook_path="n.ipynb"), "deny")
        self.assertTrue(r.json("where")["guarded"])

    def test_what_the_guard_lets_through_on_the_default_branch(self):
        r = self.guarded_repo()
        self.assertEqual(self.guard(r.path, "Write", file_path=".solo-review/record.json"), "allow")
        self.assertEqual(self.guard(r.path, "Edit", file_path="local.env"), "allow")  # ignored: never committed
        self.assertEqual(self.guard(r.path, "Write", file_path=os.path.join(self.tmp, "outside.txt")), "allow")
        os.makedirs(os.path.join(r.path, ".git", "rebase-merge"))  # finishing a rebase
        self.assertEqual(self.guard(r.path, "Edit", file_path="app.py"), "allow")
        self.assertEqual(self.guard(r.path, "Bash", command="git commit -m x"), "allow")

    def test_a_branch_is_free(self):
        r = self.guarded_repo()
        r.git("switch", "-q", "-c", "feat/x")
        self.assertEqual(self.guard(r.path, "Edit", file_path="app.py"), "allow")
        self.assertEqual(self.guard(r.path, "Bash", command="git commit -am x"), "allow")
        self.assertFalse(r.json("where")["on_default"])

    def test_a_default_branch_not_named_main_or_master_is_guarded(self):
        r = self.new_repo()
        r.git("branch", "-m", "trunk")
        r.run("enable")
        self.assertEqual(self.guard(r.path, "Edit", file_path="app.py"), "deny")
        self.assertTrue(r.json("where")["on_default"])

    def test_no_guess_among_several_local_branches(self):
        r = self.new_repo()
        r.git("branch", "-m", "trunk")
        r.git("branch", "other")
        r.run("enable")
        self.assertIsNone(self.guard_default(r))
        self.assertEqual(self.guard(r.path, "Edit", file_path="app.py"), "allow")
        r.git("config", "init.defaultBranch", "trunk")
        self.assertEqual(self.guard(r.path, "Edit", file_path="app.py"), "deny")

    def test_enable_records_the_default_branch_across_the_setup_branch(self):
        r = self.new_repo()
        r.git("branch", "-m", "trunk")
        r.run("enable")
        r.run("enable")  # idempotent
        r.git("switch", "-q", "-c", "chore/solo-review-setup")
        self.assertFalse(r.json("where")["on_default"])
        self.assertEqual(self.guard(r.path, "Edit", file_path="app.py"), "allow")
        r.git("switch", "-q", "trunk")
        self.assertTrue(r.json("where")["on_default"])
        self.assertEqual(self.guard(r.path, "Edit", file_path="app.py"), "deny")

    def test_enable_does_not_overwrite_the_recorded_default_with_nothing(self):
        r = self.new_repo()
        r.git("branch", "-m", "trunk")
        r.run("enable")
        r.git("switch", "-q", "-c", "feat/x")
        r.run("enable")
        r.git("switch", "-q", "trunk")
        self.assertEqual(self.guard(r.path, "Edit", file_path="app.py"), "deny")

    def guard_default(self, r):
        cwd = os.getcwd()
        os.chdir(r.path)
        try:
            return ledger.default_branch()
        finally:
            os.chdir(cwd)

    def test_a_new_repositorys_first_commit_is_allowed(self):
        r = Repo(os.path.join(self.tmp, "new"))
        r.run("enable")
        self.assertEqual(self.guard(r.path, "Write", file_path="app.py"), "allow")
        self.assertEqual(self.guard(r.path, "Bash", command="git commit -m 'Initial commit'"), "allow")

    def test_commits_on_the_default_branch_are_refused_however_they_are_written(self):
        r = self.guarded_repo()
        for command in ("git commit -m x", 'git status && git commit -am "a | b; c"',
                        "GIT_AUTHOR_NAME=x git -c user.name=y commit -m z", "git log\ngit commit -m y",
                        "env FOO=1 git commit --amend"):
            self.assertEqual(self.guard(r.path, "Bash", command=command), "deny", command)
        elsewhere = os.path.join(self.tmp, "elsewhere")
        os.makedirs(elsewhere)
        self.assertEqual(self.guard(elsewhere, "Bash", command=f"git -C {r.path} commit -m x"), "deny")
        for command in ('echo "git commit"', "git log --grep commit", "git status", 'git commit -m "unclosed',
                        "git switch -c feat/x && echo ok"):
            self.assertEqual(self.guard(r.path, "Bash", command=command), "allow", command)

    def test_bad_payloads_fail_open(self):
        for text in ("", "not json", "[]", '{"tool_name": "Edit", "tool_input": {"file_path": 3}}'):
            r = subprocess.run([sys.executable, LEDGER, "guard"], cwd=self.tmp, input=text, capture_output=True,
                               text=True, env=GIT_ENV)
            self.assertEqual((r.returncode, r.stdout), (0, ""), text)

    def test_a_review_on_main_carries_over_when_the_change_moves_to_a_branch(self):
        repo, _ = self.with_origin()
        repo.write("app.py", "def f(xs):\n    return xs[1]\n")
        repo.commit("change made on main")
        repo.run("scope")
        repo.record([IMPORTANT])
        repo.write("app.py", "def f(xs):\n    return xs[0] if xs else None\n")
        sha = repo.commit("Fix review finding F-1")
        repo.run("resolve", "F-1", "--as", "fixed", "--by", "agent", "--commit", sha)
        self.assertEqual(repo.json("scope")["round"], 2)
        repo.record([{**IMPORTANT, "severity": "nit", "title": "name the None case"}])
        repo.git("switch", "-q", "-c", "fix/empty")  # what ship and review do with work found on main
        repo.git("branch", "-f", "main", "origin/main")
        stop = repo.json("scope")
        self.assertTrue(stop["stop"])
        self.assertIn("since the last reviewed round", stop["message"])  # not a fresh full review
        self.assertIn("F-2", repo.run("open").stdout)  # and the open nit came along
        repo.write("app.py", "def f(xs):\n    return None\n")
        scope = repo.json("scope")
        self.assertEqual((scope["round"], scope["incremental"]), (1, True))  # new work: a new cycle, diff-only
        self.assertIn("F-2 [open]", " ".join(scope["open_to_recheck"]))
        out = repo.record([], resolved_by_change=["F-2"])  # the recheck finds it gone: it closes here too
        self.assertNotIn("Still open", out)
        self.assertIn("0 open finding", repo.run("open").stdout)

    def test_an_unrelated_review_on_main_is_not_carried_over(self):
        repo, _ = self.with_origin()
        repo.write("app.py", "x = 'reviewed, then thrown away'\n")
        repo.run("scope")  # uncommitted work on main: its snapshot is in no branch's history
        repo.record([IMPORTANT])
        repo.git("checkout", "-q", "--", "app.py")
        repo.git("switch", "-q", "-c", "feat/other")
        repo.write("other.py", "y = 1\n")
        repo.commit("other work")
        scope = repo.json("scope")
        self.assertEqual((scope["round"], scope["incremental"], scope["prior_findings"]), (1, False, []))

    def test_unpushed_commits_on_main_belong_to_the_branch_made_from_it(self):
        repo, _ = self.with_origin()
        repo.write("app.py", "def f(xs):\n    return xs[-1]\n")
        repo.commit("work done on main by hand")
        self.assertEqual(repo.json("where")["unpushed"], 1)
        repo.git("switch", "-q", "-c", "fix/last")  # main still holds the commit too
        scope = repo.json("scope")
        self.assertEqual((scope["label"], scope["files"]), ("branch vs main", ["app.py"]))


if __name__ == "__main__":
    unittest.main()
