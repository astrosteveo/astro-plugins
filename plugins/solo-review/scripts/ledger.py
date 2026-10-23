#!/usr/bin/env python3
"""solo-review ledger: the bookkeeping half of the review harness.

Per-project state:
  REVIEW.md            human-written review guide; optional settings frontmatter
  .review/ledger.jsonl append-only events: run, finding, outcome, escape, learn

The model calls this script instead of reading or rewriting the ledger itself,
so a review costs tokens only for the review.
"""
import argparse
import fnmatch
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
TEMPLATE = os.path.join(PLUGIN_ROOT, "templates", "REVIEW.md")
PR_TEMPLATE = os.path.join(PLUGIN_ROOT, "templates", "pull_request_template.md")
CLAUDE_TEMPLATE = os.path.join(PLUGIN_ROOT, "templates", "CLAUDE.md")

DEFAULTS = {
    "depth": "auto",          # auto | quick | standard | deep
    "security": "auto",       # auto | always | never
    "max_nits": 3,
    "max_rounds": 3,          # review-and-fix rounds before stepping back to reconsider the approach
    "quick_max_lines": 20,    # auto depth: diffs this small get a quick review
    "check": "",              # the one command that builds and tests the project
    "gate": "push",           # push | off
    "branch": "require",      # require | off: block file edits on the default branch
    "workflow": "manual",     # manual | auto: auto runs /solo-review:review and :ship when a task is done; manual (the default) waits to be asked
    "merge": "rebase",        # rebase | squash | merge: how /solo-review:ship lands a branch
    "high": [],               # globs added to ALWAYS_HIGH: deep review + security pass, and a person reads them
    "low": [],                # globs: a change whose every file matches lands on a clean review without the user
    "trusted": [],            # author emails besides git's user.email whose commits can take the Low path
    "skip": [],               # globs: never reviewed
}
SEVERITIES = ("important", "nit", "pre-existing")
FIXED_IN_LOOP = ("important", "nit")  # "every finding has to be answered"; pre-existing ones are deferred instead
CATEGORIES = ("logic", "error-handling", "concurrency", "resource", "data-integrity",
              "api-contract", "security", "performance", "test", "docs-drift", "convention")
# deferred: pre-existing, outside the change. merged-past: a nit merged without fixing (ship recorded this before nits
# were fixed in the loop), which answers it but says nothing about whether it was right, so it is neither useful nor
# noise.
OUTCOMES = ("fixed", "wrong", "intentional", "wontfix", "deferred", "merged-past")
JUDGED = ("fixed", "wrong", "intentional", "wontfix")  # the article's four author responses
DISMISSED = ("wrong", "intentional", "wontfix", "merged-past")  # answered without a fix: finders don't repeat these
LEGACY_MERGED = "merged without fixing"  # ship's reason for merged-past nits before that outcome existed
LEGACY_EVAL = "eval only"  # review-learn eval's summary for a learn event before --eval-only existed
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


# ---------------------------------------------------------------- helpers

PENDING_STALE_HOURS = 6  # `status` ignores a .pending.json older than this


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git(*args, check=True, env=None):
    r = subprocess.run(["git", *args], capture_output=True, text=True, env=env)
    if check and r.returncode:
        sys.exit(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout.strip() if r.returncode == 0 else ""


def repo_root(start=None):
    r = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, cwd=start)
    return r.stdout.strip() if r.returncode == 0 else None


def review_dir():
    return os.path.join(os.getcwd(), ".review")


def input_file(path):
    """A --file argument: it must be an existing file inside .review/, since it is read and then deleted."""
    real, root = os.path.realpath(path), os.path.realpath(review_dir())
    if os.path.commonpath([real, root]) != root or not os.path.isfile(real):
        sys.exit(f"--file must be an existing file inside {review_dir()}.")
    return real


def ledger_path():
    return os.path.join(review_dir(), "ledger.jsonl")


def load_events():
    path = ledger_path()
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def require_review_dir():
    if not os.path.isdir(review_dir()):
        sys.exit("solo-review isn't set up in this checkout (it has no .review/ directory): run "
                 "/solo-review:setup first.")


def append(*events):
    require_review_dir()  # never create .review/ here: the hooks take it as the repo opting in
    with open(ledger_path(), "a") as f:
        for e in events:
            f.write(json.dumps(e, separators=(",", ":")) + "\n")


def highest_id(prefix):
    """The highest `<prefix>-<n>` id in any ledger this checkout can see: its own, every other worktree's, and the one
    committed on each local and remote-tracking branch. Counting only this ledger's events let two branches reviewed
    from the same base hand out the same id, and merge=union kept both. Only unpushed reviews in two clones can still
    collide; duplicate_ids reports them."""
    texts, root = [], os.path.realpath(os.getcwd())
    paths = [ledger_path()] + [os.path.join(line[9:], ".review", "ledger.jsonl")
                               for line in git("worktree", "list", "--porcelain", check=False).splitlines()
                               if line.startswith("worktree ") and os.path.realpath(line[9:]) != root]
    for path in paths:
        try:
            with open(path, errors="replace") as f:
                texts.append(f.read())
        except OSError:
            pass
    refs = git("for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", check=False).split()
    if refs:
        # one blob per distinct ledger, however many branches share it
        r = subprocess.run(["git", "cat-file", "--batch-check=%(objectname)"], capture_output=True, text=True,
                           input="".join(f"{ref}:.review/ledger.jsonl\n" for ref in refs))
        blobs = sorted({line for line in r.stdout.splitlines() if re.fullmatch(r"[0-9a-f]{40,64}", line)})
        if blobs:
            texts.append(subprocess.run(["git", "cat-file", "--batch"], capture_output=True, text=True,
                                        errors="replace", input="".join(b + "\n" for b in blobs)).stdout)
    pattern = re.compile(r'"id":\s*"' + re.escape(prefix) + r'-(\d+)"')
    return max((int(n) for t in texts for n in pattern.findall(t)), default=0)


def duplicate_ids(events):
    """Finding ids that two findings share, from reviews no ledger in sight could warn about: findings_state keeps
    only the later one, and outcomes can't tell them apart."""
    counts = Counter(e["id"] for e in events if e["type"] == "finding")
    return sorted((i for i, n in counts.items() if n > 1), key=lambda i: int(i[2:]) if i[2:].isdigit() else 0)


def branch_duplicates(events, branch):
    """The duplicate ids one of whose findings is this branch's, whichever of the two findings_state kept."""
    mine = {e["id"] for e in events if e["type"] == "finding" and e.get("branch") == branch}
    return [i for i in duplicate_ids(events) if i in mine]


def unquote(v):
    return v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"" else v


# Settings that switch off or thin out a review gate. They come from the default branch's REVIEW.md, so a branch can't
# weaken the review of its own change.
GATE_KEYS = ("high", "low", "trusted", "skip", "security", "check", "gate", "branch", "depth", "max_rounds", "max_nits",
             "quick_max_lines")
ENUMS = {"depth": ("auto", "quick", "standard", "deep"), "security": ("auto", "always", "never"),
         "gate": ("push", "off"), "workflow": ("manual", "auto"), "branch": ("require", "off"), "merge": ("rebase", "squash", "merge")}


def parse_frontmatter(text, cfg):
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    key = None
    for raw in (m.group(1).splitlines() if m else []):
        # one blank before the #, not \s+: that retries from every blank of a long run, and a hook that slow times out
        line = re.sub(r"\s#.*$", "", raw).rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        item = re.match(r"\s*-\s+(.*)", line)
        if item:
            if key and isinstance(cfg.get(key), list):  # a list item under a scalar key, or under none, is ignored
                cfg[key].append(unquote(item.group(1).strip()))
            continue
        key, _, value = line.partition(":")
        key, value = key.strip(), value.strip()
        if not value:
            cfg[key] = []
        elif value.isdigit():
            try:
                cfg[key] = int(value)
            except ValueError:  # int() refuses a digit like ², and more digits than it converts
                cfg[key] = value
        else:
            cfg[key] = unquote(value)


def fresh_config():
    return {k: (list(v) if isinstance(v, list) else v) for k, v in DEFAULTS.items()}


def normalize(cfg):
    """Replace a value of the wrong type or outside its allowed values with the default."""
    # `sensitive` is the old name for `high`: a REVIEW.md that still says it keeps its paths High, since dropping them
    # would quietly lighten their review
    old = cfg.pop("sensitive", None)
    for k, v in DEFAULTS.items():
        if isinstance(v, list):
            cfg[k] = [x for x in cfg[k] if isinstance(x, str)] if isinstance(cfg.get(k), list) else []
        elif isinstance(v, int):
            if not isinstance(cfg.get(k), int):
                cfg[k] = v
        elif not isinstance(cfg.get(k), str) or (k in ENUMS and cfg[k] not in ENUMS[k]):
            cfg[k] = v
    if isinstance(old, list):
        cfg["high"] += [x for x in old if isinstance(x, str)]


def default_ref():
    """The default branch to compare against: origin's copy when there is one (a local copy can be stale)."""
    db = default_branch()
    if not db:
        return None
    return f"origin/{db}" if f"refs/remotes/origin/{db}" in default_refs(db) else db


def default_review_md(ref):
    """REVIEW.md as committed on `ref`. Returns (text, why): text is None when it can't be had, and why says whether
    the default branch has no REVIEW.md or git failed to read it."""
    if not ref:
        return None, "no default branch found"
    root = repo_root() or os.getcwd()
    spec = f"{ref}:REVIEW.md"
    if subprocess.run(["git", "-C", root, "cat-file", "-e", spec], capture_output=True).returncode:
        resolves = subprocess.run(["git", "-C", root, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
                                  capture_output=True).returncode == 0
        return None, f"{ref} has no REVIEW.md" if resolves else f"git could not read {ref}"
    r = subprocess.run(["git", "-C", root, "show", spec], capture_output=True, text=True, errors="replace")
    return (r.stdout, None) if r.returncode == 0 else (None, f"git could not read {spec}")


READ_CAP = 1_000_000  # characters: more than any REVIEW.md, manifest or Makefile holds


def read_capped(path, errors="strict"):
    """The first READ_CAP characters of a file the branch controls, or None when `path` isn't a regular file or can't be
    read. A symlink to /dev/zero never ends and a FIFO blocks at open, and a hook that runs out of memory or hangs lets
    through what it should have blocked: isfile() is False for both, and the cap bounds a regular file of any size."""
    if not os.path.isfile(path):
        return None
    try:
        with open(path, errors=errors) as f:
            return f.read(READ_CAP)
    except (OSError, ValueError):  # ValueError: a UnicodeDecodeError, under errors="strict"
        return None


def branch_review_md():
    """The working tree's REVIEW.md, or None when there is none or it can't be read (a directory, say)."""
    return read_capped(os.path.join(os.getcwd(), "REVIEW.md"), "replace")


def load_config():
    """REVIEW.md frontmatter, flat keys and string lists only. Returns (config, version hash).
    The gate settings (GATE_KEYS) come from the default branch's REVIEW.md, so a branch can't switch off the gates for
    its own change. When that file can't be read or doesn't exist, the branch's REVIEW.md may only strengthen review:
    `low`, `trusted`, `skip`, `security: never`, `gate: off`, `branch: off` and a depth below auto are ignored, `max_rounds` and
    `quick_max_lines` can only go down, and `check` is inferred from the manifest, never taken from the branch.
    `high` still comes from the branch, since more High-risk paths only strengthen review. When the default
    branch's REVIEW.md sets no `check`, it is inferred the same way."""
    cfg = fresh_config()
    text = branch_review_md()
    parse_frontmatter(text or "", cfg)
    normalize(cfg)
    ref = default_ref()
    base_text, why = default_review_md(ref)
    if base_text is not None:
        base = fresh_config()
        parse_frontmatter(base_text, base)
        normalize(base)
        for k in GATE_KEYS:
            cfg[k] = base[k]
        cfg["source"] = f"{ref}:REVIEW.md"
        # A new project's first branch with code is also the one that sets the check, so the default branch has none
        # yet. Infer one rather than run none: adding a check can't weaken the review of the branch's own change.
        if not cfg["check"]:
            cfg["check"] = infer_check()
            if cfg["check"]:
                cfg["source"] += f" (check inferred from the manifest: {ref} sets none)"
    else:
        cfg.update(low=[], trusted=[], skip=[], gate=DEFAULTS["gate"], branch=DEFAULTS["branch"], max_nits=DEFAULTS["max_nits"],
                   quick_max_lines=min(cfg["quick_max_lines"], DEFAULTS["quick_max_lines"]), check=infer_check(),
                   max_rounds=min(cfg["max_rounds"], DEFAULTS["max_rounds"]),
                   security="auto" if cfg["security"] == "never" else cfg["security"],
                   depth="deep" if cfg["depth"] == "deep" else "auto",
                   source=f"restricted ({why}): the branch's REVIEW.md can only strengthen review")
    return cfg, (hashlib.sha1(text.encode()).hexdigest()[:8] if text is not None else None)


def glob_variants(g):
    """`**/x` also matches a top-level x, and `dir/**` also matches the bare path `dir`, which is how git records a
    symlinked directory."""
    vs = {g}
    if g.startswith("**/"):
        vs.add(g[3:])
    vs |= {v[:-3] for v in vs if v.endswith("/**")}
    return vs


def matches(path, globs):
    path = path.lower()
    return any(fnmatch.fnmatchcase(path, v) for g in globs for v in glob_variants(g.lower()))


# Always High risk, whatever REVIEW.md says, because a bad change to one of these is a security risk on its own: a
# person reads it before it merges, and agents review it deep with a security pass. REVIEW.md's `high` list adds
# project-specific paths on top; nothing removes these.
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


def is_high(path, cfg, symlinks=()):
    return path in symlinks or matches(path, ALWAYS_HIGH) or matches(path, cfg["high"])


def risk_tier(files, cfg, symlinks=()):
    """The article's risk tier, which "the change sets ..., not the author": high when any file is High, low when every
    file matches REVIEW.md's `low` globs, medium otherwise. High wins, so no `low` glob can lower an ALWAYS_HIGH path."""
    if any(is_high(f, cfg, symlinks) for f in files):
        return "high"
    if files and all(matches(f, cfg["low"]) for f in files):
        return "low"
    return "medium"


def changed_raw(a, b, *pathspec):
    """Files that differ between two commits, with their new modes: [(path, mode)]."""
    out = git("diff", "--raw", "--no-renames", "-z", a, b, "--", ".", ":(exclude).review/**", *pathspec, check=False)
    toks, rows = out.split("\0"), []
    for i, t in enumerate(toks):
        if t.startswith(":") and i + 1 < len(toks):
            rows.append((toks[i + 1], t.split()[1]))
    return rows


def symlinks_in(rows):
    """Added or changed symlinks (mode 120000): they can point anywhere, so each one needs a person's eyes."""
    return {p for p, mode in rows if mode == "120000"}


def current_branch():
    # a new repo's branch has a name but no commit yet, so rev-parse can't name it and symbolic-ref has to
    return (git("rev-parse", "--abbrev-ref", "HEAD", check=False)
            or git("symbolic-ref", "--quiet", "--short", "HEAD", check=False) or "HEAD")


def has_commits():
    return bool(git("rev-parse", "--verify", "--quiet", "HEAD", check=False))


# the branch names ship-check accepts; origin/HEAD, which the remote sets, picks the default branch's name
SAFE_BRANCH = r"[A-Za-z0-9._/-]+"


def default_branch():
    """The default branch's name (origin/HEAD's target, else main or master), when a local branch or origin's copy of
    it exists. The name can contain slashes, and a clone may have only origin's copy."""
    ref = git("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD", check=False)
    prefix = "refs/remotes/origin/"
    candidates = [ref[len(prefix):]] if ref.startswith(prefix) else []
    for b in candidates + ["main", "master"]:
        if default_refs(b):
            return b
    return None


def default_refs(db):
    """The refs holding the default branch `db` that exist: the local branch and origin's copy."""
    return [r for r in (f"refs/heads/{db}", f"refs/remotes/origin/{db}")
            if git("rev-parse", "--verify", "--quiet", f"{r}^{{commit}}", check=False)]


def default_merge_base(db):
    """Where HEAD left the default branch `db`. Either copy can be the newer one (a local branch not pulled since a
    fetch, or local commits not yet pushed), so this is the newest commit HEAD shares with either: commits on the
    default branch never count as part of the change."""
    return git("merge-base", "HEAD", *default_refs(db))


def findings_state(events):
    """Latest state of every finding: the finding event plus its newest outcome."""
    state = {}
    for e in events:
        if e["type"] == "finding":
            state[e["id"]] = {**e, "outcome": None}
        elif e["type"] == "outcome" and e["id"] in state:
            f = state[e["id"]]
            outcome = e["outcome"]
            if outcome == "wontfix" and e.get("by") == "user" and e.get("reason") == LEGACY_MERGED:
                outcome = "merged-past"
            # a spot-check confirming a fix names no commit: keep the one the fix was recorded with
            commit = e.get("commit") or (f.get("commit") if outcome == f["outcome"] else None)
            f.update(outcome=outcome, reason=e.get("reason", ""), by=e.get("by"), via=e.get("via"), commit=commit,
                     resolved_ts=e["ts"], prev=f.get("outcome"), prev_by=f.get("by"))
    return state


def norm_id(raw):
    raw = raw.strip().upper()
    return raw if raw.startswith("F-") else f"F-{raw.lstrip('F')}"


def fmt_finding(f):
    loc = f"{f['file']}:{f.get('line', '?')}"
    return f"{f['id']} {f['severity']:<12} {f['category']:<14} {loc}  {f['title']}"


# ---------------------------------------------------------------- commands

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


def infer_check():
    """Best guess at the project's build-and-test command from its manifest, or "" if there is none. A manifest it
    can't read counts as none: load_config calls this, and a raise there turns every hook off."""
    text = read_capped("package.json")
    if text is not None:
        try:
            # a manifest that fills the cap was cut off, so it can't be parsed
            manifest = json.loads(text) if len(text) < READ_CAP else {}
        except (ValueError, RecursionError):  # RecursionError: nested too deep to parse
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


def check_command(cfg):
    return cfg["check"] if isinstance(cfg.get("check"), str) else ""


def cmd_init(args):
    opting_in = not os.path.isdir(review_dir())
    os.makedirs(review_dir(), exist_ok=True)
    gi = os.path.join(review_dir(), ".gitignore")
    required = [".pending.json", ".record.json", ".check.txt", ".pr-body.md"]
    have = open(gi).read() if os.path.exists(gi) else ""
    missing = [e for e in required if e not in have.splitlines()]
    if missing:
        with open(gi, "a") as f:
            if have and not have.endswith("\n"):
                f.write("\n")
            f.write("".join(e + "\n" for e in missing))
    ga = os.path.join(review_dir(), ".gitattributes")
    if not os.path.exists(ga):
        with open(ga, "w") as f:
            f.write("ledger.jsonl merge=union\n")  # append-only: branches that both added events keep both
    open(ledger_path(), "a").close()
    # branch worktrees live inside the main checkout; keep them out of its `git status` (local to this clone)
    exclude = git("rev-parse", "--git-path", "info/exclude", check=False)
    if exclude:
        have = open(exclude).read() if os.path.exists(exclude) else ""
        if f"/{WORKTREES_DIR}/" not in have.splitlines():
            os.makedirs(os.path.dirname(exclude), exist_ok=True)
            with open(exclude, "a") as f:
                f.write(("\n" if have and not have.endswith("\n") else "") + f"/{WORKTREES_DIR}/\n")
    # what a new repo's first commit holds: with .review/ in it, every clone and worktree has opted in
    setup = ["REVIEW.md", *LEDGER_FILES]
    target = os.path.join(os.getcwd(), "REVIEW.md")
    if os.path.exists(target):
        print("REVIEW.md exists; left unchanged. .review/ ready.")
    else:
        with open(TEMPLATE) as f:
            text = f.read()
        check = infer_check()
        text = text.replace('check: ""', f"check: {json.dumps(check)}", 1)
        with open(target, "w") as f:
            f.write(text)
        print("Created REVIEW.md from template and .review/. Fill in REVIEW.md's sections.")
        print(f"check: {check}" if check else "check: none found; set `check:` in REVIEW.md to the command that "
              "builds and tests the project. Until the default branch sets one, the check is inferred from the "
              "manifest, and a branch's own `check:` applies only once that branch merges.")
    existing = find_pr_template()
    if existing:
        print(f"Pull request template exists at {existing}; left unchanged.")
    else:
        os.makedirs(".github", exist_ok=True)
        shutil.copy(PR_TEMPLATE, os.path.join(".github", "pull_request_template.md"))
        print("Created .github/pull_request_template.md.")
    setup.append(existing or os.path.join(".github", "pull_request_template.md"))
    claude_md = [p for p in ("CLAUDE.md", os.path.join(".claude", "CLAUDE.md")) if os.path.isfile(p)]
    setup.append(claude_md[0] if claude_md else "CLAUDE.md")
    if claude_md:
        print("CLAUDE.md exists; left unchanged. Check each of its lines against the code.")
    else:
        with open(CLAUDE_TEMPLATE) as f:
            text = f.read()
        check = infer_check()
        text = text.replace("{{name}}", os.path.basename(os.getcwd())).replace(
            "{{check}}", check or "<the one command that builds and tests the project>")
        with open("CLAUDE.md", "w") as f:
            f.write(text)
        print("Created CLAUDE.md from template. Fill it from the README, the manifest, and the code.")
    if not has_commits():
        # a branch made now would hold the first commit, and the default branch would never exist to branch from
        print(f"No commits yet: stay on {current_branch()}, and make the first commit hold only the setup "
              f"({', '.join(setup)}), so branches have a base to be reviewed against and merge into.")
    if opting_in:  # this session started before the hooks would act, so it hasn't had the rules
        print("\nThese workflow rules apply from now on, in this session too (the SessionStart hook gives them to "
              "new sessions):\n" + workflow_rules())


# Claude Code puts the worktrees it makes in here, inside the main checkout. Git sees a nested worktree as an untracked
# gitlink, so `add -A` would put it in the snapshot as a changed (and always High-risk) file
WORKTREES_DIR = ".claude/worktrees"
NOT_WORKTREES = f":(exclude){WORKTREES_DIR}"


def snapshot():
    """Commit object for the working tree (tracked + untracked, minus ignored), without
    touching the user's index, worktree, or refs. Returns HEAD when the tree is clean."""
    git_dir = git("rev-parse", "--absolute-git-dir")
    idx = os.path.join(git_dir, "solo-review.index")
    real_idx = os.path.join(git_dir, "index")
    if os.path.exists(real_idx):
        shutil.copy(real_idx, idx)   # reuse stat cache so `add -A` doesn't rehash everything
    env = {**os.environ, "GIT_INDEX_FILE": idx,
           "GIT_AUTHOR_NAME": "solo-review", "GIT_AUTHOR_EMAIL": "solo-review@localhost",
           "GIT_COMMITTER_NAME": "solo-review", "GIT_COMMITTER_EMAIL": "solo-review@localhost"}
    try:
        if not os.path.exists(real_idx):
            git("read-tree", "HEAD", env=env)
        git("-c", "advice.addEmbeddedRepo=false", "add", "-A", env=env)
        # drop branch worktrees afterwards: naming them in `add`'s pathspec, even to exclude them, makes git fail
        # ("paths are ignored by one of your .gitignore files") once a .gitignore ignores them, as init's exclude does
        git("rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", WORKTREES_DIR, env=env)
        tree = git("write-tree", env=env)
    finally:
        if os.path.exists(idx):
            os.remove(idx)
    head = git("rev-parse", "HEAD")
    if tree == git("rev-parse", "HEAD^{tree}"):
        return head
    return git("commit-tree", tree, "-p", "HEAD", "-m", "solo-review snapshot", env=env)


# a prefix, so it matches "Fix review findings F-1, F-4" and "Fix review finding F-1"
FIX_SUBJECT = "Fix review finding"


def is_clean(run):
    return run.get("actionable", run.get("reported", 0)) == 0


def is_commit(rev):
    """False once gc has pruned `rev`: review snapshots are commits nothing references."""
    return subprocess.run(["git", "cat-file", "-e", f"{rev}^{{commit}}"], capture_output=True).returncode == 0


def new_work_since(last_target, target, worktree, fix_commits):
    """True if anything but review fixes landed after `last_target`: commits that no `resolve --as fixed --commit`
    named (`fix_commits`) and whose subject doesn't start with FIX_SUBJECT (ledger-only commits don't count), or,
    when `worktree`, files outside .review/ that differ between the last snapshot and the current one (`target`) and
    weren't changed by fix commits. Dirty files that haven't changed since the last round are not new work. A last
    snapshot git has pruned (it is referenced by nothing) can't be compared, so it counts as new work."""
    if not is_commit(last_target):
        return True
    ex = ":(exclude).review/**"
    commits = git("log", "--format=%H %s", f"{last_target}..HEAD", "--", ".", ex, check=False).splitlines()
    if any(c.partition(" ")[0] not in fix_commits and not c.partition(" ")[2].startswith(FIX_SUBJECT)
           for c in commits):
        return True
    if not worktree:
        return False
    changed = set(git("diff", "--name-only", "--no-renames", "-z", last_target, target, "--", ".", ex,
                      check=False).split("\0")) - {""}
    for c in commits:
        changed -= set(git("diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", "-z", "-m", "--root",
                           c.partition(" ")[0], check=False).split("\0"))
    return bool(changed)


def pick_base(arg_base):
    if arg_base:
        return git("rev-parse", arg_base), arg_base
    branch, db = current_branch(), default_branch()
    if db and branch != db:
        return default_merge_base(db), f"branch vs {db}"
    upstream = git("rev-parse", "--abbrev-ref", "@{u}", check=False)
    if upstream:
        return git("merge-base", "HEAD", upstream), f"unpushed vs {upstream}"
    return git("rev-parse", "HEAD"), "uncommitted changes"


def claude_md_files(files):
    """CLAUDE.md files that apply to the changed files: in their directories and every parent up to the root. A
    CLAUDE.md under a templates/ directory is a template's placeholder text, not this project's conventions."""
    dirs = {""}
    for f in files:
        d = os.path.dirname(f)
        while d:
            if "templates" not in d.split("/"):
                dirs.add(d)
            d = os.path.dirname(d)
    paths = [os.path.join(d, name) for d in sorted(dirs) for name in ("CLAUDE.md", os.path.join(".claude", "CLAUDE.md"))]
    return [p for p in paths if os.path.isfile(p)]


# "what failure looks like here" is the older name of "what important means here"; guides set up before keep it
CHECKLIST_SECTIONS = ("what important means here", "what failure looks like here", "always check")


def review_checklist(text):
    """The list items (bulleted or numbered) of the "What Important means here" and "Always check" sections of
    REVIEW.md's `text`, without the frontmatter or HTML comments (the template's examples). Finders walk each one
    against the diff and report what they found, so an empty result shows what it covered."""
    if text is None:
        return []
    text = re.sub(r"<!--.*?(-->|\Z)", "", re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.S), flags=re.S)
    items, section, wrapped = [], None, False
    for line in text.splitlines():
        bullet = re.match(r"\s*(?:[-*+]|\d{1,9}[.)])\s+(\S.*)", line)
        if line.startswith("#"):
            section, wrapped = line.lstrip("#").strip().lower(), False
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


def cap_summary(events, cycle, branch):
    """What the user needs when the round cap stops a cycle: how many rounds ran, what they fixed, what is still open,
    what was committed after the last review, and the commands that get past ship's block."""
    state = findings_state(events)
    runs = {r["run"] for r in cycle}
    fixed = [f["id"] for f in state.values() if f["run"] in runs and f["outcome"] == "fixed"]
    open_ = [f for f in state.values() if f["outcome"] is None and f.get("branch") == branch]
    important = sum(1 for f in open_ if f["severity"] == "important")
    nits = sum(1 for f in open_ if f["severity"] == "nit")
    unreviewed = git("log", "--format=%h %s", f"{cycle[-1]['target']}..HEAD", "--", ".", ":(exclude).review/**",
                     check=False).splitlines() if cycle else []
    lines = [f"Review stopped at the round cap: {len(cycle)} rounds ran without a clean pass.",
             f"Rounds: {len(cycle)} | Fixed: {len(fixed)} | Open: {len(open_)} ({important} Important, {nits} nits)"
             f" | Unreviewed commits: {len(unreviewed)}"]
    if open_:
        lines += ["", "Open findings:"] + [f"  {fmt_finding(f)}" for f in open_]
    if unreviewed:
        lines += ["", "Committed after the last review round:"] + [f"  {c}" for c in unreviewed]
    blocks = (["open findings"] if open_ else []) + (["unreviewed commits"] if unreviewed else [])
    lines += ["", "Ship is blocked by " + " and ".join(blocks) + ". To finish:" if blocks else "To finish:"]
    if unreviewed or open_:
        lines += ["  /solo-review:review --force          one more round over the unreviewed fixes",
                  "  /solo-review:review --until-clean    keep running rounds until one comes back clean"]
    if open_:
        lines.append("  /solo-review:review resolve <ids> <wrong|intentional|wontfix> <reason>    answer an open "
                     "finding yourself")
    if not open_:
        lines.append("  /solo-review:ship --skip-review      open the PR without reviewing the last fixes")
    return "\n".join(lines)


def cmd_scope(args):
    if not has_commits():
        sys.exit("No commits yet; commit once so there is a base to review against.")
    require_review_dir()
    cfg, rev = load_config()
    branch = current_branch()
    if args.range:
        a, _, b = args.range.partition("..")
        base, target, label, worktree = git("rev-parse", a), git("rev-parse", b or "HEAD"), args.range, False
    else:
        (base, label), target, worktree = pick_base(args.base), snapshot(), True

    events = load_events()
    prior_runs = [e for e in events if e["type"] == "run" and e["branch"] == branch and e["base"] == base]
    # A cycle is one review-and-fix loop: it ends on a clean round, and new work (anything but fix commits) starts a
    # fresh one. The cap is for "an agent author and an agent reviewer" that "keep each other busy", not new features.
    last = prior_runs[-1] if prior_runs else None
    fix_commits = {e["commit"] for e in events
                   if e["type"] == "outcome" and e["outcome"] == "fixed" and e.get("commit")}
    new_work = bool(last) and new_work_since(last["target"], target, worktree, fix_commits)
    if not last or is_clean(last) or new_work:
        cycle, cycle_id = [], None
    else:
        cycle_id = last.get("cycle") or last["run"]
        cycle = [r for r in prior_runs if (r.get("cycle") or r["run"]) == cycle_id]
    round_no = len(cycle) + 1
    # --until-clean lifts the cap for the rest of the cycle: the user chose to run rounds until one comes back clean
    until_clean = args.until_clean or any(r.get("until_clean") for r in cycle)
    if round_no > cfg["max_rounds"] and not args.force and not until_clean:
        print(json.dumps({"stop": True, "round": round_no, "max_rounds": cfg["max_rounds"],
                          "message": f"{len(cycle)} review-and-fix rounds ran without a clean pass. "
                                     "Step back and reconsider the approach instead of patching again "
                                     "(or rerun with --force for one more round, or --until-clean to run "
                                     "rounds until one is clean).",
                          "summary": cap_summary(events, cycle, branch)}))
        return

    # everything up to the last reviewed snapshot has been reviewed: re-review only what changed since, unless --fresh
    # asks to review the whole change again (say, a clean round the user doubts)
    diff_from, incremental = base, False
    if last and not args.fresh:
        # snapshot commits are unreferenced; gc may have pruned an old one
        if is_commit(last["target"]):
            diff_from, incremental = last["target"], True

    skips = []
    for g in cfg["skip"]:
        if re.search(r"[\x00-\x1f\x7f'\"`]", g):
            print(f"ledger: ignoring skip glob with quote or control characters: {g!r}", file=sys.stderr)
        else:
            skips.append(g)
    excludes = [f":(exclude,glob){g}" for g in [".review/**", *skips]]
    all_rows = changed_raw(diff_from, target)
    links = symlinks_in(all_rows)
    if skips:
        # skip never hides a High-risk file: exclude the skipped files that aren't High by name instead
        kept = {p for p, _ in changed_raw(diff_from, target, *excludes[1:])}
        skipped = [p for p, _ in all_rows if p not in kept]
        if any(is_high(p, cfg, links) for p in skipped):
            excludes = [":(exclude,glob).review/**"] + [f":(exclude,literal){p}" for p in skipped
                                                        if not is_high(p, cfg, links)]
    numstat = git("diff", "--numstat", "--no-renames", "-z", diff_from, target, "--", ".", *excludes)
    files, added, removed = [], 0, 0
    for rec in numstat.split("\0"):
        if not rec:
            continue
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
    added_text = git("diff", "-U0", diff_from, target, "--", ".", *excludes)
    hint = security_hint(added_text)

    if high:
        depth = "deep"  # a High-risk file gets a deep review whatever depth says
    elif args.depth:
        depth = args.depth
    elif cfg["depth"] != "auto":
        depth = cfg["depth"]
    elif all(f.endswith(DOC_EXT) for f in files) or added + removed <= cfg["quick_max_lines"]:
        depth = "quick"
    else:
        depth = "standard"
    # a High-risk file gets a security pass whatever `security` says, as it gets a deep review whatever depth says
    security = bool(high) or {"always": True, "never": False}.get(
        cfg["security"], hint or depth == "deep")  # auto at deep still runs the security lens

    state = findings_state(events)
    in_scope = set(files)
    prior = [f for f in state.values() if f["file"] in in_scope and (
        (f["outcome"] is None and f.get("branch") == branch) or f["outcome"] in DISMISSED)]
    prior_lines = [f"{f['id']} [{f['outcome'] or 'open'}] {f['file']}:{f.get('line', '?')} {f['title']}"
                   + (f" -- {f['reason']}" if f.get("reason") else "") for f in prior[-30:]]

    # The fewest tool uses a finder's Method takes: the diff, REVIEW.md, and one changed file. No CLAUDE.md counts:
    # subagents start with the root one in context, and a nested one comes in with the first file read under it.
    # REVIEW.md already counts, and a deleted file (mode 000000) can't be read. With no sink in the added lines, the
    # security lens has nothing in its lens to read beyond the diff, so its floor leaves out the changed file.
    # A REVIEW.md that load_config can't read (a directory, say) is absent here too, so finders aren't sent to read it.
    review_text = branch_review_md()
    review_md, claude_md = review_text is not None, claude_md_files(files)
    readable = {p for p, mode in all_rows if mode != "000000"} - {"REVIEW.md", "CLAUDE.md", ".claude/CLAUDE.md"}
    floor = 1 + review_md + any(f in readable for f in files)
    min_tool_uses = {"change": floor, "system": floor, "all": floor, "security": floor if hint else 1 + review_md}

    quoted = [shlex.quote(x) for x in excludes]
    diff_cmd = " ".join(["git diff", diff_from, target, "-- ."] + quoted)
    change_diff_cmd = " ".join(["git diff", base, target, "-- ."] + quoted)
    run_id = "R-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    run = {"type": "run", "run": run_id, "ts": now(), "cycle": cycle_id or run_id, "new_work": new_work,
           "branch": branch, "base": base, "target": target, "from": diff_from, "label": label,
           "round": round_no, "incremental": incremental, "depth": depth, "security": security,
           "files": len(files), "lines": added + removed, "rev": rev}
    if until_clean:
        run["until_clean"] = True
    if args.fresh:
        run["fresh"] = True
    with open(os.path.join(review_dir(), ".pending.json"), "w") as f:
        json.dump(run, f)

    out = {**{k: run[k] for k in ("run", "label", "round", "incremental", "depth", "security", "lines")},
           "max_rounds": cfg["max_rounds"], "until_clean": until_clean, "max_nits": cfg["max_nits"],
           "diff_cmd": diff_cmd,
           "change_diff_cmd": change_diff_cmd,
           "read_files": "from the working tree" if worktree else f"with `git show {target}:<path>`",
           "files": files[:60] + ([f"... and {len(files) - 60} more"] if len(files) > 60 else []),
           "high_files": high,
           "review_md": review_md,
           "checklist": [f"{i}. {line}" for i, line in enumerate(review_checklist(review_text), 1)],
           "claude_md": claude_md,
           "min_tool_uses": min_tool_uses,
           "security_hint": hint,
           "check": check_command(cfg),
           "prior_findings": prior_lines,
           "open_to_recheck": [l for l in prior_lines if "[open]" in l] if incremental else []}
    print(json.dumps(out, indent=1))


def cmd_check(args):
    """Never runs the project's check, because that command comes from the repo and must go through Claude's normal
    permission prompt. Without arguments, print the configured command. With --record, store the result Claude got
    from running it in the pending run, for `record` to keep."""
    if args.record:
        # the summary comes from a file or stdin, never the command line: it is written from the check's output, which
        # the repo controls, and $() or backticks in a pre-approved ledger.py command would expand before this runs
        if args.status is None:
            sys.exit("--record needs --status <exit code>, and a one-line summary in --file <file> or on stdin.")
        pending = os.path.join(review_dir(), ".pending.json")
        if not os.path.exists(pending):
            sys.exit("No pending run; run `scope` first.")
        with open(pending) as f:
            run = json.load(f)
        if args.file:
            path = input_file(args.file)
            with open(path, errors="replace") as f:
                summary = " ".join(f.read(1000).split())
            os.remove(path)
        else:
            summary = " ".join(sys.stdin.read(1000).split())
        run["check"] = f"{'passed' if args.status == 0 else f'failed (exit {args.status})'}: {summary}"[:200]
        with open(pending, "w") as f:
            json.dump(run, f)
        print(f"Recorded: {run['check']}")
        return
    cmd = check_command(load_config()[0])
    if not cmd:
        own = fresh_config()
        parse_frontmatter(branch_review_md() or "", own)
        normalize(own)
        if own["check"]:
            # the user already set it on this branch, so "set `check:`" would point them at a fix they've made
            print(f"No check command is configured on the default branch, and none can be inferred from the manifest. "
                  f"This branch's REVIEW.md sets `{own['check']}`, which applies once the branch merges: a branch "
                  "can't choose the check that gates it.")
        else:
            print("No check command is configured. Set `check:` in REVIEW.md to the command that builds and tests the "
                  "project.")
        sys.exit(3)
    print(cmd)


def record_problem(data):
    """What is wrong with a `record` payload, or None. The fields record reads without a default must be there."""
    if not isinstance(data, dict):
        return "the payload must be a JSON object."
    for key in ("findings", "resolved_by_change", "thin"):
        if key in data and not isinstance(data[key], list):
            return f"`{key}` must be a list."
    for i, f in enumerate(data.get("findings", [])):
        if not isinstance(f, dict) or not all(isinstance(f.get(k), str) and f.get(k) for k in ("file", "title")):
            return f"findings[{i}] must be an object with a non-empty `file` and `title`."
    if not all(isinstance(fid, str) for fid in data.get("resolved_by_change", [])):
        return "`resolved_by_change` must list finding ids as strings."
    return None


def cmd_record(args):
    pending = os.path.join(review_dir(), ".pending.json")
    if not os.path.exists(pending):
        sys.exit("No pending run; run `scope` first.")
    with open(pending) as f:
        run = json.load(f)
    if args.file:
        path = input_file(args.file)
        with open(path) as f:
            data = json.load(f)
        os.remove(path)
    else:
        data = json.load(sys.stdin)
    problem = record_problem(data)
    if problem:  # checked before anything is written, so a bad payload records nothing and can be sent again
        sys.exit(f"record: {problem}")
    events = load_events()
    state = findings_state(events)
    next_no = highest_id("F") + 1

    new = []
    for i, f in enumerate(data.get("findings", [])):
        sev = f.get("severity", "important")
        cat = f.get("category", "logic")
        new.append({"type": "finding", "id": f"F-{next_no + i}", "ts": now(), "run": run["run"],
                    "branch": run["branch"], "file": f["file"], "line": f.get("line"),
                    "severity": sev if sev in SEVERITIES else "important",
                    "category": cat if cat in CATEGORIES else "logic",
                    "title": f["title"][:160], "evidence": f.get("evidence", "")[:500],
                    "fix": f.get("fix", "")[:300], "votes": f.get("votes"),
                    "verified": str(f.get("verified", ""))[:300]})
    autofixed = []
    for fid in data.get("resolved_by_change", []):
        fid = norm_id(fid)
        if fid in state and state[fid]["outcome"] is None:
            autofixed.append({"type": "outcome", "id": fid, "ts": now(), "outcome": "fixed",
                              "by": "auto", "reason": "no longer present on re-review"})
    # Important findings and nits send the loop round again; pre-existing ones are deferred, not fixed
    actionable = sum(1 for f in new if f["severity"] in FIXED_IN_LOOP)
    if data.get("check") and "check" not in run:  # `ledger.py check --record` already stored the real result
        run["check"] = str(data["check"])[:200]
    # compliance with REVIEW.md, measured before the orchestrator trims anything
    for key in ("nits_found", "rejected", "rejected_guide"):
        if isinstance(data.get(key), int):
            run[key] = data[key]
    # lenses that came back empty twice without showing what they checked: the round looks cleaner than it was
    if isinstance(data.get("thin"), list) and data["thin"]:
        run["thin"] = [str(x)[:20] for x in data["thin"][:5]]
    # the model writes this JSON by hand: a null or quoted count in the append-only ledger would break every `stats`
    try:
        candidates = int(data.get("candidates", len(new)))
    except (TypeError, ValueError, OverflowError):
        candidates = len(new)
    run.update(candidates=candidates, reported=len(new), actionable=actionable,
               important=sum(1 for f in new if f["severity"] == "important"))
    append(run, *new, *autofixed)
    os.remove(pending)

    counts = Counter(f["severity"] for f in new)
    detail = ", ".join(f"{counts[s]} {s}" for s in SEVERITIES if counts[s])
    head = f"{len(new)} finding{'s' if len(new) != 1 else ''}" + (f" ({detail})" if detail else "")
    print(f"{head}. Round {run['round']}, {run['depth']}, {run['candidates']} candidates -> "
          f"{len(new)} verified." + (f" {len(autofixed)} earlier finding(s) cleared by the change." if autofixed else ""))
    if not actionable:
        print("Round is clean: no Important findings or nits." + (" Pre-existing findings are deferred, not fixed."
                                                                   if new else ""))
    if run.get("thin"):
        print(f"Thin: the {', '.join(run['thin'])} finder(s) came back empty twice without showing what they checked, "
              "so this round covered less than its result shows.")
    cleared = {a["id"] for a in autofixed}
    still = [fid for fid, f in state.items() if f["outcome"] is None and f["severity"] in FIXED_IN_LOOP
             and f.get("branch") == run["branch"] and fid not in cleared]
    if still:
        print(f"Still open from earlier rounds: {', '.join(still)}."
              + ("" if actionable else " The cycle doesn't pass until each is answered."))
        for fid in still:
            print(fmt_finding(state[fid]))
            if state[fid].get("fix"):
                print(f"   fix: {state[fid]['fix']}")
    for f in new:
        print(fmt_finding(f))
        if f["fix"]:
            print(f"   fix: {f['fix']}")


def cmd_resolve(args):
    if args.outcome not in OUTCOMES:
        sys.exit(f"--as must be one of {', '.join(OUTCOMES)}")
    if args.outcome != "fixed" and not args.reason:
        sys.exit("A reason is required unless the outcome is 'fixed'.")
    state = findings_state(load_events())
    ids = [norm_id(i) for i in args.ids]
    missing = [i for i in ids if i not in state]
    if missing:
        sys.exit(f"Unknown finding(s): {', '.join(missing)}")
    if args.via and args.by != "user":
        sys.exit("--via ui marks an answer the user gave in the findings pane, so it needs --by user.")
    commit = git("rev-parse", args.commit) if args.commit else None
    # `via` is only written when set, so ledgers from before it and answers given through Claude read the same
    extra = {"via": args.via} if args.via else {}
    append(*[{"type": "outcome", "id": i, "ts": now(), "outcome": args.outcome,
              "reason": args.reason or "", "by": args.by, "commit": commit, **extra} for i in ids])
    print(f"Recorded {args.outcome} for {', '.join(ids)}.")


def cmd_open(args):
    branch = current_branch()
    rows = [f for f in findings_state(load_events()).values()
            if f["outcome"] is None and (args.all or f.get("branch") == branch)
            and (not args.important or f["severity"] == "important")]
    print(f"{len(rows)} open finding(s)" + ("" if args.all else f" on {branch}") + ".")
    for f in rows:
        print(fmt_finding(f))


def cmd_status(args):
    """The branch's review state as one JSON object, for the plugin's status line and findings pane. It only reads:
    no git state, ledger or pending file changes. Outside an opted-in repo it prints `{"opted_in": false}`."""
    if not os.path.isdir(review_dir()):
        print(json.dumps({"opted_in": False}))
        return
    cfg = load_config()[0]
    branch = current_branch()
    state = findings_state(load_events())
    open_ = [f for f in state.values() if f["outcome"] is None and f.get("branch") == branch]
    runs = [e for e in load_events() if e["type"] == "run" and e.get("branch") == branch]
    last = runs[-1] if runs else None
    pending = None
    try:
        with open(os.path.join(review_dir(), ".pending.json")) as f:
            p = json.load(f)
        age = datetime.now(timezone.utc) - datetime.fromisoformat(str(p.get("ts")).replace("Z", "+00:00"))
        # a run abandoned mid-review leaves the file behind; after PENDING_STALE_HOURS it no longer counts as running
        if p.get("branch") == branch and age.total_seconds() < PENDING_STALE_HOURS * 3600:
            pending = {k: p.get(k) for k in ("round", "depth")}
    except (OSError, ValueError):
        pass
    changed = True  # since the last reviewed snapshot: commits, tracked edits or new files outside .review/
    if last and is_commit(last["target"]):
        ex = ":(exclude).review/**"
        changed = bool(git("diff", "--name-only", last["target"], "--", ".", ex, NOT_WORKTREES, check=False)
                       or git("ls-files", "--others", "--exclude-standard", "--", ".", ex, NOT_WORKTREES, check=False))
    # the committed change's risk tier, as ship-check works it out, so the user sees whether ship will land it alone;
    # none on the default branch, before the branch has commits, or when git can't find where it left the default
    db, tier = default_branch(), None
    if db and branch not in (db, "HEAD"):
        base = git("merge-base", "HEAD", *default_refs(db), check=False)
        rows = changed_raw(base, "HEAD") if base else []
        tier = risk_tier([p for p, _ in rows], cfg, symlinks_in(rows)) if rows else None
    print(json.dumps({
        "opted_in": True, "branch": branch, "default_branch": db, "tier": tier, "workflow": cfg["workflow"],
        "max_rounds": cfg["max_rounds"],
        "open": [{k: f.get(k) for k in ("id", "severity", "category", "file", "line", "title", "fix")} for f in open_],
        "important": sum(1 for f in open_ if f["severity"] == "important"),
        "nits": sum(1 for f in open_ if f["severity"] == "nit"),
        "backlog": sum(1 for f in state.values() if f["outcome"] == "deferred"),
        "last_run": {"round": last.get("round"), "depth": last.get("depth"), "clean": is_clean(last),
                     "check": last.get("check"), "thin": last.get("thin", []), "ts": last.get("ts"),
                     "changed_since": changed} if last else None,
        "pending": pending}))


def pct(n, d):
    return f"{100 * n / d:.0f}%" if d else "-"


def cmd_stats(args):
    events = load_events()
    cfg, rev = load_config()
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
            print(f"  {name:<16} {sum(c.values()):>4} {c['fixed']:>5} {c['wrong']:>5} {c['intentional']:>6} "
                  f"{c['wontfix']:>7} {c['deferred']:>8} {c['merged-past']:>6} {c['open']:>4} | {n:>7} {pct(lab['fixed'], n):>6} "
                  f"{pct(lab['wrong'] + lab['wontfix'], n):>5}")

    print(f"{len(runs)} runs, {len(findings)} findings. REVIEW.md version now: {rev or 'none'}.\n"
          "useful and noise count only labeled outcomes, decided by you or cleared by a later round (auto); "
          "agent-decided outcomes are unlabeled, and so are nits merged past. useful = fixed/labeled, "
          "noise = (wrong+wontfix)/labeled.")
    table("By severity", lambda f: f["severity"])
    table("By category", lambda f: f["category"])
    run_rev = {r["run"]: r.get("rev") for r in runs}
    table("By REVIEW.md version", lambda f: run_rev.get(f["run"]) or "none")
    table("By decider (trust user > auto > agent)", lambda f: f.get("by") or "open")
    yours = [f for f in findings if f.get("by") == "user"]
    if yours:
        pane = sum(1 for f in yours if f.get("via") == "ui")
        print(f"Your answers: {len(yours)}, {pane} given in the findings pane and {len(yours) - pane} through Claude.")
    checked = [f for f in findings if f.get("prev_by") == "agent" and f.get("by") == "user"]
    if checked:
        agree = sum(1 for f in checked if f["prev"] == f["outcome"])
        print(f"Spot-checks: you agreed with {agree}/{len(checked)} agent decisions.")

    cycles, current = defaultdict(list), {}
    for r in runs:  # runs recorded before cycles existed are grouped the way scope groups them
        key = (r["branch"], r["base"])
        prev = current.get(key)
        cid = r.get("cycle") or (prev if prev and not is_clean(cycles[prev][-1]) else r["run"])
        cycles[cid].append(r)
        current[key] = cid
    # a clean last round doesn't pass the cycle while one of its findings is open: finders are told not to repeat
    # open findings, so the round after a not_fixed one comes back clean
    open_runs = {f["run"] for f in findings if f["outcome"] is None and f["severity"] in FIXED_IN_LOOP}
    passed = [c for c in cycles.values() if is_clean(c[-1]) and not open_runs & {r["run"] for r in c}]
    capped = [c for c in cycles.values() if not is_clean(c[-1]) and len(c) >= cfg["max_rounds"]
              and not any(r.get("until_clean") for r in c)]  # an --until-clean cycle isn't stopped by the cap
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
        over = sum(1 for r in measured if r.get("nits_found", 0) > cfg["max_nits"])
        print(f"REVIEW.md compliance ({len(measured)} runs): finders raised {candidates} candidates; the verifier "
              f"rejected {rejected} ({pct(rejected, candidates)}), {guide} of them ({pct(guide, candidates)} of all "
              f"candidates) because REVIEW.md says not to flag them or calls them intentional; {over} run(s) found "
              f"more nits than the cap of {cfg['max_nits']}.")
    else:
        print("REVIEW.md compliance: not measured yet (runs recorded before compliance tracking).")
    thin = [r for r in runs if r.get("thin")]
    tested = [r for r in runs if r.get("depth") in ("standard", "deep")]  # quick rounds don't run the thin test
    if tested:
        rates = []
        for lens in ("change", "system", "security", *sorted({x for r in thin for x in r["thin"]}
                                                              - {"change", "system", "security"})):
            ran = [r for r in tested if lens != "security" or r.get("security")]
            n = sum(1 for r in ran if lens in r.get("thin", []))
            rates.append(f"{lens} {n}/{len(ran)} ({pct(n, len(ran))})")
        print(f"Thin finders: {len(thin)} run(s) had a finder come back empty twice without showing what it checked. "
              f"Thin rate per lens over standard and deep rounds: {', '.join(rates)}.")

    escapes = [e for e in events if e["type"] == "escape"]
    if escapes:
        dismissed = [e for e in escapes if e.get("finding") and
                     state.get(e["finding"], {}).get("outcome") in DISMISSED]
        print(f"Escapes: {len(escapes)} bug(s) shipped past review; {len(dismissed)} had been flagged and dismissed.")
    # an eval scores REVIEW.md without changing it, so it doesn't restart the count of findings since the last tuning
    learns = [e for e in events if e["type"] == "learn" and not e.get("eval_only") and e.get("summary") != LEGACY_EVAL]
    if learns:
        last = learns[-1]
        since = sum(1 for f in findings if f["outcome"] and f["resolved_ts"] > last["ts"])
        print(f"Last tuning: {last['ts'][:10]} ({last.get('rev_before')} -> {last.get('rev_after')}): {last['summary']}"
              + (f"; eval {last['eval']}" if last.get("eval") else "") + f". {since} finding(s) resolved since.")


def cmd_backlog(args):
    """Pre-existing findings deferred by review: old bugs worth fixing in their own change."""
    rows = [f for f in findings_state(load_events()).values() if f["outcome"] == "deferred"]
    print(f"{len(rows)} deferred pre-existing finding(s).")
    for f in rows:
        print(fmt_finding(f))


def cmd_reasons(args):
    rows = [f for f in findings_state(load_events()).values()
            if f["outcome"] in args.outcomes.split(",")]
    for f in rows[-args.limit:]:
        print(f"{f['id']} {f['outcome']:<11} {f.get('by') or '-':<5} {f['category']:<14} {f['file']}  {f['title']}"
              + (f" -- {f['reason']}" if f.get("reason") else ""))
    if not rows:
        print("No findings with those outcomes.")


def cmd_spotcheck(args):
    """Agent-decided outcomes the user has not confirmed yet: dismissals first, then fixes."""
    rows = [f for f in findings_state(load_events()).values() if f.get("by") == "agent"]
    rows.sort(key=lambda f: (f["outcome"] == "fixed", f["resolved_ts"]))
    print(f"{len(rows)} agent decision(s) unconfirmed; showing {min(args.n, len(rows))}.")
    for f in rows[:args.n]:
        print(f"{fmt_finding(f)}\n   agent: {f['outcome']}" + (f" -- {f['reason']}" if f.get("reason") else "")
              + f"\n   evidence: {f.get('evidence', '')}")


def cmd_escape(args):
    events = load_events()
    n = highest_id("E") + 1
    e = {"type": "escape", "id": f"E-{n}", "ts": now(), "commit": git("rev-parse", args.commit),
         "fix": git("rev-parse", args.fix) if args.fix else None, "file": args.file,
         "summary": args.summary, "finding": norm_id(args.finding) if args.finding else None}
    append(e)
    print(f"Recorded {e['id']} (introduced in {e['commit'][:10]}).")
    if e["finding"]:
        f = findings_state(events).get(e["finding"])
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
    only once the user says it isn't real."""
    db = default_branch()
    if not db:
        sys.exit("No default branch found.")
    log = git("log", "--first-parent", "--no-merges", "--format=%H%x09%s%x09%b%x1e", default_ref(), "-n", "300")
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
        paths = [p for p in git("show", "--name-only", "-z", "--format=", sha, "--", ".",
                                ":(exclude).review/**").split("\0") if p]
        if not paths or all(p.endswith(DOC_EXT) for p in paths):
            continue
        picked.append(f"{sha[:10]}  {subject}")
        if len(picked) == args.n:
            break
    print(f"{len(picked)} unlabeled commit(s) on {db}, never reverted or tied to an escape. That doesn't make them "
          "bug-free: a finding on one is a false alarm only if the user says it isn't real.")
    for line in picked:
        print(line)


def cmd_learned(args):
    _, rev = load_config()
    append({"type": "learn", "ts": now(), "rev_before": args.rev_before, "rev_after": rev,
            "summary": args.summary, "eval": args.eval, **({"eval_only": True} if args.eval_only else {})})
    print(f"Recorded eval of REVIEW.md {rev}." if args.eval_only
          else f"Recorded tuning (REVIEW.md {args.rev_before} -> {rev}).")


def cmd_config(args):
    cfg, rev = load_config()
    print(json.dumps({**cfg, "always_high": list(ALWAYS_HIGH), "rev": rev}, indent=1))


def repo_relpath(path, root):
    """path relative to the repo root, or None when it lies outside. git gives the root with symlinks resolved, so the
    path's folder is resolved too, or a project opened through a symlinked folder would be outside its own repo. The
    file itself isn't, so a symlink in the repo counts as inside it, wherever it points."""
    path = os.path.abspath(path)
    rel = os.path.relpath(os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path)),
                          os.path.realpath(root))
    # a name that only starts with "..", like `..cfg`, is inside
    return None if rel == os.pardir or rel.startswith(os.pardir + os.sep) else rel


def hook_repo(payload, path=None):
    """Repo root for a hook call when the repo opted in (has .review/), else None."""
    start = os.path.dirname(path) if path else payload.get("cwd")
    while start and not os.path.isdir(start):
        start = os.path.dirname(start)
    root = repo_root(start or None)
    if not root or not os.path.isdir(os.path.join(root, ".review")):
        return None
    if path and repo_relpath(path, root) is None:
        return None
    os.chdir(root)
    return root


def cmd_branch_guard(args):
    """PreToolUse hook on file edits: no edits on the default branch (REVIEW.md `branch: require`)."""
    try:
        payload = json.load(sys.stdin)
        tool_input = payload.get("tool_input", {})
        path = tool_input.get("file_path") or tool_input.get("notebook_path")
        # absolute now: hook_repo changes directory, and a relative path would name another file after that
        path = os.path.abspath(path) if path else None
        if not path or not hook_repo(payload, path) or load_config()[0].get("branch") != "require":
            return
        if repo_relpath(path, os.getcwd()).startswith(".review" + os.sep):
            return  # ledger bookkeeping, not project work
        branch, db = current_branch(), default_branch()
        # a detached HEAD is where ship leaves a worktree after landing; edits there belong on a branch too
        detached = branch == "HEAD"
        if not db or not has_commits() or (branch != db and not detached) or (detached and operation_in_progress()):
            return
        how = branch_start(db)
    except Exception:
        return
    where = db if branch == db else "a detached HEAD"
    sys.stderr.write(f"solo-review: this project works on branches, and you are on {where}. Before the first edit, "
                     f"{how} Then retry the edit.\n")
    sys.exit(2)


LEDGER_FILES = (".review/ledger.jsonl", ".review/.gitignore", ".review/.gitattributes")


def ledger_changes():
    """The tracked ledger files with uncommitted changes, never .pr-body.md or the other scratch files."""
    return [p for p in LEDGER_FILES if git("status", "--porcelain", "--", p, check=False)]


def uncommitted_files():
    """The paths outside .review/ with uncommitted changes, binary, mode-only and empty-file changes included, or None
    when git status fails (a corrupt index, say), which must not read as a clean tree."""
    # --no-optional-locks: a hook mustn't hold the index lock another git command needs; --untracked-files=all lists
    # each new file, whatever status.showUntrackedFiles says
    st = subprocess.run(["git", "--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--", ".",
                         ":(exclude).review/**", NOT_WORKTREES], capture_output=True, text=True)
    return st.stdout.splitlines() if st.returncode == 0 else None


def uncommitted_lines():
    """Lines added and removed outside .review/, for size only: binary, mode-only and empty-file changes have none,
    so uncommitted_files() says whether there are changes at all."""
    total = 0
    for line in git("diff", "--numstat", "HEAD", "--", ".", ":(exclude).review/**", check=False).splitlines():
        a, r, _ = line.split("\t", 2)
        total += (int(a) if a.isdigit() else 0) + (int(r) if r.isdigit() else 0)
    for path in git("ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude).review/**", NOT_WORKTREES,
                    check=False).splitlines():
        try:
            with open(path, errors="ignore") as f:
                total += sum(1 for _ in f)
        except OSError:
            pass
    return total


COMMIT_RULES = """\
solo-review git workflow for this repo. The user set this up; follow it without asking.
- {start}
- Commit as you work. Each time you finish one piece of a task, commit it before you start the next piece, so any piece can be reverted on its own. A task that changes the API, the UI, and shared code is three commits, not one. Don't ask first, and don't wait until the end.
- Stage paths explicitly (never `git add -A`{staging}). Subject: imperative mood, 72 characters at most; the body says why. Never use `--no-verify`; never amend a pushed commit.
- {finish}"""

STAGING_NEVER = " or `.review/`"
# the setup commit is the one place .review/ is staged
STAGING_FIRST = "; `.review/` only in the first setup commit, never after"

START_BRANCH = "Work on a branch. Before the first edit on {default}, {how}"
# A branch switched to before the first commit takes that commit, so the default branch would never exist
# Claude makes the setup commit itself without waiting; nothing reviews it but the user's read afterward (setup step 5)
START_FIRST_COMMIT = ("This repo has no commits yet. Make the first commit on {default} yourself, before other work, "
                      "without waiting for the user. It holds only the setup (REVIEW.md, CLAUDE.md, the pull request "
                      "template, and the three files in .review/ that `ledger.py init` made), so branches have a base "
                      "to be reviewed against and merge into. Nothing reviews that commit but the user's read of "
                      "REVIEW.md and CLAUDE.md afterward, so tell them that, and that corrections go on a branch "
                      "(`/solo-review:setup`, step 5). Then work on a branch: before the next edit, start one the "
                      "way the branch guard says.")

FINISH_AUTO = ("When a task is complete: run `{ledger} check` for the check command, run it yourself and show its output, "
               "rather than saying it works, then run /solo-review:review (it finds, fixes, and re-reviews by itself), "
               "then open the pull request with /solo-review:ship. Don't ask first. Ship lands a Low-risk change by "
               "itself (ship-check's `waits_for_user` is null); merge anything else only when the user says to.")
FINISH_MANUAL = ("The user is working manually (`workflow` is `manual`, the default; REVIEW.md can set `auto`). Do not run /solo-review:review or "
                 "/solo-review:ship on your own when a task is complete; the user will ask for them. Never merge unless "
                 "the user says to, except that /solo-review:ship, when they ask for it, lands a Low-risk change by "
                 "itself.")


def hook_context(event, text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}))


def workflow_rules():
    """The workflow rules and the current state. The SessionStart hook gives them to each session, and `init` prints
    them for the session that opts the project in, which started before the hook would act."""
    branch, born = current_branch(), has_commits()
    # before the first commit, the branch HEAD names is the one that becomes the default
    db = default_branch() or (branch if not born else "the default branch")
    opened = [f["severity"] for f in findings_state(load_events()).values()
              if f["outcome"] is None and f["severity"] in FIXED_IN_LOOP and f.get("branch") == branch]
    dirty = uncommitted_files()
    changes = ("uncommitted changes unknown (git status failed)" if dirty is None else
               f"{len(dirty)} file(s) with uncommitted changes" + (f" ({uncommitted_lines()} lines)" if dirty else ""))
    state = (f"Now: on {branch}, {changes}, "
             f"{opened.count('important')} open Important finding(s) and {opened.count('nit')} open nit(s) on this branch.")
    if born and branch == db and ledger_changes():
        state += " The review ledger has uncommitted entries; /solo-review:ship commits them."
    if (born and not in_linked_worktree() and branch == db
            and git("rev-parse", "--verify", "--quiet", f"origin/{db}", check=False)):
        # a merge on GitHub, or a ship from another clone, moves origin, so this checkout (and a plugin loaded from
        # it) can fall behind
        behind = git("rev-list", "--count", f"HEAD..origin/{db}", check=False)
        # the remote picks db, so it is quoted, and a name ship-check refuses gets no command at all
        if behind not in ("", "0") and dirty == [] and re.fullmatch(SAFE_BRANCH, db):
            state += (f" This checkout is {behind} commit(s) behind origin/{db}: run "
                      f"`git merge --ff-only {shlex.quote('origin/' + db)}`.")
    here = os.path.realpath(os.getcwd())
    others = [f"{p} ({b or 'detached'})" for p, b in worktrees() if os.path.realpath(p) != here]
    if others:
        state += " Other worktrees: " + "; ".join(others[:6]) + "."
    ledger = shlex.quote(os.path.join(PLUGIN_ROOT, "scripts", "ledger.py"))
    finish = (FINISH_MANUAL if load_config()[0]["workflow"] == "manual"
              else FINISH_AUTO.format(ledger=f"python3 {ledger}"))
    start = (START_BRANCH.format(default=db, how=branch_start(db)) if born
             else START_FIRST_COMMIT.format(default=db))
    staging = STAGING_NEVER if born else STAGING_FIRST
    return COMMIT_RULES.format(start=start, staging=staging, finish=finish) + "\n" + state


def cmd_session_context(args):
    """SessionStart hook: the workflow rules and the current state, for opted-in repos."""
    if not hook_repo(json.load(sys.stdin)):
        return
    hook_context("SessionStart", workflow_rules())


def cell(text):
    """Make text safe for one Markdown table cell: single line, rendered literally (no HTML, links,
    mentions, or code spans), pipes escaped."""
    t = " ".join(str(text).split())
    for ch, ent in (("&", "&amp;"), ("<", "&lt;"), (">", "&gt;"), ("[", "&#91;"), ("]", "&#93;"),
                    ("@", "&#64;"), ("`", "&#96;")):
        t = t.replace(ch, ent)
    return t.replace("|", "\\|")


def cmd_pr_summary(args):
    """Markdown review summary for this branch's pull request description."""
    branch = current_branch()
    events = load_events()
    runs = [e for e in events if e["type"] == "run" and e["branch"] == branch]
    rows = [f for f in findings_state(events).values() if f.get("branch") == branch]
    thin = [r for r in runs if r.get("thin")]
    note = (f" In {len(thin)} round(s), a finder ({cell(', '.join(sorted({x for r in thin for x in r['thin']})))}) "
            "returned no findings twice without showing what it checked, so those rounds covered less than their "
            "result shows." if thin else "")
    dups = branch_duplicates(events, branch)
    if dups:
        note += (f" Ids {cell(', '.join(dups))} each name two findings, from reviews in two clones, and this table "
                 "shows only the later one: read both in .review/ledger.jsonl.")
    print(f"{len(runs)} round(s), {len(rows)} finding(s), "
          f"{sum(1 for f in rows if f['outcome'] is None)} open.{note}\n")
    if rows:
        print("| Finding | Severity | Where | Outcome |\n|---|---|---|---|")
        for f in rows:
            outcome = f["outcome"] or "open"
            if f["outcome"]:
                outcome += f" ({f.get('by')}" + (f", {f['commit'][:7]}" if f.get("commit") else "") + ")"
                if f.get("reason"):
                    outcome += f": {f['reason']}"
            where = " ".join(f"{f['file']}:{f.get('line', '?')}".split()).replace("`", "").replace("|", "\\|")
            print(f"| {f['id']} {cell(f['title'])} | {f['severity']} | `{where}` | {cell(outcome)} |")
        # what each finding rests on, so the person deciding the merge can judge it without the agent session
        basis = [(f["id"], [(label, f.get(key)) for label, key in
                            (("Evidence", "evidence"), ("Verifier", "verified"), ("Fix", "fix")) if f.get(key)])
                 for f in rows]
        if any(parts for _, parts in basis):
            print("\n<details><summary>Evidence for each finding</summary>\n")
            for fid, parts in basis:
                if parts:
                    print(f"- **{fid}** " + " ".join(f"{label}: {cell(text)}" for label, text in parts))
            print("\n</details>")


def worktree_with(branch):
    """The path of the worktree that has `branch` checked out, or None. Git refuses to check a branch out in two
    worktrees, so ship can't `git switch` to the default branch while another worktree holds it."""
    path = None
    for line in git("worktree", "list", "--porcelain", check=False).splitlines():
        if line.startswith("worktree "):
            path = line[9:]
        elif line == f"branch refs/heads/{branch}":
            return path
    return None


def worktrees():
    """(path, branch or None when detached) for every checkout, the main checkout first."""
    out = []
    for line in git("worktree", "list", "--porcelain", check=False).splitlines():
        if line.startswith("worktree "):
            out.append([line[9:], None])
        elif line.startswith("branch refs/heads/") and out:
            out[-1][1] = line[len("branch refs/heads/"):]
    return [tuple(w) for w in out]


def in_linked_worktree():
    """True in a worktree made by `git worktree add`, False in the main checkout."""
    return (os.path.realpath(git("rev-parse", "--git-dir", check=False) or ".")
            != os.path.realpath(git("rev-parse", "--git-common-dir", check=False) or "."))


def operation_in_progress():
    """A rebase, merge, cherry-pick or revert is underway here. HEAD is detached during a rebase, and its conflict
    edits must go through."""
    return any(os.path.exists(git("rev-parse", "--git-path", p, check=False))
               for p in ("rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"))


def branch_start(db):
    """How to start a branch from here: a plain branch in this checkout, which takes uncommitted changes with it."""
    how = ("run `git switch -c <type>/<short-name>` (feat, fix, refactor, docs, chore). Uncommitted changes come "
           "with you.")
    if in_linked_worktree():
        how += " On a branch named for you (such as `worktree-<name>`), rename it first: `git branch -m <type>/<short-name>`."
    return how


def cmd_ship_check(args):
    """Is the current branch ready to land? Prints JSON for /solo-review:ship."""
    cfg, _ = load_config()
    branch, db = current_branch(), default_branch()
    out = {"branch": branch, "default": db, "merge": cfg["merge"], "problems": []}
    # before the first commit there's no default branch yet, so the check below would say main doesn't exist
    if not has_commits():
        out["problems"].append(f"no commits yet: make the setup commit on {branch} first (/solo-review:setup, "
                               "step 5); that branch becomes the default")
        print(json.dumps(out, indent=1))
        return
    if not db or branch in (db, "HEAD"):
        # Entries recorded on the default branch (a --range review, resolve, review-learn) have no branch to ride on,
        # so ship commits them on their own instead of leaving the tree dirty
        files = ledger_changes()
        upstream = git("rev-parse", "--abbrev-ref", f"{db}@{{u}}", check=False) if db else ""
        ahead = [git("rev-list", "--count", f"{upstream}..HEAD", *spec) or "0" for spec in
                 ((), ("--", ".", ":(exclude).review/**"))] if upstream else ["0", "0"]
        unpushed, unpushed_code = int(ahead[0]), int(ahead[1])
        # An unpushed ledger-only commit (say, from a push that failed) still needs pushing, so it counts too
        if (branch == db and re.fullmatch(SAFE_BRANCH, db) and (files or unpushed) and not unpushed_code
                and uncommitted_files() == []):
            out.update(ledger_only=True, ledger_files=files, upstream=upstream or None)
        elif not db:
            out["problems"].append("no default branch to land on: there is no main or master branch, and "
                                   "origin/HEAD isn't set")
        else:
            out["problems"].append(f"not on a feature branch (on {branch})")
            if unpushed_code:
                out["problems"].append(f"{db} has {unpushed_code} unpushed commit(s) outside .review/: "
                                       f"move them to a branch to review them")
        print(json.dumps(out, indent=1))
        return
    base = default_merge_base(db)
    if not re.fullmatch(SAFE_BRANCH, branch):
        out["problems"].append("unsafe branch name: characters outside [A-Za-z0-9._/-]; rename it before shipping")
    if not re.fullmatch(SAFE_BRANCH, db):
        out["problems"].append("unsafe default branch name: characters outside [A-Za-z0-9._/-]; stop and tell the user")
    out["commits"] = git("log", "--oneline", f"{base}..HEAD").splitlines()
    out["upstream"] = git("rev-parse", "--abbrev-ref", f"{db}@{{u}}", check=False) or None
    # an origin-only clone has refs/remotes/origin/<db> but no local branch to rebase onto or land on
    out["local_default"] = "refs/heads/" + db in default_refs(db)
    # ship lands without checking the default branch out, and catches it up where it is checked out, if anywhere
    out["default_worktree"] = worktree_with(db)
    out["linked_worktree"] = in_linked_worktree()
    remote = git("remote", "get-url", "origin", check=False)
    out["github"] = bool(re.search(r"github\.com[:/]", remote)) and shutil.which("gh") is not None
    out["pr_template"] = find_pr_template()
    out["check"] = check_command(cfg)
    if not out["commits"]:
        out["problems"].append("no commits to ship")
    dirty = uncommitted_files()
    if dirty is None:
        out["problems"].append("git status failed, so uncommitted changes can't be ruled out")
    elif dirty:
        # not stash: the stash list is shared by every worktree, so another session can pop this one's changes
        out["problems"].append("uncommitted changes: commit them first")
    events = load_events()
    # "A PR can't merge while any finding ... is still open": nits too, not only Important findings
    open_ids = [f["id"] for f in findings_state(events).values() if f["outcome"] is None and f.get("branch") == branch]
    if open_ids:
        out["problems"].append(f"open findings: {', '.join(open_ids)}")
    out["duplicate_ids"] = branch_duplicates(events, branch)
    runs = [e for e in events if e["type"] == "run" and e["branch"] == branch]
    rows = changed_raw(base, "HEAD")
    branch_files, links = [p for p, _ in rows], symlinks_in(rows)
    # "Some paths always need a person": an agent review never clears these on its own
    out["high_files"] = [f for f in branch_files if is_high(f, cfg, links)]
    if not runs:
        out["problems"].append("branch was never reviewed")
    else:
        last = runs[-1]["target"]
        if subprocess.run(["git", "cat-file", "-e", f"{last}^{{commit}}"], capture_output=True).returncode:
            out["problems"].append("last review snapshot is gone: review again")
        elif branch_files and git("diff", "--name-only", last, "HEAD", "--", *branch_files):
            out["problems"].append("changes since the last review round")
    # Low risk needs no person "once automated review and security checks are green", so ship lands it by itself. A Low
    # change whose review covered less than it shows, or whose added lines touch a sink, waits like any other: the
    # article's second classifier, which asks for a person even when the tier says none is needed.
    tier = out["tier"] = risk_tier(branch_files, cfg, links)
    # "Only trusted authors get the lighter paths": a commit someone else wrote, such as a contributor's PR checked out
    # here, waits whatever its paths. The reason gives a count, not the emails, since whoever made the commits picks them.
    # Author email is forgeable, so this guards the honest PR-checkout case and is not a trust boundary.
    mine = {e.lower() for e in [git("config", "user.email", check=False), *cfg["trusted"]] if e}
    others = sum(1 for line in git("log", "--format=%H %ae", f"{base}..HEAD").splitlines()
                 if line.partition(" ")[2].lower() not in mine)
    if tier == "high":
        out["waits_for_user"] = "High risk: the user reads the High-risk files, then says to merge"
    elif tier == "medium":
        out["waits_for_user"] = "Medium risk: it lands when the user says to merge"
    elif others:
        out["waits_for_user"] = (f"Low risk, but {others} commit(s) on it are by someone other than the user, and only "
                                 "trusted authors get the Low path")
    elif out["problems"]:
        out["waits_for_user"] = "Low risk, but ship-check reports problems"
    elif any(r.get("thin") for r in runs):
        out["waits_for_user"] = "Low risk, but a review round came back thin, so it covered less than its result shows"
    elif security_hint(git("diff", "-U0", base, "HEAD", "--", ".", ":(exclude).review/**")):
        out["waits_for_user"] = "Low risk, but its added lines touch a security sink"
    else:
        out["waits_for_user"] = None
    print(json.dumps(out, indent=1))


def shell_commands(text):
    """Split a shell command line into its simple commands, each a list of words, roughly as the shell would: quotes
    keep `;`, `|` and newlines inside a word, `#` starts a comment, here-document bodies are skipped, redirection
    targets aren't words, and the commands inside `$(...)` and backticks are listed too (inside double quotes as
    well, where the quoted word resumes after them). Subshells and pipelines aren't marked: the push gate checks every
    directory a line names, so it doesn't need to know which one a command runs in. It never raises: an unterminated
    quote just ends its word."""
    cmds, n = [], len(text)

    def parse(i, stop):
        """Parse from i up to the `)` or backtick that closes a nested command (stop), or to the end; return the
        position after it."""
        words, buf = [], None  # buf holds the current word's characters, None between words
        heredocs, skip_word, depth = [], False, 0  # delimiters whose bodies start at the next newline; the word
        # after a redirection; unclosed `(`

        def end_word():
            nonlocal buf, skip_word
            if buf is not None and not skip_word:
                words.append("".join(buf))
            elif buf is not None:
                skip_word = False
            buf = None

        def end_command():
            end_word()
            if words:
                cmds.append(words[:])
                words.clear()

        while i < n:
            c = text[i]
            if c == "\\":
                if text.startswith("\\\n", i):  # line continuation
                    i += 2
                    continue
                buf = [] if buf is None else buf
                buf.append(text[i + 1:i + 2])
                i += 2
            elif c == "'":
                j = text.find("'", i + 1)
                j = n if j < 0 else j
                buf = [] if buf is None else buf
                buf.extend(text[i + 1:j])
                i = j + 1
            elif c == '"':
                buf, i = [] if buf is None else buf, i + 1
                while i < n and text[i] != '"':
                    if text[i] == "`" or text.startswith("$(", i):
                        i = parse(i + (1 if text[i] == "`" else 2), "`" if text[i] == "`" else ")")
                        continue
                    if text[i] == "\\" and i + 1 < n:
                        i += 1
                    buf.append(text[i])
                    i += 1
                i += 1
            elif c == "#" and buf is None:
                j = text.find("\n", i)
                i = n if j < 0 else j
            elif c == "\n":
                end_command()
                i += 1
                for delim, tabs in heredocs:
                    while i < n:
                        j = text.find("\n", i)
                        j = n if j < 0 else j
                        line, i = text[i:j], j + 1
                        if (line.lstrip("\t") if tabs else line) == delim:
                            break
                heredocs.clear()
            elif c == "`" and stop == "`":
                break
            elif c == "`" or text.startswith("$(", i):
                buf = [] if buf is None else buf  # the substitution is (part of) a word
                i = parse(i + (1 if c == "`" else 2), "`" if c == "`" else ")")
            elif c == "(":
                end_command()
                depth += 1
                i += 1
            elif c == ")":
                end_command()
                if depth:
                    depth -= 1
                elif stop == ")":
                    break
                i += 1
            elif c in ";&|":
                end_command()
                i += 1
            elif c in "<>":
                if buf is not None and "".join(buf).isdigit():
                    buf = None  # the fd number in 2>&1 isn't a word
                end_word()
                if text.startswith("(", i + 1):  # process substitution <(...) or >(...): a nested command
                    i = parse(i + 2, ")")
                    buf = []  # its file name is an argument
                    continue
                if text.startswith("<<<", i):
                    i += 3
                elif text.startswith("<<", i):
                    i += 2
                    tabs = text.startswith("-", i)
                    i += tabs
                    while i < n and text[i] in " \t":
                        i += 1
                    delim = []
                    while i < n and text[i] not in " \t\n;&|()<>":
                        if text[i] not in "'\"\\":
                            delim.append(text[i])
                        i += 1
                    heredocs.append(("".join(delim), tabs))
                    continue
                else:
                    i += 1
                    while i < n and text[i] in "<>&|":
                        i += 1
                skip_word = True
            elif c in " \t\r":
                end_word()
                i += 1
            else:
                buf = [] if buf is None else buf
                buf.append(c)
                i += 1
        end_command()
        return i + 1

    parse(0, None)
    return cmds


SHELL_RESERVED = {"!", "{", "}", "if", "then", "elif", "else", "fi", "do", "done", "while", "until"}
# commands that run the rest of their arguments as a command, with their options that take an argument
WRAPPERS = {"sudo": {"-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"}, "doas": {"-u", "-C"},
            "env": {"-u", "-C"}, "command": set(), "exec": {"-a"}, "nohup": set(), "nice": {"-n"}, "time": {"-f", "-o"},
            "builtin": set(), "timeout": {"-s", "-k"}, "xargs": {"-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"}}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
GIT_OPTS_WITH_ARG = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env",
                     "--attr-source"}


def push_dirs(command, cwd, depth=0):
    """Every directory a shell command line's `git push` might run from: the one it starts in, and each one a `cd` or
    `git -C` in it names (a relative one resolved against the cds before it). [] when the line runs no push.
    The gate checks all of them rather than working out which one the shell is in at the push, so a subshell, a
    pipeline or a target it can't resolve makes it check more repos, never fewer. Recognizes a push behind
    separators, newlines, subshells, command substitution, shell keywords, variable assignments, wrappers (sudo,
    env, timeout, ...), `sh -c`, `eval` and git's global options. Git aliases and scripts that push are not seen."""
    if depth > 3:
        return []
    dirs, pushed = [cwd], False
    for words in shell_commands(command):
        i = 0
        while i < len(words):
            w, base = words[i], os.path.basename(words[i])
            if w in SHELL_RESERVED or re.match(r"[A-Za-z_][A-Za-z0-9_]*=", w):
                i += 1
            elif base in WRAPPERS:
                i += 1
                while i < len(words) and words[i].startswith("-") and words[i] != "-":
                    i += 2 if words[i] in WRAPPERS[base] else 1
                if base == "timeout":
                    i += 1  # the duration
            elif base in SHELLS or base == "eval":
                rest = words[i + 1:]
                script = " ".join(rest) if base == "eval" else next(
                    (rest[j + 1] for j, a in enumerate(rest[:-1]) if re.fullmatch(r"-[a-z]*c[a-z]*", a)), "")
                inner = push_dirs(script, cwd, depth + 1)
                dirs += inner
                pushed = pushed or bool(inner)
                i = len(words)
            else:
                break
        if i >= len(words):
            continue
        if words[i] == "cd":
            target = next((a for a in words[i + 1:] if a == "-" or not a.startswith("-")), "~")
            if target != "-":  # `cd -` goes back to a directory already in the list
                cwd = os.path.join(cwd, os.path.expanduser(target))
                dirs.append(cwd)
            continue
        if os.path.basename(words[i]) != "git":
            continue
        where, i = cwd, i + 1
        while i < len(words) and words[i].startswith("-"):
            if words[i] in GIT_OPTS_WITH_ARG and i + 1 < len(words):
                if words[i] == "-C":
                    where = os.path.join(where, os.path.expanduser(words[i + 1]))
                    dirs.append(where)
                i += 2
            else:
                i += 1
        if i < len(words) and words[i] == "push":
            pushed = True
    return [os.path.abspath(d) for d in dirs] if pushed else []


def cmd_gate(args):
    """PreToolUse hook on every Bash call: block a command that runs `git push` while any finding, Important or nit,
    is open on the branch of a repo the command starts in or names. That is ship's own rule ("a PR can't merge
    while any finding is still open"), so a push outside ship can't get ahead of it."""
    try:
        payload = json.load(sys.stdin)
        command = payload.get("tool_input", {}).get("command", "")
        if not isinstance(command, str):
            return
        blocked = {}
        for where in dict.fromkeys(push_dirs(command, payload.get("cwd") or os.getcwd())):
            root = hook_repo({**payload, "cwd": where})
            if not root or root in blocked or load_config()[0].get("gate") != "push":
                continue
            branch = current_branch()
            open_ = [f for f in findings_state(load_events()).values()
                     if f["outcome"] is None and f.get("branch") == branch]
            if open_:
                blocked[root] = (branch, open_)
    except Exception:
        return  # the gate must never break unrelated work
    for root, (branch, open_) in blocked.items():
        lines = "\n".join(fmt_finding(f) for f in open_[:10])
        sys.stderr.write(f"solo-review: {len(open_)} finding(s) are open on {branch} in {root}. Fix each one or "
                         f"resolve it with a reason (/solo-review:review resolve ...) before pushing: ship lands "
                         f"nothing while a finding is open.\n{lines}\n")
    if blocked:
        sys.exit(2)


def main():
    p = argparse.ArgumentParser(prog="ledger.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    s = sub.add_parser("scope")
    s.add_argument("--base")
    s.add_argument("--range", help="A..B: review commits instead of the working tree")
    s.add_argument("--depth", choices=("quick", "standard", "deep"))
    s.add_argument("--force", action="store_true", help="ignore the round cap for this round")
    s.add_argument("--until-clean", action="store_true",
                   help="ignore the round cap for the rest of this cycle, until a round comes back clean")
    s.add_argument("--fresh", action="store_true",
                   help="review the whole change from its base again, not only what changed since the last round")
    s = sub.add_parser("record")
    s.add_argument("--file", help="JSON input file (deleted after reading); default stdin")
    s = sub.add_parser("resolve")
    s.add_argument("ids", nargs="+")
    s.add_argument("--as", dest="outcome", required=True)
    s.add_argument("--reason", default="")
    s.add_argument("--by", default="user", choices=("user", "agent"))
    s.add_argument("--commit", help="commit that carries the fix")
    s.add_argument("--via", choices=("ui",), help="the user answered in the findings pane (set by the plugin's module)")
    s = sub.add_parser("open")
    s.add_argument("--all", action="store_true")
    s.add_argument("--important", action="store_true")
    sub.add_parser("status")
    sub.add_parser("stats")
    sub.add_parser("backlog")
    s = sub.add_parser("reasons")
    s.add_argument("--outcomes", default=",".join(DISMISSED))
    s.add_argument("--limit", type=int, default=40)
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
    s = sub.add_parser("spotcheck")
    s.add_argument("--n", type=int, default=3)
    s = sub.add_parser("check")
    s.add_argument("--record", action="store_true")
    s.add_argument("--status", type=int)
    s.add_argument("--file", help="file holding a one-line summary of the check's output (deleted after reading); "
                                  "default stdin")
    sub.add_parser("ship-check")
    sub.add_parser("pr-summary")
    sub.add_parser("config")
    hooks = ("gate", "branch-guard", "session-context")
    for hook in hooks:
        sub.add_parser(hook)
    args = p.parse_args()

    handler = globals()[f"cmd_{args.cmd.replace('-', '_')}"]
    if args.cmd in hooks:  # hooks find their repo from the payload, and fail open: only a deliberate exit 2 blocks
        try:
            handler(args)
        except SystemExit as e:
            if e.code == 2:
                raise
        except Exception:
            pass
        return
    root = repo_root()
    if not root and args.cmd == "status":  # the status line asks from any directory
        print(json.dumps({"opted_in": False}))
        return
    if not root:
        sys.exit("Not inside a git repository." + (" For a new project, run `git init` in its directory first."
                                                    if args.cmd == "init" else ""))
    os.chdir(root)
    handler(args)


if __name__ == "__main__":
    main()
