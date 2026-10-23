# astro-plugins

A Claude Code plugin marketplace with two plugins for solo hobby projects: solo-review and web-reader.

## Layout
- `.claude-plugin/marketplace.json`: the marketplace. It lists each plugin under `plugins/<name>`.
- `plugins/solo-review/`: the review and git workflow. Skills in `skills/`, agents in `agents/`, hooks in
  `hooks/hooks.json` (they run `scripts/ledger.py`), a hooks module (`hooks/register.tsx` with `actions.ts`,
  `status.ts` and `tools.ts`, and its types in `types/index.d.ts`, which `plugin.json` names) with its tests in
  `tests/`, and the files setup installs in `templates/`.
- `plugins/web-reader/`: one skill, `skills/read/`, and `scripts/webread.py`. Its `--render` and `--figures` also
  need Chromium or Chrome on `PATH`.

## Commands
- `claude plugin validate --strict .`: the marketplace and both manifests.
- `claude plugin validate --strict plugins/solo-review` and `claude plugin validate --strict plugins/web-reader`:
  each plugin's skills, agents and hooks, which the marketplace check doesn't read.
- `claude plugin test plugins/solo-review`: the hooks module's tests.
- `python3 -B plugins/web-reader/scripts/webread.py --help > /dev/null`: webread.py loads.

## Verify
Before saying a change is done, run every command above and show what it printed. The tests don't cover skill,
agent or hook behavior: for a change there, also run it live with `claude -p` in a scratch repo, and show what
Claude did.

## Conventions
- Raise the `version` in a plugin's `plugin.json` in every pull request that changes that plugin's files.
  `claude plugin update` installs a release only when the version changes.
- A plugin's `description` in `marketplace.json` matches the one in its `plugin.json`.
- solo-review acts only in a repo set up with `/solo-review:setup`, which has a `.review/` folder. Its hooks and its
  commit, review and ship skills check for it first. Nothing new may act in a repo without it.
- solo-review's skills ask the user in plain sentences, never with the question tool (`disallowed-tools:
  AskUserQuestion`).
- Skills name bundled scripts as `${CLAUDE_PLUGIN_ROOT}/scripts/...` and run each command as its own Bash call, so
  their `allowed-tools` patterns match.
- `scripts/ledger.py` and `scripts/webread.py` use only Python's standard library: CI and the hooks run them with a
  bare `python3`.
- hooks.json runs each hook as `"command": "python3"` with `args`, never a shell string. A hook never blocks
  unrelated work: it catches its own errors, and only a deliberate block exits 2.

## Git
- Work on a branch named `<type>/<short-name>` (feat, fix, refactor, docs or chore). Changes reach `main` through a
  reviewed pull request (`/solo-review:review`, then `/solo-review:ship`), and CI runs the commands above on each
  one.

## Gotchas
- With the marketplace added from a local clone, Claude Code loads the plugins straight from the working tree, so
  the branch checked out here is what runs in every session. `/reload-plugins` picks up a change.
- solo-review is set up in this repo (`.review/`, REVIEW.md): the branch guard blocks edits on `main`, and
  `git push` is blocked while any finding is open.
- CI pins Claude Code's version in `.github/workflows/checks.yml`. A newer validator can add warnings, which
  `--strict` fails on, so raise it on purpose and fix what it reports.

## More
- `plugins/solo-review/README.md` and `plugins/web-reader/README.md`.
