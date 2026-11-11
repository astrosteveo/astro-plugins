#!/usr/bin/env python3
"""List a codebase's code by directory, with line counts, for /bug-hunt:hunt to map into components.

Prints a short summary and a list of units: directories, or groups of files, each with at most
--budget lines of code, the amount one hunter can read in full. Vendored, generated and binary
files are left out, tests and other text files are counted apart from code, and each unit shows how
many of the repo's recent commits touched it. The output stays bounded on a large repo, so the
skill can read it whole instead of a raw file listing.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

DEFAULT_BUDGET = 3000
MAX_UNITS = 300
RECENT_COMMITS = 300

# Directories whose files someone else wrote or a tool made. Within git, ignored build output is
# already left out; this catches what's committed anyway, and everything when there's no git.
VENDORED_DIRS = {
    "node_modules", "vendor", "third_party", "third-party", "thirdparty", "external",
    "bower_components", "Pods", "Carthage", "site-packages", ".godot", "__pycache__",
}
# Left out only when walking a folder without git, where nothing says what is build output.
BUILD_DIRS = {
    "dist", "build", "out", "target", "bin", "obj", "coverage", "venv", "env", ".venv",
    ".tox", ".gradle", ".next", ".nuxt", ".cache",
}
GENERATED_NAMES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Cargo.lock", "go.sum",
    "poetry.lock", "Pipfile.lock", "composer.lock", "Gemfile.lock", "uv.lock", "packages.lock.json",
}
GENERATED_PATTERNS = re.compile(
    r"(\.min\.(js|css)|\.map|\.pb\.go|_pb2\.pyi?|_pb2_grpc\.py|\.g\.cs|\.g\.i\.cs|\.designer\.cs"
    r"|[._-]generated\.[a-z]+|\.gen\.go)$",
    re.I,
)
GENERATED_MARKER = re.compile(rb"(code generated .{0,80}do not edit|@generated|auto-generated)", re.I)

CODE_EXTENSIONS = {
    "py", "pyi", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "go", "rs", "java", "kt",
    "kts", "scala", "groovy", "cs", "fs", "fsx", "vb", "c", "h", "cc", "cpp", "cxx", "hpp", "hh",
    "hxx", "m", "mm", "swift", "rb", "php", "pl", "pm", "lua", "gd", "gdshader", "shader", "glsl",
    "hlsl", "wgsl", "sh", "bash", "zsh", "fish", "ps1", "psm1", "sql", "r", "jl", "dart", "ex",
    "exs", "erl", "hrl", "clj", "cljs", "cljc", "elm", "hs", "ml", "mli", "nim", "zig", "v", "sv",
    "vue", "svelte", "astro", "cr", "d", "pas", "ada", "adb", "ads", "f90", "for", "cob", "tcl",
}
MANIFESTS = {
    "package.json", "tsconfig.json", "deno.json", "Cargo.toml", "go.mod", "pyproject.toml",
    "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pom.xml", "build.gradle",
    "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "Gemfile", "composer.json",
    "mix.exs", "pubspec.yaml", "Package.swift", "CMakeLists.txt", "Makefile", "meson.build",
    "project.godot", "Directory.Build.props", "global.json", "deno.jsonc", "build.zig",
}
MANIFEST_SUFFIXES = (".csproj", ".fsproj", ".vbproj", ".sln", ".slnx", ".cabal", ".gemspec", ".nimble")

TEST_DIRS = {"test", "tests", "__tests__", "spec", "specs", "testing", "test_", "unittests"}
TEST_NAME = re.compile(
    r"(^test_.+|.+_test\.[a-z]+$|.+\.(test|spec)\.[a-z]+$|.+Tests?\.(cs|java|kt|swift|scala|fs)$"
    r"|.+_spec\.rb$|.+Spec\.(groovy|scala|kt)$)"
)


def git(root: Path, *args: str) -> str | None:
    try:
        done = subprocess.run(
            ["git", "-C", str(root), *args], capture_output=True, check=True, timeout=120
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout.decode("utf-8", "replace")


def find_root(start: Path) -> tuple[Path, bool]:
    top = git(start, "rev-parse", "--show-toplevel")
    if top and top.strip():
        return Path(top.strip()), True
    return start, False


def list_files(root: Path, in_git: bool, scope: list[str]) -> list[str]:
    if in_git:
        out = git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", *scope)
        if out is not None:
            return sorted({p for p in out.split("\0") if p and (root / p).is_file()})
    found = []
    starts = [root / s for s in scope] if scope else [root]
    for start in starts:
        if start.is_file():
            found.append(start.relative_to(root).as_posix())
            continue
        for here, dirs, files in os.walk(start):
            dirs[:] = sorted(
                d for d in dirs if not d.startswith(".") and d not in VENDORED_DIRS | BUILD_DIRS
            )
            for name in files:
                found.append((Path(here) / name).relative_to(root).as_posix())
    return sorted(set(found))


def classify(root: Path, rel: str) -> tuple[str, int]:
    """The file's kind, one of code, test, other, vendored, generated or binary, and its lines."""
    parts = rel.split("/")
    name = parts[-1]
    if any(p in VENDORED_DIRS for p in parts[:-1]):
        return "vendored", 0
    if name in GENERATED_NAMES or GENERATED_PATTERNS.search(name):
        return "generated", 0
    try:
        with open(root / rel, "rb") as f:
            head = f.read(8000)
            if b"\0" in head:
                return "binary", 0
            if GENERATED_MARKER.search(head[:1000]):
                return "generated", 0
            lines, last = head.count(b"\n"), head[-1:]
            for chunk in iter(lambda: f.read(1 << 16), b""):
                lines += chunk.count(b"\n")
                last = chunk[-1:]
    except OSError:
        return "other", 0
    if last and last != b"\n":
        lines += 1
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in CODE_EXTENSIONS and not (not ext and head.startswith(b"#!")):
        return "other", lines
    if TEST_NAME.match(name) or any(p.lower() in TEST_DIRS for p in parts[:-1]):
        return "test", lines
    return "code", lines


def recent_commits(root: Path, in_git: bool) -> dict[str, set[int]]:
    """For each file, which of the last RECENT_COMMITS commits touched it."""
    touched: dict[str, set[int]] = defaultdict(set)
    if not in_git:
        return touched
    out = git(root, "log", f"-n{RECENT_COMMITS}", "--format=%x00", "--name-only", "--no-renames")
    if not out:
        return touched
    for i, block in enumerate(out.split("\0")[1:]):
        for line in block.splitlines():
            if line.strip():
                touched[line.strip()].add(i)
    return touched


class Unit:
    def __init__(self, label: str, files: list[str]):
        self.label = label
        self.files = files


def make_units(code: dict[str, int], budget: int) -> list[Unit]:
    """Split the code into units of at most budget lines, top down: a directory that fits is one
    unit, a bigger one splits into its subdirectories and its own files."""
    tree: dict[str, list[str]] = defaultdict(list)  # directory -> its own code files
    for rel in code:
        tree[rel.rsplit("/", 1)[0] if "/" in rel else ""].append(rel)

    def lines_under(prefix: str) -> list[str]:
        return [f for f in code if prefix == "" or f.startswith(prefix + "/")]

    def subdirs(prefix: str) -> list[str]:
        depth = 0 if prefix == "" else prefix.count("/") + 1
        found = set()
        for d in tree:
            if d and (prefix == "" or d.startswith(prefix + "/")):
                found.add("/".join(d.split("/")[: depth + 1]))
        return sorted(found)

    units: list[Unit] = []

    def split(prefix: str) -> None:
        files = lines_under(prefix)
        if not files:
            return
        if sum(code[f] for f in files) <= budget:
            units.append(Unit((prefix + "/") if prefix else "./", sorted(files)))
            return
        for sub in subdirs(prefix):
            split(sub)
        own = sorted(tree.get(prefix, []))
        if not own:
            return
        where = (prefix + "/") if prefix else ""
        if sum(code[f] for f in own) <= budget:
            units.append(Unit(f"{where}* (files directly in it)", own))
            return
        # A file over the budget is a unit of its own; the rest are packed in name order, which
        # keeps related names such as bridge.gd and bridge_host.gd together.
        groups: list[list[str]] = []
        group: list[str] = []
        for f in own:
            if code[f] > budget:
                groups.append([f])
                continue
            if group and sum(code[g] for g in group) + code[f] > budget:
                groups.append(group)
                group = []
            group.append(f)
        if group:
            groups.append(group)
        for g in sorted(groups):
            units.append(Unit(chunk_label(where, g), g))

    split("")
    return units


def chunk_label(where: str, group: list[str]) -> str:
    names = [g.rsplit("/", 1)[-1] for g in group]
    if len(names) == 1:
        return where + names[0]
    return f"{where}{{{', '.join(names)}}}"


def number(n: int) -> str:
    return f"{n:,}"


def count(n: int, noun: str) -> str:
    return f"{number(n)} {noun}" + ("" if n == 1 else "s")


def report(start: Path, scope: list[str], budget: int) -> str:
    root, in_git = find_root(start)
    rel_scope = []
    for s in scope:
        p = (start / s).resolve()
        if not p.exists():
            raise SystemExit(f"No such file or directory: {s}")
        rel_scope.append(p.relative_to(root.resolve()).as_posix() or ".")
    files = list_files(root, in_git, [s for s in rel_scope if s != "."])

    kinds: dict[str, dict[str, int]] = defaultdict(dict)
    manifests = []
    for rel in files:
        kind, lines = classify(root, rel)
        kinds[kind][rel] = lines
        name = rel.rsplit("/", 1)[-1]
        if (name in MANIFESTS or name.endswith(MANIFEST_SUFFIXES)) and kind not in ("vendored", "binary"):
            manifests.append(rel)

    code, tests = kinds["code"], kinds["test"]
    touched = recent_commits(root, in_git)
    units = make_units(code, budget)

    languages: dict[str, int] = defaultdict(int)
    for rel, lines in code.items():
        name = rel.rsplit("/", 1)[-1]
        languages[name.rsplit(".", 1)[-1].lower() if "." in name else "script"] += lines

    out = [f"root: {root}" + ("" if in_git else " (not a git repo: no recent commits)")]
    if rel_scope:
        out.append("scope: " + ", ".join(rel_scope))
    out.append(
        f"code: {count(len(code), 'file')}, {count(sum(code.values()), 'line')}, in {count(len(units), 'unit')}"
        f" of at most {number(budget)} lines"
    )
    out.append(f"tests: {count(len(tests), 'file')}, {count(sum(tests.values()), 'line')}")
    if languages:
        top = sorted(languages.items(), key=lambda kv: -kv[1])[:8]
        out.append("languages (code lines): " + ", ".join(f"{k} {number(v)}" for k, v in top))
    out.append("manifests: " + (", ".join(manifests[:30]) if manifests else "none"))
    if len(manifests) > 30:
        out[-1] += f", and {len(manifests) - 30} more"
    left_out = [f"{len(kinds[k])} {k}" for k in ("vendored", "generated", "binary") if kinds[k]]
    other = kinds["other"]
    left_out.append(f"{len(other)} other text files (docs, data, config, scenes)")
    out.append("not code: " + ", ".join(left_out))
    if in_git:
        out.append(f"commits: how many of the last {RECENT_COMMITS} commits touched the unit")

    out.append("")
    out.append("units:")
    for unit in units[:MAX_UNITS]:
        lines = sum(code[f] for f in unit.files)
        biggest = max(unit.files, key=lambda f: code[f])
        prefix = unit.label.split("*")[0].split("{")[0]
        inside = [t for t in tests if prefix in ("./", "") or t.startswith(prefix)]
        commits = set()
        for f in unit.files:
            commits |= touched.get(f, set())
        row = f"- {unit.label}  {count(len(unit.files), 'file')}, {count(lines, 'line')}"
        if inside and not unit.label.endswith("(files directly in it)") and "{" not in unit.label:
            row += f", {count(len(inside), 'test file')} inside"
        if in_git:
            row += f", {count(len(commits), 'commit')}"
        if len(unit.files) > 1:
            row += f"; largest {biggest.rsplit('/', 1)[-1]} ({number(code[biggest])})"
        elif lines > budget:
            row += " (one file over the budget)"
        out.append(row)
    if len(units) > MAX_UNITS:
        out.append(
            f"- and {len(units) - MAX_UNITS} more units not shown: run again with a path to list them"
        )

    if tests:
        by_dir: dict[str, list[int]] = defaultdict(lambda: [0, 0])
        for rel, lines in tests.items():
            d = rel.rsplit("/", 1)[0] + "/" if "/" in rel else "./"
            by_dir[d][0] += 1
            by_dir[d][1] += lines
        out.append("")
        out.append("tests by directory:")
        rows = sorted(by_dir.items())
        for d, (n, lines) in rows[:60]:
            out.append(f"- {d}  {count(n, 'file')}, {count(lines, 'line')}")
        if len(rows) > 60:
            out.append(f"- and {len(rows) - 60} more directories")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("paths", nargs="*", help="files or directories to list; the whole repo if none")
    parser.add_argument(
        "--budget", type=int, default=DEFAULT_BUDGET,
        help=f"most lines of code in one unit (default {DEFAULT_BUDGET})",
    )
    args = parser.parse_args(argv)
    if args.budget < 1:
        parser.error("--budget must be at least 1")
    text = report(Path.cwd(), args.paths, args.budget)
    sys.stdout.buffer.write((text + "\n").encode("utf-8", "replace"))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
