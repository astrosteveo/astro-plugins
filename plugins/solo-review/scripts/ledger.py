#!/usr/bin/env python3
"""solo-review ledger: the bookkeeping half of the review loop.

Per-project files:
  REVIEW.md                  the review guide, plain Markdown (also read by GitHub's Code Review)
  .claude/solo-review.json   settings: check, high, skip, and a few knobs
Never committed:
  <git common dir>/solo-review/ledger.jsonl   append-only events: run, finding, outcome, escape, learn
  <git dir>/solo-review.pending.json          the round between `scope` and `record`
  <repo>/.solo-review/                        handoff files the model writes and this script reads and deletes

The model calls this script instead of reading or rewriting the ledger itself, so a review costs tokens only for
the review. It never runs the project's check command and never changes the user's index, worktree or refs.
"""
import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES = {name: os.path.join(PLUGIN_ROOT, "templates", name)
             for name in ("REVIEW.md", "pull_request_template.md", "verify-section.md", "git-section.md",
                          "solo-review.json")}
CONFIG_PATH = os.path.join(".claude", "solo-review.json")
SCRATCH = ".solo-review"

DEFAULTS = {
    "check": "",              # the one command that builds and tests the project
    "high": [],               # globs added to ALWAYS_HIGH: reviewed deep, and you read them before a merge
    "skip": [],               # globs never reviewed (a High-risk file is reviewed anyway)
    "depth": "auto",          # auto | quick | standard | deep
    "security": "auto",       # auto | always | never
    "max_rounds": 3,          # review-and-fix rounds before stepping back to reconsider the approach
    "max_nits": 3,
    "quick_max_lines": 20,    # auto depth: diffs this small get a quick review
    "merge": "rebase",        # rebase | squash | merge: how /solo-review:ship merges the PR
}
ENUMS = {"depth": ("auto", "quick", "standard", "deep"), "security": ("auto", "always", "never"),
         "merge": ("rebase", "squash", "merge")}
SEVERITIES = ("important", "nit", "pre-existing")
CATEGORIES = ("logic", "error-handling", "concurrency", "resource", "data-integrity",
              "api-contract", "security", "performance", "test", "docs-drift", "convention")
# deferred: pre-existing, outside the change. merged-past: a nit shipped without a fix, which answers it but says
# nothing about whether it was right, so it counts as neither useful nor noise.
OUTCOMES = ("fixed", "wrong", "intentional", "wontfix", "deferred", "merged-past")
JUDGED = ("fixed", "wrong", "intentional", "wontfix")  # the article's four author responses
DISMISSED = ("wrong", "intentional", "wontfix", "merged-past")  # answered without a fix: finders don't repeat these
LEGACY_MERGED = "merged without fixing"  # v1 ship's reason for merged-past nits before that outcome existed
LEGACY_EVAL = "eval only"  # v1's summary for a learn event before --eval-only existed
LABELED_BY = ("user", "auto")  # an agent grading its own fixes is not a label
DOC_EXT = (".md", ".mdx", ".txt", ".rst", ".adoc")
# Added code lines (not docs) that touch a real sink turn the security lens on. Broad words (url, token, hash, session)
# fired on nearly every diff and cost a full extra finder per round, so words are matched whole, calls by their call
# form, and SQL only in upper case.
SECURITY_HINTS = re.compile(
    r"\b(?:eval|exec|execSync|execFile|popen|spawn|system)\s*\(|\b(?:subprocess|child_process)\b|os\.system"
    r"|shell\s*=\s*True"  # command execution
    r"|\b(?:pickle|marshal|unserialize|deserializ\w*)\b|yaml\.load\b"  # unsafe deserialization
    r"|\b(?:innerHTML|outerHTML|dangerouslySetInnerHTML)\b|\bv-html\b|document\.write"  # HTML injection
    r"|\b(?:execute|executemany|raw)\s*\("  # SQL
    r"|(?-i:\b(?:SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s.+\sSET|DELETE\s+FROM)\b)"
    r"|\b(?:jwt|bcrypt|crypto|cipher|setuid|chmod|sudo)\b|verify\s*=\s*False", re.I)  # auth, crypto, privilege
# A secret-looking name being assigned, which is narrower than the bare words password and secret
SECRET_HINTS = re.compile(r"(?:password|passwd|secret|api[_-]?key|private[_-]?key)\w*[\"']?\s*[:=]", re.I)

# Always High risk, whatever the settings say, because a bad change to one of these is a risk on its own: you read it
# before it merges, and agents review it with a security pass. `high` adds project paths on top; nothing removes these.
ALWAYS_HIGH = (
    # what steers Claude and the review: loaded into every session, so one wrong line steers all of them
    "REVIEW.md", "**/CLAUDE.md", "**/CLAUDE.local.md", "**/AGENTS.md", "**/.claude/**", "**/.mcp.json",
    "**/.claude-plugin/**", "**/skills/**", "**/agents/**", "**/commands/**", "**/hooks/**", "**/CODEOWNERS",
    # what runs automatically: CI, git hooks, containers, editors and shells that run tasks, build entry points
    ".github/workflows/**", ".github/actions/**", "**/dependabot.yml", "**/dependabot.yaml",
    "**/.gitlab-ci*.yml", "**/.gitlab-ci*.yaml", "**/.circleci/**", "**/Jenkinsfile*", "**/azure-pipelines*.yml",
    "**/azure-pipelines*.yaml", "**/.buildkite/**", "**/.travis.yml", "**/.husky/**", "**/.githooks/**",
    "**/.pre-commit-config.yaml", "**/.pre-commit-config.yml", "**/lefthook*", "**/.lefthook*", "**/Dockerfile*",
    "**/*.dockerfile", "**/docker-compose*.yml", "**/docker-compose*.yaml", "**/compose*.yml", "**/compose*.yaml",
    "**/.devcontainer/**", "**/.devcontainer.json", "**/.vscode/tasks.json", "**/.envrc", "**/Makefile",
    "**/GNUmakefile",
    # what gets installed, and from where: install scripts, registries, submodules
    "**/package.json", "**/requirements*.txt", "**/pyproject.toml", "**/setup.py", "**/Cargo.toml", "**/go.mod",
    "**/Gemfile", "**/composer.json", "**/*.lock", "**/package-lock.json", "**/pnpm-lock.yaml", ".gitmodules",
    "**/.npmrc", "**/.pypirc", "**/.yarnrc*", "**/.cargo/**", "**/.netrc",
    # secrets, which should never be committed at all
    "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*", "**/credentials*",
)
# Claude Code's own worktrees live inside the checkout; git sees each one as an untracked nested repo
WORKTREES_DIR = ".claude/worktrees"
READ_CAP = 1_000_000  # characters: more than any REVIEW.md, manifest or Makefile holds


# ---------------------------------------------------------------- git and files

def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git(*args, check=True, env=None, input=None):
    r = subprocess.run(["git", *args], capture_output=True, text=True, env=env, input=input, errors="replace")
    if check and r.returncode:
        sys.exit(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout.strip() if r.returncode == 0 else ""


def repo_root():
    r = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def state_dir():
    """The ledger's folder, in the git dir every worktree of this clone shares: never committed, never in a diff."""
    common = git("rev-parse", "--git-common-dir")
    return os.path.join(os.path.realpath(common), "solo-review")


def ledger_path():
    return os.path.join(state_dir(), "ledger.jsonl")


def pending_path():
    """The round between `scope` and `record`, per worktree, so two checkouts reviewing at once don't collide."""
    return os.path.join(git("rev-parse", "--absolute-git-dir"), "solo-review.pending.json")


def ensure_excluded():
    """List the scratch folder in .git/info/exclude, so a handoff file never shows up in git status or a snapshot."""
    path = os.path.join(os.path.realpath(git("rev-parse", "--git-common-dir")), "info", "exclude")
    line = f"/{SCRATCH}/"
    try:
        with open(path) as f:
            if line in f.read().splitlines():
                return
    except OSError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        f.write(f"\n# solo-review handoff files\n{line}\n")


def input_file(path):
    """A --file argument: an existing file inside .solo-review/, since it is read and then deleted."""
    real, root = os.path.realpath(path), os.path.realpath(SCRATCH)
    if os.path.commonpath([real, root]) != root or not os.path.isfile(real):
        sys.exit(f"--file must be an existing file inside {SCRATCH}/.")
    return real


def take_input(path):
    """Read and delete a handoff file, and the scratch folder too once it's empty."""
    real = input_file(path)
    with open(real, errors="replace") as f:
        text = f.read()
    os.remove(real)
    try:
        os.rmdir(SCRATCH)
    except OSError:
        pass
    return text


def load_events():
    """The ledger's events. A line that isn't valid JSON (a write cut short, a hand edit) is skipped with a warning
    rather than breaking every command."""
    try:
        with open(ledger_path(), errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return []
    events = []
    for n, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            e = json.loads(line)
        except ValueError:
            print(f"ledger: skipping unreadable line {n} of {ledger_path()}", file=sys.stderr)
            continue
        if isinstance(e, dict) and "type" in e:
            events.append(e)
    return events


def append(*events):
    os.makedirs(state_dir(), exist_ok=True)
    text = "".join(json.dumps(e, separators=(",", ":")) + "\n" for e in events)
    with open(ledger_path(), "a") as f:
        f.write(text)  # one write per call, so a crash can't leave half a round


def highest_id(prefix):
    try:
        with open(ledger_path(), errors="replace") as f:
            text = f.read()
    except OSError:
        return 0
    return max((int(n) for n in re.findall(r'"id":\s*"' + re.escape(prefix) + r'-(\d+)"', text)), default=0)


def norm_id(raw, prefix="F"):
    """`F-12`, `f12` or `12` -> `F-12`; None for anything else, such as an escape id given as a finding."""
    m = re.fullmatch(rf"(?:{prefix}-?)?(\d+)", str(raw).strip(), re.I)
    return f"{prefix}-{int(m.group(1))}" if m else None


def read_capped(path, errors="strict"):
    """The first READ_CAP characters of a file the branch controls, or None when `path` isn't a regular file or can't be
    read. A symlink to /dev/zero never ends and a FIFO blocks at open: isfile() is False for both."""
    if not os.path.isfile(path):
        return None
    try:
        with open(path, errors=errors) as f:
            return f.read(READ_CAP)
    except (OSError, ValueError):  # ValueError: a UnicodeDecodeError, under errors="strict"
        return None


def review_md():
    return read_capped("REVIEW.md", "replace")


def current_branch():
    # a new repo's branch has a name but no commit yet, so rev-parse can't name it and symbolic-ref has to
    return (git("rev-parse", "--abbrev-ref", "HEAD", check=False)
            or git("symbolic-ref", "--quiet", "--short", "HEAD", check=False) or "HEAD")


def has_commits():
    return bool(git("rev-parse", "--verify", "--quiet", "HEAD", check=False))


def is_commit(rev):
    """False once gc has pruned `rev`: review snapshots are commits nothing references."""
    return bool(rev) and subprocess.run(["git", "cat-file", "-e", f"{rev}^{{commit}}"],
                                        capture_output=True).returncode == 0


def is_ancestor(a, b):
    return subprocess.run(["git", "merge-base", "--is-ancestor", a, b], capture_output=True).returncode == 0


def tree_of(rev):
    return git("rev-parse", f"{rev}^{{tree}}", check=False)


def default_branch():
    """The default branch's name (origin/HEAD's target, else main or master), when a local branch or origin's copy of
    it exists."""
    ref = git("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD", check=False)
    prefix = "refs/remotes/origin/"
    candidates = [ref[len(prefix):]] if ref.startswith(prefix) else []
    for b in candidates + ["main", "master"]:
        if default_refs(b):
            return b
    # no origin and no main/master: init.defaultBranch if it exists, else the only local branch; never a guess
    configured = git("config", "--get", "init.defaultBranch", check=False)
    if configured and default_refs(configured):
        return configured
    local = git("for-each-ref", "--format=%(refname:short)", "refs/heads", check=False).split()
    return local[0] if len(local) == 1 else None


def default_refs(db):
    """The refs holding the default branch `db` that exist: the local branch and origin's copy."""
    return [r for r in (f"refs/heads/{db}", f"refs/remotes/origin/{db}")
            if git("rev-parse", "--verify", "--quiet", f"{r}^{{commit}}", check=False)]


def origin_default(db):
    return f"origin/{db}" if db and f"refs/remotes/origin/{db}" in default_refs(db) else None


def default_merge_base(db):
    """Where HEAD left the default branch `db`. With a remote that's origin's copy: a pull request holds every commit
    origin's default branch lacks, so commits made on the local default branch and never pushed are part of the
    change. Without a remote it's the local branch."""
    return git("merge-base", "HEAD", origin_default(db) or db)


def pick_base(arg_base):
    """What the change is measured against: the given ref; on a feature branch, where it left the default branch; on
    the default branch, its upstream or origin's copy (so the change is everything unpushed); with no remote at all,
    HEAD (so the change is what's uncommitted)."""
    if arg_base:
        return git("rev-parse", "--verify", f"{arg_base}^{{commit}}"), arg_base
    branch, db = current_branch(), default_branch()
    if db and branch not in (db, "HEAD"):
        return default_merge_base(db), f"branch vs {db}"
    upstream = git("rev-parse", "--abbrev-ref", "@{u}", check=False) or origin_default(db)
    if upstream:
        return git("merge-base", "HEAD", upstream), f"unpushed vs {upstream}"
    return git("rev-parse", "HEAD"), "uncommitted changes"


def snapshot_tree():
    """Tree object of the working tree (tracked + untracked, minus ignored), without touching the user's index,
    worktree or refs."""
    git_dir = git("rev-parse", "--absolute-git-dir")
    idx = os.path.join(git_dir, f"solo-review.{os.getpid()}.index")
    real_idx = os.path.join(git_dir, "index")
    env = {**os.environ, "GIT_INDEX_FILE": idx}
    try:
        if os.path.exists(real_idx):
            # reuse the stat cache so `add -A` doesn't rehash everything. copy2 keeps the index's mtime, which git's
            # racy-entry check compares against: with a fresh mtime, a same-size edit made in the same second as the
            # last index write looks unchanged
            shutil.copy2(real_idx, idx)
        else:
            git("read-tree", "HEAD", env=env)
        git("-c", "advice.addEmbeddedRepo=false", "add", "-A", env=env)
        # drop Claude Code's worktrees afterwards: naming them in `add`'s pathspec, even to exclude them, makes git
        # fail once a .gitignore ignores them
        git("rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", WORKTREES_DIR, env=env)
        return git("write-tree", env=env)
    finally:
        if os.path.exists(idx):
            os.remove(idx)


def snapshot():
    """Commit object for the working tree, parented on HEAD; HEAD itself when the tree is clean."""
    tree, head = snapshot_tree(), git("rev-parse", "HEAD")
    if tree == tree_of("HEAD"):
        return head
    env = {**os.environ, "GIT_AUTHOR_NAME": "solo-review", "GIT_AUTHOR_EMAIL": "solo-review@localhost",
           "GIT_COMMITTER_NAME": "solo-review", "GIT_COMMITTER_EMAIL": "solo-review@localhost"}
    return git("commit-tree", tree, "-p", "HEAD", "-m", "solo-review snapshot", env=env)


def patch_id(a, b):
    """Stable id of the diff a..b, the same after a rebase that didn't change the change. "" for an empty diff."""
    diff = subprocess.run(["git", "diff", "--no-ext-diff", a, b], capture_output=True).stdout
    if not diff:
        return ""
    r = subprocess.run(["git", "patch-id", "--stable"], input=diff, capture_output=True)
    return r.stdout.decode().split(" ")[0] if r.returncode == 0 else ""


def changed_raw(a, b, *pathspec):
    """Files that differ between two commits, with their new modes: [(path, mode)]. The -z output alternates a
    `:modes...` header and a path, read in pairs so a path that starts with ":" is never taken for a header."""
    toks = git("diff", "--raw", "--no-renames", "-z", a, b, "--", ".", *pathspec, check=False).split("\0")
    rows, i = [], 0
    while i + 1 < len(toks):
        if toks[i].startswith(":"):
            rows.append((toks[i + 1], toks[i].split()[1]))
            i += 2
        else:
            i += 1
    return rows


def uncommitted_paths():
    """Every path with uncommitted changes, staged or not, untracked included. Read raw with -z: the git() helper
    strips its output, and with it the leading space of a ` M path` status line."""
    out = subprocess.run(["git", "status", "--porcelain", "-z", "--untracked-files=all"], capture_output=True,
                         text=True, errors="replace").stdout.split("\0")
    paths, i = [], 0
    while i < len(out):
        entry = out[i]
        if len(entry) > 3:
            paths.append(entry[3:])
            if entry[0] in "RC":  # a rename or copy is followed by its old path
                i += 1
        i += 1
    return paths


def symlinks_in(rows):
    """Added or changed symlinks (mode 120000): they can point anywhere, so each one needs a person's eyes."""
    return {p for p, mode in rows if mode == "120000"}


# ---------------------------------------------------------------- settings and risk

def glob_re(g):
    """One glob dialect for every setting, git's `glob` pathspec magic: `*` and `?` stay inside a path segment, `**/`
    matches any number of folders, and a trailing `/**` everything inside. A trailing `/**` also matches the bare
    folder path, which is how git records a symlinked folder. Case is ignored."""
    out, i = "", 0
    while i < len(g):
        if g.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif g.startswith("/**", i) and i + 3 == len(g):
            out, i = out + "(?:/.*)?", i + 3
        elif g.startswith("**", i):
            out, i = out + ".*", i + 2
        elif g[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif g[i] == "?":
            out, i = out + "[^/]", i + 1
        elif g[i] == "[" and "]" in g[i + 2:]:
            j = g.index("]", i + 2)
            body = g[i + 1:j]
            out += "[" + ("^" + body[1:] if body.startswith("!") else body).replace("\\", "\\\\") + "]"
            i = j + 1
        else:
            out, i = out + re.escape(g[i]), i + 1
    return re.compile(out + r"\Z", re.I)


def matches(path, globs):
    return any(glob_re(g).match(path) for g in globs)


def load_config():
    """Settings from .claude/solo-review.json over DEFAULTS, plus `rev`, a short hash of REVIEW.md that labels which
    version of the guide each run used. A value of the wrong type is replaced by its default, with a warning."""
    cfg = {k: (list(v) if isinstance(v, list) else v) for k, v in DEFAULTS.items()}
    text = read_capped(CONFIG_PATH, "replace")
    source = CONFIG_PATH if text is not None else "defaults"
    data = {}
    if text is not None:
        try:
            data = json.loads(text.lstrip("\ufeff"))
        except ValueError as e:
            print(f"ledger: {CONFIG_PATH} isn't valid JSON ({e}); using the defaults.", file=sys.stderr)
        if not isinstance(data, dict):
            data = {}
    for k, v in data.items():
        d = DEFAULTS.get(k)
        if k.startswith("$") or k == "comment":
            continue
        if d is None:
            print(f"ledger: {CONFIG_PATH}: unknown setting `{k}` ignored.", file=sys.stderr)
        elif isinstance(d, list) and isinstance(v, list) and all(isinstance(x, str) for x in v):
            cfg[k] = v
        elif isinstance(d, int) and isinstance(v, int) and not isinstance(v, bool) and v >= 0:
            cfg[k] = max(v, 1) if k == "max_rounds" else v
        elif isinstance(d, str) and isinstance(v, str) and (k not in ENUMS or v in ENUMS[k]):
            cfg[k] = v
        else:
            print(f"ledger: {CONFIG_PATH}: bad value for `{k}`; using the default {d!r}.", file=sys.stderr)
    if not cfg["check"]:
        cfg["check"] = infer_check()
        if cfg["check"]:
            source += " (check inferred from the manifest)"
    guide = review_md()
    cfg["source"] = source
    cfg["rev"] = hashlib.sha1(guide.encode()).hexdigest()[:8] if guide is not None else None
    return cfg


def infer_check():
    """Best guess at the project's build-and-test command from its manifest, or "" if there is none."""
    text = read_capped("package.json")
    if text is not None:
        try:
            manifest = json.loads(text) if len(text) < READ_CAP else {}
        except (ValueError, RecursionError):
            manifest = {}
        scripts = manifest.get("scripts") if isinstance(manifest, dict) else None
        test = scripts.get("test") if isinstance(scripts, dict) else None
        # `npm init` writes a test script that only fails, so it is no check at all
        if isinstance(test, str) and test.strip() and "no test specified" not in test:
            return "npm test"
    if os.path.exists("Cargo.toml"):
        return "cargo test"
    if os.path.exists("go.mod"):
        return "go test ./..."
    if re.search(r"^test:", read_capped("Makefile", "ignore") or "", re.M):
        return "make test"
    if any(os.path.exists(p) for p in ("pyproject.toml", "pytest.ini", "setup.cfg", "tests")):
        # a locked project's own environment holds the package and pytest; a plain python3 may have neither
        if os.path.exists("uv.lock"):
            return "uv run pytest -q"
        if os.path.exists("poetry.lock"):
            return "poetry run pytest -q"
        return "python3 -m pytest -q"
    return ""


def is_high(path, cfg, symlinks=()):
    return path in symlinks or matches(path, ALWAYS_HIGH) or matches(path, cfg["high"])


def risk_tier(files, cfg, symlinks=()):
    """The article's tier, which "the change sets ..., not the author": high when any file is High-risk, low when every
    file is a doc, medium otherwise."""
    if any(is_high(f, cfg, symlinks) for f in files):
        return "high"
    if files and all(f.lower().endswith(DOC_EXT) for f in files):
        return "low"
    return "medium"


def security_hint(diff_text):
    """True if an added line outside doc files matches SECURITY_HINTS or SECRET_HINTS."""
    doc, in_hunk, lines = False, False, []
    for l in diff_text.splitlines():
        if l.startswith("diff --git "):
            doc, in_hunk = False, False
        elif l.startswith("@@"):
            in_hunk = True
        elif not in_hunk and l.startswith("+++ "):  # a header only before the file's first hunk
            doc = l.rstrip("\"").lower().endswith(DOC_EXT)
        elif in_hunk and l.startswith("+") and not doc:
            lines.append(l[1:])
    text = "\n".join(lines)
    return bool(SECURITY_HINTS.search(text) or SECRET_HINTS.search(text))


def claude_md_files(files):
    """CLAUDE.md files that apply to the changed files: in their folders and every parent up to the root. A CLAUDE.md
    under a templates/ folder is a template's placeholder text, not this project's conventions."""
    dirs = {""}
    for f in files:
        d = os.path.dirname(f)
        while d:
            if "templates" not in d.split("/"):
                dirs.add(d)
            d = os.path.dirname(d)
    paths = [os.path.join(d, name) for d in sorted(dirs) for name in ("CLAUDE.md", os.path.join(".claude", "CLAUDE.md"))]
    return [p for p in paths if os.path.isfile(p)]


# the sections finders walk line by line; the first is v1's name for the same thing
CHECKLIST_SECTIONS = ("what failure looks like here", "what important means here", "always check")


def review_checklist(text):
    """The list items of REVIEW.md's "What Important means here" and "Always check" sections, without HTML comments
    (the template's examples). Finders report what they found for each one, so an empty result shows what it covered."""
    if text is None:
        return []
    text = re.sub(r"<!--.*?(-->|\Z)", "", re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.S), flags=re.S)
    items, section, wrapped = [], None, False
    for line in text.splitlines():
        bullet = re.match(r"\s*(?:[-*+]|\d{1,9}[.)])\s+(\S.*)", line)
        if line.startswith("#"):
            section, wrapped = line.lstrip("#").strip().rstrip(":").strip().lower(), False
        elif section not in CHECKLIST_SECTIONS:
            continue
        elif bullet:
            items.append(bullet.group(1).strip())
            wrapped = True
        elif wrapped and line[:1].isspace() and line.strip():  # a bullet wrapped onto an indented line
            items[-1] += " " + line.strip()
        else:
            wrapped = False
    return [i[:300] for i in items[:30]]


# ---------------------------------------------------------------- findings and changes

def findings_state(events):
    """Latest state of every finding: the finding event plus its newest outcome."""
    state = {}
    for e in events:
        if e["type"] == "finding" and "id" in e:
            state[e["id"]] = {**e, "outcome": None}
        elif e["type"] == "outcome" and e.get("id") in state:
            f = state[e["id"]]
            outcome = e.get("outcome")
            if outcome == "wontfix" and e.get("by") == "user" and e.get("reason") == LEGACY_MERGED:
                outcome = "merged-past"
            # a spot-check confirming a fix names no commit: keep the one the fix was recorded with
            commit = e.get("commit") or (f.get("commit") if outcome == f["outcome"] else None)
            f.update(outcome=outcome, reason=e.get("reason", ""), by=e.get("by"), commit=commit,
                     resolved_ts=e.get("ts", ""), prev=f.get("outcome"), prev_by=f.get("by"))
    return state


def fmt_finding(f):
    loc = f"{f.get('file')}:{f.get('line', '?')}"
    return f"{f['id']} {f.get('severity', '?'):<12} {f.get('category', '?'):<14} {loc}  {f.get('title', '')}"


def is_clean(run):
    """A round with no Important findings ends the cycle. Nits don't send the loop round again: an agent author fixes
    every nit, and each fix is another commit and another round."""
    if "important" in run:
        return run["important"] == 0
    return run.get("actionable", run.get("reported", 0)) == 0


def change_runs(events, branch, base, db):
    """The runs that belong to the current change. The default branch holds one change after another, so there it's
    the runs measured from the same base. On a feature branch it's every run on it, plus the rounds a change had while
    it sat on the default branch before review or ship moved it here: same base, and the commit they reviewed is in
    this branch's history. A snapshot of uncommitted work is in no branch's history, so no other change can match."""
    runs = [e for e in events if e["type"] == "run" and e.get("branch") == branch]
    if branch in (db, "HEAD"):
        return [r for r in runs if r.get("base") == base]
    moved = [e for e in events if e["type"] == "run" and db and e.get("branch") == db and e.get("base") == base
             and is_commit(e.get("target")) and is_ancestor(e["target"], "HEAD")]
    return sorted(moved + runs, key=lambda r: (r.get("ts", ""), r.get("run", "")))


def change_findings(events, runs):
    ids = {r["run"] for r in runs}
    return [f for f in findings_state(events).values() if f.get("run") in ids]


def cycle_base(events, branch, arg_base):
    """pick_base, except that an unfinished cycle keeps the base it started from while that base is still behind HEAD.
    On a default branch with no remote the base is HEAD, so without this every fix commit started a new cycle: the
    round cap never fired and the fixes were never re-reviewed."""
    base, label = pick_base(arg_base)
    if arg_base:
        return base, label
    runs = [e for e in events if e["type"] == "run" and e.get("branch") == branch]
    last = runs[-1] if runs else None
    if last and not is_clean(last) and last.get("base") != base and is_ancestor(last["base"], "HEAD"):
        return last["base"], last.get("label", label)
    return base, label


def only_fixes_since(events, last, target_tree):
    """True when nothing but recorded fixes changed since the round `last`: the tree under review is the one the last
    `fixed` outcome left. Comparing trees, not commit subjects, means a fix counts the same committed or not."""
    if target_tree and target_tree == (last.get("tree") or tree_of(last.get("target", ""))):
        return True
    fixes = [e for e in events if e["type"] == "outcome" and e.get("outcome") == "fixed" and e.get("tree")
             and e.get("ts", "") >= last.get("ts", "")]
    return bool(fixes) and fixes[-1]["tree"] == target_tree


def cap_summary(events, cycle, branch, db):
    """What you need when the round cap stops a cycle: how many rounds ran, what they fixed, and what is still open."""
    state = findings_state(events)
    runs = {r["run"] for r in cycle}
    fixed = [f["id"] for f in state.values() if f.get("run") in runs and f["outcome"] == "fixed"]
    open_ = [f for f in state.values() if f.get("run") in runs and f["outcome"] is None]
    important = sum(1 for f in open_ if f.get("severity") == "important")
    lines = [f"Review stopped at the round cap: {len(cycle)} rounds ran without a clean pass.",
             f"Rounds: {len(cycle)} | Fixed: {len(fixed)} | Open: {len(open_)} ({important} Important)"]
    if open_:
        lines += ["", "Open findings:"] + [f"  {fmt_finding(f)}" for f in open_]
    lines += ["", "Next:",
              "  rethink the approach if the same problem keeps coming back",
              "  /solo-review:review --force     one more round",
              "  /solo-review:review resolve <ids> <wrong|intentional|wontfix> <reason>   answer a finding yourself"]
    return "\n".join(lines)


# ---------------------------------------------------------------- commands

def cmd_scope(args):
    if not has_commits():
        sys.exit("No commits yet; commit once so there is a base to review against.")
    cfg = load_config()
    branch, db = current_branch(), default_branch()
    events = load_events()
    if args.range:
        a, sep, b = args.range.partition("...")
        if not sep:
            a, _, b = args.range.partition("..")
        base = git("merge-base", a, b or "HEAD") if sep else git("rev-parse", "--verify", f"{a}^{{commit}}")
        target, label, worktree = git("rev-parse", "--verify", f"{b or 'HEAD'}^{{commit}}"), args.range, False
    else:
        (base, label), target, worktree = cycle_base(events, branch, args.base), snapshot(), True
    target_tree = tree_of(target)

    prior_runs = [r for r in change_runs(events, branch, base, db) if r.get("base") == base]
    # A cycle is one review-and-fix loop: it ends on a clean round, and new work (anything but a recorded fix) starts a
    # fresh one. The cap is for "an agent author and an agent reviewer" that "keep each other busy", not new features.
    last = prior_runs[-1] if prior_runs else None
    new_work = bool(last) and not only_fixes_since(events, last, target_tree)
    if not last or is_clean(last) or new_work:
        cycle, cycle_id = [], None
    else:
        cycle_id = last.get("cycle") or last["run"]
        cycle = [r for r in prior_runs if (r.get("cycle") or r["run"]) == cycle_id]
    round_no = len(cycle) + 1
    if round_no > cfg["max_rounds"] and not args.force:
        print(json.dumps({"stop": True, "round": round_no, "max_rounds": cfg["max_rounds"],
                          "message": f"{len(cycle)} review-and-fix rounds ran without a clean pass. Step back and "
                                     "reconsider the approach instead of patching again (or rerun with --force for "
                                     "one more round).",
                          "summary": cap_summary(events, cycle, branch, db)}))
        return

    # everything up to the last reviewed snapshot has been reviewed: re-review only what changed since, unless --fresh
    # asks to review the whole change again
    diff_from, incremental = base, False
    if last and not args.fresh and is_commit(last.get("target")):
        diff_from, incremental = last["target"], True

    whole_patch = patch_id(base, target)
    if not incremental and not args.fresh and whole_patch:
        # a rebase moves the base, and with it every snapshot: the same patch was already reviewed clean
        done = [r for r in events if r["type"] == "run" and r.get("patch_id") == whole_patch and is_clean(r)]
        if done:
            print(json.dumps({"stop": True, "round": round_no,
                              "message": f"Nothing new to review: this change was reviewed clean in {done[-1]['run']} "
                                         "before a rebase. --fresh reviews it again."}))
            return

    skips = [g for g in cfg["skip"] if not re.search(r"[\x00-\x1f\x7f'\"`]", g)]
    excludes = [f":(exclude,glob,icase){g}" for g in skips]
    all_rows = changed_raw(diff_from, target)
    links = symlinks_in(all_rows)
    skipped = [p for p, _ in all_rows if matches(p, skips)]
    if any(is_high(p, cfg, links) for p in skipped):
        # skip never hides a High-risk file: exclude the skipped files that aren't High by name instead
        excludes = [f":(exclude,literal){p}" for p in skipped if not is_high(p, cfg, links)]
    numstat = git("diff", "--numstat", "--no-renames", "-z", diff_from, target, "--", ".", *excludes)
    files, added, removed = [], 0, 0
    for rec in numstat.split("\0"):
        if rec.count("\t") >= 2:
            a, r, path = rec.split("\t", 2)
            files.append(path)
            added += int(a) if a.isdigit() else 0
            removed += int(r) if r.isdigit() else 0

    if not files:
        print(json.dumps({"stop": True, "round": round_no,
                          "message": "Nothing to review: no changes in scope (" + label + ")"
                                     + (" since the last reviewed round; --fresh reviews the whole change again."
                                        if incremental else ".")}))
        return

    high = [f for f in files if is_high(f, cfg, links)]
    hint = security_hint(git("diff", "-U0", diff_from, target, "--", ".", *excludes))
    if args.depth:
        depth = args.depth
    elif any(matches(f, cfg["high"]) for f in files):
        depth = "deep"  # your own High-risk paths get a deep review whatever depth says
    elif cfg["depth"] != "auto":
        depth = cfg["depth"]
    elif all(f.lower().endswith(DOC_EXT) for f in files) or added + removed <= cfg["quick_max_lines"]:
        depth = "quick"
    else:
        depth = "standard"
    if high and depth == "quick":
        depth = "standard"  # a built-in High-risk path (a manifest, CI, CLAUDE.md) is never only skimmed
    security = bool(high) or {"always": True, "never": False}.get(cfg["security"], hint or depth == "deep")

    state = findings_state(events)
    in_scope = set(files)
    mine = {f["id"] for f in change_findings(events, change_runs(events, branch, base, db))}
    prior = [f for f in state.values() if f.get("file") in in_scope and (
        (f["outcome"] is None and f["id"] in mine) or f["outcome"] in DISMISSED)]
    prior_lines = [f"{f['id']} [{f['outcome'] or 'open'}] {f['file']}:{f.get('line', '?')} {f.get('title', '')}"
                   + (f" -- {f['reason']}" if f.get("reason") else "") for f in prior[-30:]]

    guide = review_md()
    quoted = [shlex.quote(x) for x in excludes]
    run_id = "R-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    run = {"type": "run", "run": run_id, "ts": now(), "cycle": cycle_id or run_id, "new_work": new_work,
           "branch": branch, "base": base, "target": target, "tree": target_tree, "patch_id": whole_patch,
           "from": diff_from, "label": label, "round": round_no, "incremental": incremental, "depth": depth,
           "security": security, "files": len(files), "lines": added + removed, "rev": cfg["rev"],
           "max_rounds": cfg["max_rounds"], "max_nits": cfg["max_nits"]}
    if args.fresh:
        run["fresh"] = True
    with open(pending_path(), "w") as f:
        json.dump(run, f)

    print(json.dumps({
        **{k: run[k] for k in ("run", "label", "round", "incremental", "depth", "security", "lines")},
        "max_rounds": cfg["max_rounds"], "max_nits": cfg["max_nits"],
        "diff_cmd": " ".join(["git diff", diff_from, target, "-- ."] + quoted),
        "change_diff_cmd": " ".join(["git diff", base, target, "-- ."] + quoted),
        "read_files": "from the working tree" if worktree else f"with `git show {target}:<path>`",
        "files": files[:60] + ([f"... and {len(files) - 60} more"] if len(files) > 60 else []),
        "high_files": high,
        "tier": risk_tier(files, cfg, links),
        "review_md": guide is not None,
        "checklist": [f"{i}. {line}" for i, line in enumerate(review_checklist(guide), 1)],
        "claude_md": claude_md_files(files),
        "security_hint": hint,
        "check": cfg["check"],
        "prior_findings": prior_lines,
        "open_to_recheck": [l for l in prior_lines if "[open]" in l] if incremental else []}, indent=1))


def cmd_check(args):
    """Print the project's check command. Never runs it: the command comes from the repo, so Claude runs it through
    the normal permission prompt."""
    cfg = load_config()
    if not cfg["check"]:
        print(f"No check command is configured, and none can be inferred from the manifest. Set `check` in "
              f"{CONFIG_PATH} to the command that builds and tests the project.")
        sys.exit(3)
    print(cfg["check"])


def text_field(value, cap):
    return "" if value is None else str(value)[:cap]


def record_problem(data):
    """What is wrong with a `record` payload, or None. Checked before anything is written, so a bad payload records
    nothing and can be sent again."""
    if not isinstance(data, dict):
        return "the payload must be a JSON object."
    for key in ("findings", "resolved_by_change", "thin"):
        if key in data and not isinstance(data[key], list):
            return f"`{key}` must be a list."
    for i, f in enumerate(data.get("findings", [])):
        if not isinstance(f, dict) or not all(isinstance(f.get(k), str) and f.get(k) for k in ("file", "title")):
            return f"findings[{i}] must be an object with a non-empty `file` and `title`."
    return None


def cmd_record(args):
    try:
        with open(pending_path()) as f:
            run = json.load(f)
    except (OSError, ValueError):
        sys.exit("No pending round; run `scope` first.")
    try:
        data = json.loads(take_input(args.file) if args.file else sys.stdin.read())
    except ValueError as e:
        sys.exit(f"record: the payload isn't valid JSON ({e}); write it again.")
    problem = record_problem(data)
    if problem:
        sys.exit(f"record: {problem}")
    events = load_events()
    state = findings_state(events)
    next_no = highest_id("F") + 1

    new = []
    for i, f in enumerate(data.get("findings", [])):
        sev, cat = f.get("severity"), f.get("category")
        line = f.get("line")
        new.append({"type": "finding", "id": f"F-{next_no + i}", "ts": now(), "run": run["run"],
                    "branch": run["branch"], "file": f["file"], "line": line if isinstance(line, int) else None,
                    "severity": sev if sev in SEVERITIES else "important",
                    "category": cat if cat in CATEGORIES else "logic",
                    "title": f["title"][:160], "evidence": text_field(f.get("evidence"), 500),
                    "fix": text_field(f.get("fix"), 300), "votes": text_field(f.get("votes"), 10) or None,
                    "verified": text_field(f.get("verified"), 300)})
    db = default_branch()
    # the change's own findings, including those from rounds it had on the default branch before it moved here
    mine = change_findings(events, change_runs(events, run["branch"], run["base"], db))
    mine_ids = {f["id"] for f in mine}
    autofixed = []
    for raw in data.get("resolved_by_change", []):
        fid = norm_id(raw)
        if fid and fid in mine_ids and state[fid]["outcome"] is None:
            autofixed.append({"type": "outcome", "id": fid, "ts": now(), "outcome": "fixed",
                              "by": "auto", "reason": "no longer present on re-review"})
    if data.get("check"):
        run["check"] = text_field(data["check"], 200)
    # compliance with REVIEW.md, measured before the orchestrator trims anything
    for key in ("nits_found", "rejected", "rejected_guide"):
        if isinstance(data.get(key), int) and not isinstance(data.get(key), bool):
            run[key] = data[key]
    if data.get("thin"):
        run["thin"] = [str(x)[:20] for x in data["thin"][:5]]
    try:
        candidates = int(data.get("candidates", len(new)))
    except (TypeError, ValueError, OverflowError):
        candidates = len(new)
    counts = Counter(f["severity"] for f in new)
    run.update(candidates=candidates, reported=len(new), important=counts["important"], nits=counts["nit"])
    append(run, *new, *autofixed)
    os.remove(pending_path())

    detail = ", ".join(f"{counts[s]} {s}" for s in SEVERITIES if counts[s])
    print(f"{len(new)} finding{'s' if len(new) != 1 else ''}" + (f" ({detail})" if detail else "")
          + f". Round {run['round']}, {run['depth']}: {candidates} candidates, {len(new)} verified."
          + (f" {len(autofixed)} earlier finding(s) cleared by the change." if autofixed else ""))
    print("Round is clean: no Important findings." if is_clean(run) else "Important findings: the loop goes on.")
    if run.get("thin"):
        print(f"Thin: the {', '.join(run['thin'])} finder(s) came back empty twice without showing what they checked, "
              "so this round covered less than its result shows.")
    cleared = {a["id"] for a in autofixed}
    still = [f for f in mine if f["outcome"] is None and f["severity"] != "pre-existing" and f["id"] not in cleared]
    if still:
        print(f"Still open from earlier rounds: {', '.join(f['id'] for f in still)}.")
        for f in still:
            print(fmt_finding(f) + (f"\n   fix: {f['fix']}" if f.get("fix") else ""))
    for f in new:
        print(fmt_finding(f) + (f"\n   fix: {f['fix']}" if f["fix"] else ""))


def cmd_resolve(args):
    if args.outcome not in OUTCOMES:
        sys.exit(f"--as must be one of {', '.join(OUTCOMES)}")
    if args.outcome != "fixed" and not args.reason:
        sys.exit("A reason is required unless the outcome is 'fixed'.")
    state = findings_state(load_events())
    ids = [norm_id(i) or i for i in args.ids]
    missing = [i for i in ids if i not in state]
    if missing:
        sys.exit(f"Unknown finding(s): {', '.join(missing)}")
    commit = None
    if args.commit:
        commit = git("rev-parse", "--verify", "--quiet", f"{args.commit}^{{commit}}", check=False)
        if not commit:
            sys.exit(f"--commit {args.commit!r} doesn't name a commit.")
    # the tree a fix left: the next round compares against it to tell fixes from new work
    tree = snapshot_tree() if args.outcome == "fixed" else None
    append(*[{"type": "outcome", "id": i, "ts": now(), "outcome": args.outcome, "reason": args.reason or "",
              "by": args.by, "commit": commit, **({"tree": tree} if tree else {})} for i in ids])
    print(f"Recorded {args.outcome} for {', '.join(ids)}.")


def cmd_open(args):
    events = load_events()
    branch, db = current_branch(), default_branch()
    if args.all:
        rows = [f for f in findings_state(events).values() if f["outcome"] is None]
    else:
        base, _ = cycle_base(events, branch, None) if has_commits() else (None, None)
        rows = [f for f in change_findings(events, change_runs(events, branch, base, db)) if f["outcome"] is None]
    rows = [f for f in rows if f.get("severity") != "pre-existing" and (not args.important or f["severity"] == "important")]
    print(f"{len(rows)} open finding(s)" + ("" if args.all else " in this change") + ".")
    for f in rows:
        print(fmt_finding(f) + (f"\n   fix: {f['fix']}" if f.get("fix") else ""))


def cmd_backlog(args):
    """Pre-existing findings deferred by review: old bugs worth fixing in their own change."""
    rows = [f for f in findings_state(load_events()).values() if f["outcome"] == "deferred"]
    print(f"{len(rows)} deferred pre-existing finding(s).")
    for f in rows:
        print(fmt_finding(f))


def pct(n, d):
    return f"{100 * n / d:.0f}%" if d else "-"


def cmd_stats(args):
    events = load_events()
    cfg = load_config()
    state = findings_state(events)
    runs = [e for e in events if e["type"] == "run"]
    findings = list(state.values())
    if not findings and not runs:
        print("Ledger is empty.")
        return

    def table(title, key):
        groups, labeled = defaultdict(Counter), defaultdict(Counter)
        for f in findings:
            groups[key(f)][f["outcome"] or "open"] += 1
            if f["outcome"] in JUDGED and f.get("by") in LABELED_BY:
                labeled[key(f)][f["outcome"]] += 1
        print(f"\n{title}: reported fixed wrong intent wontfix deferred merged open | labeled useful noise")
        for name, c in sorted(groups.items(), key=lambda kv: -sum(kv[1].values())):
            lab = labeled[name]
            n = sum(lab.values())
            print(f"  {str(name):<16} {sum(c.values()):>4} {c['fixed']:>5} {c['wrong']:>5} {c['intentional']:>6} "
                  f"{c['wontfix']:>7} {c['deferred']:>8} {c['merged-past']:>6} {c['open']:>4} | {n:>7} "
                  f"{pct(lab['fixed'], n):>6} {pct(lab['wrong'] + lab['wontfix'], n):>5}")

    print(f"{len(runs)} runs, {len(findings)} findings. REVIEW.md version now: {cfg['rev'] or 'none'}.\n"
          "useful and noise count only labeled outcomes, decided by you or cleared by a later round (auto); "
          "agent-decided outcomes are unlabeled, and so are nits merged past. useful = fixed/labeled, "
          "noise = (wrong+wontfix)/labeled.")
    table("By severity", lambda f: f.get("severity"))
    table("By category", lambda f: f.get("category"))
    run_rev = {r["run"]: r.get("rev") for r in runs}
    table("By REVIEW.md version", lambda f: run_rev.get(f.get("run")) or "none")
    table("By decider (trust user > auto > agent)", lambda f: f.get("by") or "open")
    checked = [f for f in findings if f.get("prev_by") == "agent" and f.get("by") == "user"]
    if checked:
        agree = sum(1 for f in checked if f["prev"] == f["outcome"])
        print(f"Spot-checks: you agreed with {agree}/{len(checked)} agent decisions.")

    cycles = defaultdict(list)
    for r in runs:
        cycles[r.get("cycle") or r["run"]].append(r)
    # a clean last round doesn't pass the cycle while one of its Important findings is still open
    open_runs = {f.get("run") for f in findings if f["outcome"] is None and f.get("severity") == "important"}
    passed = [c for c in cycles.values() if is_clean(c[-1]) and not open_runs & {r["run"] for r in c}]
    capped = [c for c in cycles.values() if not is_clean(c[-1])
              and len(c) >= c[-1].get("max_rounds", cfg["max_rounds"])]
    if cycles:
        mean = f"{sum(len(c) for c in passed) / len(passed):.2f}" if passed else "-"
        print(f"\nConvergence: {len(cycles)} review cycle(s); {len(passed)} passed, "
              f"{pct(sum(1 for c in passed if len(c) == 1), len(passed))} of those on the first round; "
              f"mean rounds to pass {mean}; {len(capped)} hit the round cap; "
              f"{len(cycles) - len(passed) - len(capped)} still open.")

    # "We check separately whether the reviewer actually follows it."
    measured = [r for r in runs if "rejected_guide" in r]
    if measured:
        candidates = sum(r["candidates"] for r in measured if isinstance(r.get("candidates"), int))
        guide = sum(r["rejected_guide"] for r in measured)
        rejected = sum(r.get("rejected", 0) for r in measured)
        over = sum(1 for r in measured if r.get("nits_found", 0) > r.get("max_nits", cfg["max_nits"]))
        print(f"REVIEW.md compliance ({len(measured)} runs): finders raised {candidates} candidates; the verifier "
              f"rejected {rejected} ({pct(rejected, candidates)}), {guide} of them ({pct(guide, candidates)} of all "
              f"candidates) because REVIEW.md says not to report them or calls them intentional; {over} run(s) found "
              f"more nits than the cap.")
    thin = [r for r in runs if r.get("thin")]
    tested = [r for r in runs if r.get("depth") in ("standard", "deep")]  # quick rounds don't run the thin test
    if tested:
        rates = []
        for lens in ("change", "system", "security"):
            ran = [r for r in tested if lens != "security" or r.get("security")]
            n = sum(1 for r in ran if lens in r.get("thin", []))
            rates.append(f"{lens} {n}/{len(ran)} ({pct(n, len(ran))})")
        print(f"Thin finders: {len(thin)} run(s) had a finder come back empty twice without showing what it checked. "
              f"Per lens over standard and deep rounds: {', '.join(rates)}.")

    escapes = [e for e in events if e["type"] == "escape"]
    if escapes:
        dismissed = [e for e in escapes if e.get("finding") and
                     state.get(e["finding"], {}).get("outcome") in DISMISSED]
        print(f"Escapes: {len(escapes)} bug(s) shipped past review; {len(dismissed)} had been flagged and dismissed.")
    # an eval scores REVIEW.md without changing it, so it doesn't restart the count of findings since the last tuning
    learns = [e for e in events if e["type"] == "learn" and not e.get("eval_only") and e.get("summary") != LEGACY_EVAL]
    if learns:
        last = learns[-1]
        since = sum(1 for f in findings if f["outcome"] and f.get("resolved_ts", "") > last["ts"])
        print(f"Last tuning: {last['ts'][:10]} ({last.get('rev_before')} -> {last.get('rev_after')}): {last['summary']}"
              + (f"; eval {last['eval']}" if last.get("eval") else "") + f". {since} finding(s) resolved since.")


def cmd_reasons(args):
    """Findings with the given outcomes and why, newest last. --limit 0 shows all of them."""
    rows = [f for f in findings_state(load_events()).values() if f["outcome"] in args.outcomes.split(",")]
    for f in (rows[-args.limit:] if args.limit > 0 else rows):
        print(f"{f['id']} {f['outcome']:<11} {f.get('by') or '-':<5} {f.get('category', '?'):<14} {f.get('file')}  "
              f"{f.get('title', '')}" + (f" -- {f['reason']}" if f.get("reason") else ""))
    if not rows:
        print("No findings with those outcomes.")


def cmd_spotcheck(args):
    """Agent-decided outcomes you have not confirmed yet: dismissals first, then fixes."""
    rows = [f for f in findings_state(load_events()).values() if f.get("by") == "agent"]
    rows.sort(key=lambda f: (f["outcome"] == "fixed", f.get("resolved_ts", "")))
    print(f"{len(rows)} agent decision(s) unconfirmed; showing {min(args.n, len(rows))}.")
    for f in rows[:args.n]:
        print(f"{fmt_finding(f)}\n   agent: {f['outcome']}" + (f" -- {f['reason']}" if f.get("reason") else "")
              + f"\n   evidence: {f.get('evidence', '')}")


def cmd_escape(args):
    events = load_events()
    finding = None
    if args.finding:
        finding = norm_id(args.finding)
        if not finding:
            sys.exit(f"--finding {args.finding!r} isn't a finding id (F-<n>).")
    e = {"type": "escape", "id": f"E-{highest_id('E') + 1}", "ts": now(),
         "commit": git("rev-parse", "--verify", f"{args.commit}^{{commit}}"),
         "fix": git("rev-parse", "--verify", f"{args.fix}^{{commit}}") if args.fix else None, "file": args.file,
         "summary": args.summary, "finding": finding}
    append(e)
    print(f"Recorded {e['id']} (introduced in {e['commit'][:10]}).")
    f = findings_state(events).get(finding) if finding else None
    if f and f["outcome"] in DISMISSED:
        print(f"Note: {f['id']} flagged this and was dismissed as {f['outcome']} ({f.get('reason')}).")


def cmd_evals(args):
    events = load_events()
    escapes = [e for e in events if e["type"] == "escape"]
    print(f"{len(escapes)} eval case(s) from escapes.")
    for e in escapes:
        print(f"{e['id']} {e['commit'][:10]}^..{e['commit'][:10]}  {e.get('file') or ''}  {e['summary']}")
    for l in [e for e in events if e["type"] == "learn" and e.get("eval")][-3:]:
        print(f"eval {l['ts'][:10]} rev {l.get('rev_after')}: {l['eval']}")


def cmd_clean_sample(args):
    """Recent commits on the default branch that were never reverted and never introduced an escape, for counting the
    reviewer's false alarms. That doesn't make them bug-free, so they are unlabeled: a finding on one is a false alarm
    only once you say it isn't real."""
    db = default_branch()
    if not db:
        sys.exit("No default branch found.")
    log = git("log", "--no-merges", "--format=%H%x09%s%x09%b%x1e", origin_default(db) or db, "-n", "300")
    entries = [e.strip().split("\t", 2) for e in log.split("\x1e") if e.strip()]
    reverted = set()
    for e in entries:
        reverted.update(re.findall(r"This reverts commit ([0-9a-f]{7,40})", e[2] if len(e) > 2 else ""))
    escaped = {e["commit"] for e in load_events() if e["type"] == "escape"}
    picked = []
    for sha, subject, *_ in entries:
        if subject.startswith("Revert ") or any(sha.startswith(r) for r in reverted) or sha in escaped:
            continue
        # -z: without it git C-quotes non-ASCII paths ("caf\303\251.md"), and the quote hides the extension
        paths = [p for p in git("show", "--name-only", "-z", "--format=", sha).split("\0") if p]
        if not paths or all(p.lower().endswith(DOC_EXT) for p in paths):
            continue
        picked.append(f"{sha[:10]}  {subject}")
        if len(picked) == args.n:
            break
    print(f"{len(picked)} unlabeled commit(s) on {db}, never reverted or tied to an escape. That doesn't make them "
          "bug-free: a finding on one is a false alarm only if you say it isn't real.")
    for line in picked:
        print(line)


def cmd_learned(args):
    rev = load_config()["rev"]
    append({"type": "learn", "ts": now(), "rev_before": args.rev_before, "rev_after": rev,
            "summary": args.summary, "eval": args.eval, **({"eval_only": True} if args.eval_only else {})})
    print(f"Recorded eval of REVIEW.md {rev}." if args.eval_only
          else f"Recorded tuning (REVIEW.md {args.rev_before} -> {rev}).")


def cmd_config(args):
    print(json.dumps({**load_config(), "always_high": list(ALWAYS_HIGH)}, indent=1))


def find_pr_template():
    """The repo's pull request template, in any location GitHub reads (names are case-insensitive)."""
    for folder in (".github", ".", "docs"):
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            path = os.path.normpath(os.path.join(folder, name))
            if name.lower() == "pull_request_template.md" and os.path.isfile(path):
                return path
            if name.lower() == "pull_request_template" and os.path.isdir(path):
                templates = sorted(f for f in os.listdir(path) if f.lower().endswith(".md"))
                if templates:
                    return os.path.join(path, templates[0])
    return None


def github_remote():
    return bool(re.search(r"github\.com[:/]", git("remote", "get-url", "origin", check=False)))


def reviewed_change(events, base, tree):
    """The review that covers the change base..tree, whatever branch it ran on (ship may have just moved the commits off
    the default branch): ("current", run) when a round saw exactly this tree, ("rebased", run) when a round saw the
    same patch on an older base, else (None, None)."""
    runs = [e for e in events if e["type"] == "run"]
    same = [r for r in runs if r.get("tree") == tree]
    if same:
        return "current", same[-1]
    pid = patch_id(base, tree)
    same = [r for r in runs if pid and r.get("patch_id") == pid]
    return ("rebased", same[-1]) if same else (None, None)


def cmd_ship_check(args):
    """Is the change ready for a pull request? Prints JSON for /solo-review:ship. Uncommitted changes count as part of
    the change, since ship commits them first."""
    cfg = load_config()
    branch, db = current_branch(), default_branch()
    out = {"branch": branch, "default": db, "on_default": branch in (db, "HEAD"), "merge": cfg["merge"],
           "check": cfg["check"], "origin": git("remote", "get-url", "origin", check=False) or None,
           "github": github_remote(), "gh": shutil.which("gh") is not None,
           "pr_template": find_pr_template(), "problems": []}
    if not has_commits():
        out["problems"].append("no commits yet")
        print(json.dumps(out, indent=1))
        return
    if not db:
        out["problems"].append("no default branch: there is no main or master, and origin/HEAD isn't set")
        print(json.dumps(out, indent=1))
        return
    upstream = origin_default(db)
    out["origin_default"] = upstream
    base = git("merge-base", "HEAD", upstream) if upstream else default_merge_base(db)
    out["base"] = base
    out["head"] = git("rev-parse", "HEAD")
    out["commits"] = git("log", "--format=%h %s", "--reverse", f"{base}..HEAD").splitlines()
    out["uncommitted"] = [p for p in uncommitted_paths() if not p.startswith(f"{SCRATCH}/")]
    tree = snapshot_tree()  # git diff takes trees as well as commits
    rows = changed_raw(base, tree)
    files, links = [p for p, _ in rows], symlinks_in(rows)
    if not files:
        out["problems"].append(f"nothing to ship: no changes against {upstream or db}")
    out["files"] = files[:60]
    out["tier"] = risk_tier(files, cfg, links)
    out["high_files"] = [f for f in files if is_high(f, cfg, links)]
    out["security_hint"] = security_hint(git("diff", "-U0", base, tree, check=False))

    events = load_events()
    status, run = reviewed_change(events, base, tree)
    if run is None:
        mine = change_runs(events, branch, base, db)
        status, run = ("stale", mine[-1]) if mine else ("never", None)
    out["reviewed"] = status  # current | rebased | stale | never
    if run:
        out["review_run"] = run["run"]
        out["review_branch"] = run.get("branch")
        if status == "stale" and is_commit(run.get("target")):
            # only the change's own files: a rebase brings in the default branch's changes too
            mine = set(files)
            out["changed_since_review"] = [p for p, _ in changed_raw(run["target"], tree) if p in mine][:30]
        found = change_findings(events, change_runs(events, run.get("branch"), run.get("base"), db))
        open_ = [f for f in found if f["outcome"] is None]
        out["open_important"] = [f["id"] for f in open_ if f.get("severity") == "important"]
        out["open_nits"] = [f["id"] for f in open_ if f.get("severity") == "nit"]
        out["thin"] = any(r.get("thin") for r in change_runs(events, run.get("branch"), run.get("base"), db))
    if status in ("stale", "never"):
        out["problems"].append("never reviewed" if status == "never" else "changed since the last review round")
    if out.get("open_important"):
        out["problems"].append(f"open Important findings: {', '.join(out['open_important'])}")
    print(json.dumps(out, indent=1))


def cell(text):
    """Make text safe for one Markdown table cell: single line, rendered literally (no HTML, links, mentions or code
    spans), pipes escaped."""
    t = " ".join(str(text).split())
    for ch, ent in (("&", "&amp;"), ("<", "&lt;"), (">", "&gt;"), ("[", "&#91;"), ("]", "&#93;"),
                    ("@", "&#64;"), ("`", "&#96;")):
        t = t.replace(ch, ent)
    return t.replace("|", "\\|")


def cmd_pr_summary(args):
    """Markdown review summary for the pull request's Review section, for the change ship-check matched."""
    events = load_events()
    run = next((e for e in events if e["type"] == "run" and e["run"] == args.run), None)
    if not run:
        sys.exit(f"No run {args.run!r} in the ledger.")
    runs = change_runs(events, run.get("branch"), run.get("base"), default_branch())
    rows = change_findings(events, runs)
    thin = [r for r in runs if r.get("thin")]
    checks = [r["check"] for r in runs if r.get("check")]
    print(f"{len(runs)} round(s), {len(rows)} finding(s), {sum(1 for f in rows if f['outcome'] is None)} open."
          + (f" Last check: {cell(checks[-1])}." if checks else "")
          + (f" In {len(thin)} round(s) a finder returned no findings twice without showing what it checked, so "
             "those rounds covered less than their result shows." if thin else "") + "\n")
    if not rows:
        return
    print("| Finding | Severity | Where | Outcome |\n|---|---|---|---|")
    for f in rows:
        outcome = f["outcome"] or "open"
        if f["outcome"]:
            outcome += f" ({f.get('by')}" + (f", {f['commit'][:7]}" if f.get("commit") else "") + ")"
            if f.get("reason"):
                outcome += f": {f['reason']}"
        where = " ".join(f"{f.get('file')}:{f.get('line') or '?'}".split()).replace("`", "").replace("|", "\\|")
        print(f"| {f['id']} {cell(f.get('title', ''))} | {f.get('severity')} | `{where}` | {cell(outcome)} |")
    # what each finding rests on, so you can judge it without the agent session
    basis = [(f["id"], [(label, f.get(key)) for label, key in
                        (("Evidence", "evidence"), ("Verifier", "verified"), ("Fix", "fix")) if f.get(key)])
             for f in rows]
    if any(parts for _, parts in basis):
        print("\n<details><summary>Evidence for each finding</summary>\n")
        for fid, parts in basis:
            if parts:
                print(f"- **{fid}** " + " ".join(f"{label}: {cell(text)}" for label, text in parts))
        print("\n</details>")


# folder and file names that usually hold code where one missed bug is expensive
HIGH_HINTS = re.compile(r"(?:^|/)(?:auth\w*|login|sessions?|billing|payments?|stripe|checkout|migrations?|security|"
                        r"crypto|secrets?|permissions?|admin|install\w*\.sh|release\w*\.sh|deploy\w*)(?:/|$)", re.I)


# Things that exist in many projects and almost never belong in git: setup ignores them before a first commit
IGNORE_SUGGESTIONS = (
    ("node_modules/", "installed packages"), ("dist/", "build output"), ("build/", "build output"),
    ("target/", "build output"), (".venv/", "a virtualenv"), ("venv/", "a virtualenv"),
    ("__pycache__/", "Python caches"), (".pytest_cache/", "test caches"), (".godot/", "Godot's editor cache"),
    (".DS_Store", "macOS folder data"), (".env", "secrets"), (".env.local", "secrets"),
)
WALK_SKIP = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "target", ".godot"}


def project_files(is_repo):
    """The project's files, relative: git's tracked and untracked-but-not-ignored files in a repo, else a walk that
    skips the usual dependency and build folders."""
    if is_repo:
        out = git("ls-files", "-z", "--cached", "--others", "--exclude-standard", check=False)
        return [p for p in out.split("\0") if p]
    files = []
    for d, dirs, names in os.walk("."):
        dirs[:] = [x for x in dirs if x not in WALK_SKIP]
        files += [os.path.relpath(os.path.join(d, n)) for n in names]
        if len(files) > 20000:
            break
    return files


def ignore_gaps(is_repo):
    """IGNORE_SUGGESTIONS entries that exist here and that nothing ignores yet."""
    listed = set()
    if not is_repo:
        listed = {l.strip().strip("/") for l in (read_capped(".gitignore", "replace") or "").splitlines()}
    gaps = []
    for pattern, why in IGNORE_SUGGESTIONS:
        path = pattern.rstrip("/")
        if not os.path.lexists(path):
            continue
        ignored = (subprocess.run(["git", "check-ignore", "-q", path], capture_output=True).returncode == 0
                   if is_repo else path in listed)
        if not ignored:
            gaps.append({"pattern": pattern, "why": why})
    return gaps


# ---------------------------------------------------------------- v1 projects

V1_LEDGER = os.path.join(".review", "ledger.jsonl")
V1_DROPPED = ("gate", "branch", "workflow", "low", "trusted")  # v1 settings v2 has no use for
V1_TEMPLATE_GLOBS = ("**/install.sh", "**/release.sh", "**/auth/**", "**/*.min.js", "**/*.snap")
V1_HEADINGS = {"what failure looks like here": "What Important means here", "don't flag": "Do not report",
               "intentional patterns": "Intentional"}
V1_PR_HEADINGS = ("## summary", "## changes", "## review", "## testing", "## risk and rollback", "## checklist")


def v1_value(raw):
    """A v1 frontmatter value: quoted (kept whole, # included) or bare (a ` #` starts a comment)."""
    v = raw.strip()
    if v[:1] and v[0] in "'\"":
        end = v.find(v[0], 1)
        return v[1:end] if end > 0 else v[1:]
    return re.sub(r"(?:^|\s+)#.*$", "", v).strip()  # `key:   # comment` is an empty value: a list follows


def v1_frontmatter(text):
    """(settings, body) from a v1 REVIEW.md: flat keys and string lists between --- lines. None when there is none."""
    m = re.match(r"﻿?---\r?\n(.*?)\r?\n---\r?\n", text, re.S)
    if not m:
        return None, text
    cfg, key = {}, None
    for raw in m.group(1).splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        item = re.match(r"\s*-\s+(.*)", raw)
        if item:
            if key and isinstance(cfg.get(key), list):
                cfg[key].append(v1_value(item.group(1)))
            continue
        key, _, value = raw.partition(":")
        key, value = key.strip(), v1_value(value)
        if value.startswith("[") and value.endswith("]"):  # an inline list: `skip: ["a", "b"]` or `skip: []`
            cfg[key] = [v1_value(x) for x in value[1:-1].split(",") if x.strip()]
        else:
            cfg[key] = [] if not value else int(value) if value.isdigit() else value
    return cfg, text[m.end():]


def v1_migration(files):
    """What a v1 setup left here and what v2 makes of it, or None if there is no sign of v1. Reads only."""
    text = read_capped("REVIEW.md", "replace")
    front, body = v1_frontmatter(text) if text else (None, None)
    pr = find_pr_template()
    pr_text = (read_capped(pr, "replace") or "").lower() if pr else ""
    v1_pr = bool(pr) and all(h in pr_text for h in V1_PR_HEADINGS)
    claude_md = read_capped("CLAUDE.md", "replace") or ""
    worktree_lines = [l for l in claude_md.splitlines() if "worktree" in l.lower() and "solo-review" in l.lower()]
    if front is None and not os.path.isdir(".review") and not v1_pr and not worktree_lines:
        return None
    settings, dropped_keys, dropped_globs = {}, [], []
    for k, v in (front or {}).items():
        if k == "sensitive":  # v1's older name for `high`
            k = "high"
        if k in V1_DROPPED:
            dropped_keys.append(k)
        elif k in ("high", "skip") and isinstance(v, list):
            for g in v:
                # v1's template globs, kept only where they match something here
                if g in V1_TEMPLATE_GLOBS and not any(matches(p, [g]) for p in files):
                    dropped_globs.append(g)
                elif g not in settings.get(k, []):
                    settings.setdefault(k, []).append(g)
        elif k in DEFAULTS and v != DEFAULTS[k] and v != "":
            settings[k] = v
    review_md = None
    if body is not None:
        lines = []
        for line in body.splitlines():
            h = re.match(r"(#+)\s*(.*?)\s*:?\s*$", line)
            if h and h.group(2).lower() in V1_HEADINGS:
                line = f"{h.group(1)} {V1_HEADINGS[h.group(2).lower()]}"
            lines.append(line.replace("/solo-review:review-learn", "/solo-review:learn"))
        review_md = "\n".join(lines).lstrip("\n") + "\n"
        if not re.search(r"^#+\s*cap the nits", review_md, re.I | re.M):
            nits = settings.get("max_nits", DEFAULTS["max_nits"])
            cap = (f"## Cap the nits\nReport at most {nits} nits, and only ones worth a commit. Nits never block a "
                   "merge.\n")
            ev = re.search(r"^#+\s*evidence", review_md, re.I | re.M)
            review_md = review_md[:ev.start()] + cap + "\n" + review_md[ev.start():] if ev else review_md + "\n" + cap
    ledger_events = 0
    try:
        with open(V1_LEDGER, errors="replace") as f:
            ledger_events = sum(1 for l in f if l.strip())
    except OSError:
        pass
    return {"review_dir": os.path.isdir(".review"),
            "review_dir_tracked": git("ls-files", ".review", check=False).split(),
            "ledger_events": ledger_events, "settings": settings, "dropped_keys": dropped_keys,
            "dropped_globs": dropped_globs, "review_md": review_md, "pr_template_v1": pr if v1_pr else None,
            "claude_md_worktree_lines": worktree_lines}


def cmd_import_v1(args):
    """Copy a v1 ledger's events (.review/ledger.jsonl) into the v2 ledger, skipping any already there. Writes only
    the v2 ledger."""
    try:
        with open(V1_LEDGER, errors="replace") as f:
            lines = [l.strip() for l in f if l.strip()]
    except OSError:
        sys.exit(f"No {V1_LEDGER} here.")
    have = {json.dumps(e, sort_keys=True) for e in load_events()}
    new = []
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if isinstance(e, dict) and "type" in e and json.dumps(e, sort_keys=True) not in have:
            new.append(e)
    if new:
        append(*new)
    print(f"Imported {len(new)} of {len(lines)} v1 event(s) into {ledger_path()}.")


def cmd_setup_info(args):
    """What /solo-review:setup needs, as JSON. Reads only, and works before the folder is a git repository."""
    is_repo = repo_root() is not None
    db = default_branch() if is_repo else None
    tracked = project_files(is_repo)
    candidates = []
    for p in tracked:
        m = HIGH_HINTS.search(p)
        if m and not matches(p, ALWAYS_HIGH):
            # a matching folder suggests everything in it; a matching file suggests itself
            g = p[:m.end()] + "**" if p[m.end() - 1] == "/" else p
            if g not in candidates:
                candidates.append(g)
    claude_md = next((p for p in ("CLAUDE.md", os.path.join(".claude", "CLAUDE.md")) if os.path.isfile(p)), None)
    text = read_capped(claude_md, "replace") if claude_md else None
    manifests = [p for p in ("package.json", "Cargo.toml", "go.mod", "pyproject.toml", "setup.cfg", "Makefile",
                             "project.godot", "Gemfile", "composer.json", "build.gradle", "pom.xml") if os.path.exists(p)]
    home = os.path.realpath(os.path.expanduser("~"))
    print(json.dumps({
        "root": os.getcwd(), "name": os.path.basename(os.getcwd()), "is_repo": is_repo,
        # a git repository of the home folder or / would sweep in everything: setup asks first there
        "unsafe_root": os.path.realpath(os.getcwd()) in (home, "/"),
        "default_branch": db, "branch": current_branch() if is_repo else None,
        "has_commits": is_repo and has_commits(), "files": len(tracked),
        "origin": (git("remote", "get-url", "origin", check=False) or None) if is_repo else None,
        "github": is_repo and github_remote(), "gh": shutil.which("gh") is not None,
        "gitignore": os.path.isfile(".gitignore"), "ignore_gaps": ignore_gaps(is_repo),
        "uncommitted": uncommitted_paths()[:40] if is_repo else [],
        "unpushed": int(git("rev-list", "--count", f"{origin_default(db)}..HEAD", check=False) or 0)
                    if is_repo and origin_default(db) and has_commits() else None,
        "ci_files": [p for p in tracked if matches(p, [".github/workflows/**", "**/.gitlab-ci*.yml", "**/.circleci/**"])],
        "review_md": os.path.isfile("REVIEW.md"), "config": os.path.isfile(CONFIG_PATH),
        "config_now": {k: v for k, v in load_config().items() if k in DEFAULTS},
        "ledger_runs": sum(1 for e in load_events() if e["type"] == "run") if is_repo else 0,
        "v1": v1_migration(tracked),
        "claude_md": claude_md,
        # a section that lists the commands to run counts, whatever its name
        "claude_md_has_verify": bool(text and re.search(
            r"^#+\s*(verify|verification|checks?|testing|tests|commands|development)\b", text, re.I | re.M)),
        # whether it already says how changes land: a branch per change, merged through a pull request
        "claude_md_has_git": bool(text and re.search(r"pull request|\bPRs?\b|\bbranch(es)?\b", text, re.I)),
        "pr_template": find_pr_template(), "readme": next((p for p in ("README.md", "README") if os.path.isfile(p)),
                                                          None),
        "manifests": manifests, "inferred_check": infer_check(), "candidate_high": candidates[:15],
        "templates": TEMPLATES}, indent=1))


SECRET_PATTERNS = (
    ("GitHub token", r"\bgh[pousr]_[A-Za-z0-9]{36,}"),
    ("AWS access key", r"\bAKIA[0-9A-Z]{16}\b"),
    ("private key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("Slack token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    ("API key", r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}"),
    ("Google API key", r"\bAIza[0-9A-Za-z_-]{35}"),
)
SECRET_FILES = ("**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*", "**/credentials*",
                "**/.netrc", "**/.pypirc", "**/.npmrc")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
PUBLIC_EMAIL = re.compile(r"(?:noreply\.github\.com|users\.noreply\.|@example\.(?:com|org|net)|@localhost|"
                          r"@test\b|@email\.com|@domain\.com|solo-review@)", re.I)


def cmd_publish_scan(args):
    """What would be published by pushing every commit: secrets and sensitive files in the tracked files or anywhere
    in the history, and the email addresses the files and the commits carry. Secret values are never printed."""
    secret_re = [(kind, re.compile(rx)) for kind, rx in SECRET_PATTERNS]
    found, history, emails = [], {}, set()
    for path in git("ls-files", "-z", check=False).split("\0"):
        text = read_capped(path, "replace") if path else None
        if text is None or "\0" in text[:8000]:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            for kind, rx in secret_re:
                if rx.search(line):
                    found.append({"file": path, "line": n, "kind": kind})
            for e in EMAIL.findall(line):
                if not PUBLIC_EMAIL.search(e):
                    emails.add(e.lower())
    # added lines anywhere in history: a secret deleted later is still published by the push
    log = subprocess.run(["git", "log", "--all", "-p", "--no-ext-diff", "--format=\x01%h", "-n", "5000"],
                         capture_output=True, text=True, errors="replace").stdout
    commit = None
    for line in log.splitlines():
        if line.startswith("\x01"):
            commit = line[1:]
        elif line.startswith("+") and not line.startswith("+++"):
            for kind, rx in secret_re:
                if rx.search(line):
                    history.setdefault(kind, set()).add(commit)
            for e in EMAIL.findall(line):
                if not PUBLIC_EMAIL.search(e):
                    emails.add(e.lower())  # in history, even if gone from the files now
    tracked_secret_files = [p for p in git("ls-files", "-z", check=False).split("\0") if p and matches(p, SECRET_FILES)]
    ever = {p for p in git("log", "--all", "--name-only", "--format=", check=False).splitlines()
            if p and matches(p, SECRET_FILES)}
    identities = sorted({e for e in git("log", "--all", "--format=%ae%n%ce", check=False).splitlines() if e})
    print(json.dumps({
        "secrets": found[:50],
        "secrets_in_history": {k: sorted(v)[:20] for k, v in history.items()},
        "secret_files": tracked_secret_files,
        "secret_files_in_history": sorted(ever - set(tracked_secret_files)),
        "emails": sorted(emails),
        "commit_emails": [e for e in identities if not PUBLIC_EMAIL.search(e)],
        "commit_emails_public": [e for e in identities if PUBLIC_EMAIL.search(e)],
        "clean": not (found or history or tracked_secret_files or ever),
    }, indent=1))


# ---------------------------------------------------------------- branch guard

EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
GIT_VALUE_OPTS = {"-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"}
BRANCH_HINT = "`git switch -c <type>/<short-name>` (feat, fix, refactor, docs or chore)"


def operation_in_progress():
    """A rebase, merge, cherry-pick or revert is underway: HEAD may be detached or on the default branch, and the
    edits and commits that finish it must go through."""
    return any(os.path.exists(git("rev-parse", "--git-path", p, check=False))
               for p in ("rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"))


def enabled():
    """solo-review is set up in this repository: setup ran here (it creates the ledger folder) or its settings exist."""
    return os.path.isfile(CONFIG_PATH) or os.path.isdir(state_dir())


def guarded_default():
    """The default branch's name when the guard applies in the current directory's repo, else None: solo-review is
    set up, there is history (a new repository's first commit has nothing to open a PR against), HEAD is on the
    default branch, and no rebase or merge is underway."""
    if not enabled() or not has_commits() or operation_in_progress():
        return None
    db = default_branch()
    return db if db and current_branch() == db else None


def git_commit_dirs(command, cwd):
    """The folders a shell command runs `git commit` in, read the way a shell splits it: separators inside quotes
    stay in their words, and each command's leading VAR=value words, `env`, and git's own options (-C dir) are
    skipped. Anything it can't split counts as no commit: the guard fails open."""
    if "commit" not in command or "git" not in command:
        return []
    lex = shlex.shlex(command, posix=True, punctuation_chars=";&|\n")
    lex.whitespace, lex.whitespace_split = " \t\r", True
    try:
        tokens = list(lex)
    except ValueError:
        return []
    dirs, words = [], []
    for tok in tokens + [";"]:
        if tok and set(tok) <= set(";&|\n"):
            while words and (words[0] == "env" or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", words[0])):
                words.pop(0)
            if words and os.path.basename(words[0]) == "git":
                d, i = cwd, 1
                while i < len(words) and words[i].startswith("-"):
                    if words[i] == "-C" and i + 1 < len(words):
                        d = os.path.join(d, os.path.expanduser(words[i + 1]))
                        i += 2
                    else:
                        i += 2 if words[i] in GIT_VALUE_OPTS else 1
                if i < len(words) and words[i] == "commit":
                    dirs.append(d)
            words = []
        else:
            words.append(tok)
    return dirs


def guard_reason(payload):
    """Why the tool call in a PreToolUse payload would put a change on the default branch without a PR, or None."""
    tool, ti = payload.get("tool_name"), payload.get("tool_input") or {}
    cwd = payload.get("cwd") or os.getcwd()
    if tool in EDIT_TOOLS:
        path = ti.get("file_path") or ti.get("notebook_path")
        if not isinstance(path, str) or not path:
            return None
        path = os.path.normpath(os.path.join(cwd, os.path.expanduser(path)))
        d = os.path.dirname(path)
        while d and not os.path.isdir(d):  # a new file's folder may not exist yet
            d = os.path.dirname(d)
        r = subprocess.run(["git", "-C", d, "rev-parse", "--show-toplevel"], capture_output=True, text=True)
        if r.returncode:
            return None  # not in a repository
        root = r.stdout.strip()
        os.chdir(root)
        rel = os.path.relpath(os.path.realpath(path), os.path.realpath(root))
        if rel.startswith("..") or rel.split(os.sep)[0] in (".git", SCRATCH):
            return None
        db = guarded_default()
        # an ignored file never reaches a commit, so editing it on the default branch can't skip review
        if not db or subprocess.run(["git", "check-ignore", "-q", "--", rel], capture_output=True).returncode == 0:
            return None
        return (f"solo-review: you're on {db}, and changes reach {db} only through a reviewed PR. Start a branch "
                f"before editing: {BRANCH_HINT}. Uncommitted changes come with you.")
    if tool == "Bash" and isinstance(ti.get("command"), str):
        for d in git_commit_dirs(ti["command"], cwd):
            if not os.path.isdir(d):
                continue
            r = subprocess.run(["git", "-C", d, "rev-parse", "--show-toplevel"], capture_output=True, text=True)
            if r.returncode:
                continue
            os.chdir(r.stdout.strip())
            db = guarded_default()
            if db:
                return (f"solo-review: this commits to {db}, and changes reach {db} only through a reviewed PR. "
                        f"Start a branch first: {BRANCH_HINT}. Your changes come with you.")
    return None


def cmd_guard(args):
    """PreToolUse hook: refuse a file edit or a `git commit` on the default branch of a repository set up for
    solo-review. It is a guard against slips, not a sandbox (an edit made through the shell gets past it), and it
    fails open: anything unexpected allows the call."""
    try:
        reason = guard_reason(json.load(sys.stdin))
    except Exception:
        return
    if reason:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                 "permissionDecisionReason": reason}}))


def cmd_where(args):
    """Where the work is, as JSON: the branch, whether it's the default one, and what isn't on origin yet."""
    db, branch, commits = default_branch(), current_branch(), has_commits()
    up = origin_default(db) if db else None
    print(json.dumps({
        "branch": branch, "default": db, "on_default": bool(db) and branch == db, "has_commits": commits,
        "origin_default": up, "uncommitted": len(uncommitted_paths()),
        "unpushed": int(git("rev-list", "--count", f"{up}..HEAD", check=False) or 0) if up and commits else None,
        "guarded": guarded_default() is not None}, indent=1))


def cmd_enable(args):
    """Mark this repository as set up for solo-review, which turns the branch guard on here."""
    os.makedirs(state_dir(), exist_ok=True)
    print(f"solo-review is on in {os.getcwd()}: edits and commits on {default_branch() or 'the default branch'} "
          "now need a branch first.")


def main():
    p = argparse.ArgumentParser(prog="ledger.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scope")
    s.add_argument("--base")
    s.add_argument("--range", help="A..B or A...B: review commits instead of the working tree")
    s.add_argument("--depth", choices=("quick", "standard", "deep"))
    s.add_argument("--force", action="store_true", help="ignore the round cap for this round")
    s.add_argument("--fresh", action="store_true",
                   help="review the whole change from its base again, not only what changed since the last round")
    s = sub.add_parser("record")
    s.add_argument("--file", help=f"JSON payload inside {SCRATCH}/ (deleted after reading); default stdin")
    s = sub.add_parser("resolve")
    s.add_argument("ids", nargs="+")
    s.add_argument("--as", dest="outcome", required=True)
    s.add_argument("--reason", default="")
    s.add_argument("--by", required=True, choices=("user", "agent"))
    s.add_argument("--commit", help="commit that carries the fix")
    s = sub.add_parser("open")
    s.add_argument("--all", action="store_true")
    s.add_argument("--important", action="store_true")
    sub.add_parser("backlog")
    sub.add_parser("stats")
    s = sub.add_parser("reasons")
    s.add_argument("--outcomes", default=",".join(DISMISSED))
    s.add_argument("--limit", type=int, default=40)
    s = sub.add_parser("spotcheck")
    s.add_argument("--n", type=int, default=3)
    s = sub.add_parser("escape")
    s.add_argument("--commit", required=True, help="commit that introduced the bug")
    s.add_argument("--fix", help="commit that fixed it")
    s.add_argument("--file")
    s.add_argument("--summary", required=True)
    s.add_argument("--finding", help="ledger finding that had flagged it, if any")
    sub.add_parser("evals")
    s = sub.add_parser("clean-sample")
    s.add_argument("--n", type=int, default=3)
    s = sub.add_parser("learned")
    s.add_argument("--rev-before", required=True)
    s.add_argument("--summary", required=True)
    s.add_argument("--eval", help="e.g. 3/5 escapes caught")
    s.add_argument("--eval-only", action="store_true", help="an eval run that didn't change REVIEW.md")
    sub.add_parser("check")
    sub.add_parser("config")
    sub.add_parser("ship-check")
    s = sub.add_parser("pr-summary")
    s.add_argument("--run", required=True, help="the review_run ship-check reported")
    sub.add_parser("setup-info")
    sub.add_parser("publish-scan")
    sub.add_parser("import-v1")
    sub.add_parser("guard")
    sub.add_parser("where")
    sub.add_parser("enable")
    args = p.parse_args()

    if args.cmd == "guard":  # a hook: it finds the repository from the payload and changes nothing
        cmd_guard(args)
        return
    root = repo_root()
    if not root and args.cmd == "setup-info":  # setup runs before the folder is a repository, to make it one
        cmd_setup_info(args)
        return
    if not root:
        sys.exit("Not inside a git repository. Run /solo-review:setup, which makes one.")
    os.chdir(root)
    ensure_excluded()
    globals()[f"cmd_{args.cmd.replace('-', '_')}"](args)


if __name__ == "__main__":
    main()
