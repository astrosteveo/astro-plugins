---
name: setup
description: Set solo-review up in this project. Drafts REVIEW.md, .claude/solo-review.json, a Verify section for CLAUDE.md and a PR template from what the project actually is, shows them, and writes what the user approves.
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py *), Bash(git log *), Bash(git ls-files *)
---

# solo-review: setup

This writes the few files that steer review in this project. Nothing else needs setting up: the review log lives in
`.git/solo-review/`, and the `.solo-review/` handoff folder is excluded from git automatically. Run it again any time
to revisit the files.

`L` means `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.py`. Run each command as its own Bash call.

## 1. Look
- Run `L setup-info`. It prints JSON:
  - what exists: REVIEW.md, the settings file, CLAUDE.md and whether it has a Verify section, a PR template
  - the GitHub remote, the default branch and the manifests
  - an inferred check command, candidate High-risk paths, and the plugin's template paths
- If it says this isn't a git repository, ask before running `git init`.
- Read the README, CLAUDE.md and the manifests it lists, and glance at the top-level layout. You need to know what
  this project does, and what a bad bug in it looks like.
- Run `git log --oneline -60` to see how commits read, and whether some kind of fix keeps recurring.

## 2. Draft
Draft each file from its template (the paths are under `templates` in the JSON). Use what you read, not guesses: keep
a line only if you can point to the file, command or code that supports it.

- **`.claude/solo-review.json`**
  - `check`: the one command that builds and tests the project. Prefer what CLAUDE.md or the README says to run,
    then `inferred_check`. Make sure it exists (the script is in package.json, the Makefile has the target).
  - `high`: from `candidate_high`, keep only the paths where one missed bug is expensive (auth, billing, data
    migrations, release or install scripts), and say why for each. CI, manifests, Claude config and secrets are
    already High-risk, built in.
  - `skip`: generated or vendored paths that exist here (`dist/**`, `**/*.min.js`, snapshots).
  - Globs work like git's: `*` stays inside one folder, so write `**/*.snap` for any depth.
  - Leave the other settings out unless the user asks: `depth`, `security`, `max_rounds`, `max_nits` and `merge`
    (rebase, squash or merge).
- **REVIEW.md** (if missing):
  - Fill "What Important means here" with 3 to 5 lines specific to this project, each a failure a user would hit
    ("a save can drop data without an error", "the CLI exits 0 on failure").
  - Fill "Always check" only from bug classes the git log shows recurring.
  - Delete the comment in each section you filled.
  - If REVIEW.md exists, read it and propose edits only, in the same spirit.
- **CLAUDE.md**: never create or rewrite it.
  - If there is none, recommend running `/init` first and then setup again, and skip this file.
  - If it has no Verify section, draft one from `verify-section.md` with the real commands, including how to see a UI
    change if the project has one.
  - If it has one, check that it names the same check command, and propose aligning them if not.
  - Offer, but don't run unless asked, a fresh `general-purpose` agent that checks each CLAUDE.md line against the
    code and reports lines that are false or stale, with evidence.
- **PR template**: only if `pr_template` is null. Use the plugin's template unchanged, as
  `.github/pull_request_template.md`. If the repo has its own, leave it alone: ship fills whatever template it finds.

## 3. Show, then write
- Show every draft in one message, each in a code block. For CLAUDE.md, show only the section to add.
- Ask the user to approve, edit or drop each one.
- Write only what they approve. The write to `.claude/solo-review.json` asks permission, since `.claude/` is a
  protected folder.

## 4. Tell the user
- What was written, and that nothing was committed. These files steer every review, so they count as High-risk: they
  get reviewed and shipped like any change.
- How to use it:
  - `/solo-review:review` reviews the current change when they ask.
  - `/solo-review:ship` opens a PR and merges it when they say so.
  - `/solo-review:explain <topic>` explains a part of the code.
  - `/solo-review:learn` tunes REVIEW.md from what the reviews found.
