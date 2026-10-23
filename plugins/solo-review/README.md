# solo-review

Code review for one developer working with agents, adapted from the Claude Code team's
[How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/).

The article's answer to "who reviews the code?" is layers:
- agents hunt bugs and other agents verify each one
- every finding gets answered
- risky paths get a person
- the reviewer learns from what it missed

solo-review gives you those layers without a team, and nothing runs until you ask for it. It has no hooks, doesn't
block edits on main, doesn't force worktrees, and doesn't commit on its own.

## Install

```
/plugin install solo-review@astro-plugins
```

Requires `git` and `python3` (standard library only). Shipping needs the GitHub CLI, `gh`.

## Skills

| Skill | What it does |
|---|---|
| `/solo-review:setup` | Drafts REVIEW.md, `.claude/solo-review.json`, a Verify section for CLAUDE.md and a PR template from your project. Shows them, writes what you approve. Run once per project. |
| `/solo-review:review` | Reviews the current change, fixes the Important findings, and re-reviews the fixes, for up to 3 rounds. |
| `/solo-review:ship` | Opens a PR: commits, moves work off main, rebases, re-checks, fills the template, watches CI. Merges when you say so. |
| `/solo-review:commit` | Commits finished work as logical units, each revertable on its own. |
| `/solo-review:explain <topic>` | Explains one slice of the code as it is today, cited to file:line. |
| `/solo-review:learn` | Logs bugs that slipped past review, replays them as evals, and tunes REVIEW.md from the record. |

## How a review runs

1. **Check first.** The project's check command runs before any agent. A red build stops the review: reviewing code
   that doesn't pass is wasted.
2. **Find.** Fresh-context finders read the diff and REVIEW.md, each through one lens:
   - `change`: the changed lines
   - `system`: callers, contracts, docs and root causes
   - `security`: only when a sink or a High-risk path is touched
3. **Verify.** A verifier sees only each claim, not the finder's reasoning, and must trace the bug in the code itself.
   At deep, three verifiers vote, and a finding survives on two votes.
4. **Record.** Every finding is logged as Important, Nit or Pre-existing.
5. **Fix.** A fresh fixer fixes the Important findings; your session never fixes its own bugs. The next round reviews
   only what the fix changed.
6. **Stop.** The loop ends on a round with no Important findings, or after 3 rounds with a "step back and rethink"
   note.

Nits never start a round. They're listed with a one-line fix each: say "fix the nits", or answer them. Pre-existing
bugs go to `review backlog` instead of growing the change.

Depth is picked from the change:
- **quick**: docs or ≤ 20 lines
- **standard**: the default
- **deep**: your own `high` paths, or when asked

## What it writes

| Where | What | Committed? |
|---|---|---|
| `REVIEW.md` | The review guide: what Important means here, what to always check, what not to report. Plain Markdown, also read by GitHub's Code Review. | yes, by you |
| `.claude/solo-review.json` | Settings (below). | yes, by you |
| `CLAUDE.md` | A short Verify section: the commands to run, and "show the output". | yes, by you |
| `.github/pull_request_template.md` | What and why, Testing, Risk, How to revert, Review, and a sign-off box only you tick. | yes, by you |
| `.git/solo-review/ledger.jsonl` | Every round, finding and outcome. Never committed; shared by all worktrees of the clone. | no |
| `.solo-review/` | Handoff files the skills write and the script reads and deletes. Excluded from git automatically. | no |

## Settings: `.claude/solo-review.json`

```json
{
  "check": "npm test && npm run build",
  "high": ["src/auth/**", "scripts/release.sh"],
  "skip": ["dist/**", "**/*.snap"]
}
```

| Key | Default | Meaning |
|---|---|---|
| `check` | inferred from the manifest | The one command that builds and tests the project. |
| `high` | `[]` | Your High-risk paths: reviewed deep, and you read them before merging. |
| `skip` | `[]` | Never reviewed. A High-risk file is reviewed anyway. |
| `depth` | `auto` | `auto`, `quick`, `standard` or `deep`. |
| `security` | `auto` | `auto` (when a sink is touched), `always` or `never`. |
| `max_rounds` | `3` | Review-and-fix rounds before stepping back. |
| `max_nits` | `3` | Nits reported per round. |
| `merge` | `rebase` | How ship merges: `rebase`, `squash` or `merge`. |

Globs work like git's: `*` stays inside one folder, `**/` crosses folders, and case is ignored.

## Risk

The change sets the tier, not the author. The tier goes in the PR's Risk section, and tells you what to read yourself.

| Tier | When | You |
|---|---|---|
| High | Any file is High-risk: your `high` paths, or the built-in list (Claude config and CLAUDE.md, CI and git hooks, manifests and lockfiles, Docker, secrets, symlinks) | read those files before merging |
| Medium | Ordinary code | read the evidence in the PR |
| Low | Docs only | skim |

Nothing merges without you saying so. The sign-off box and `gh pr merge --match-head-commit` make sure the approval
covers the exact commit you saw.

## The learning loop

| Article | Here |
|---|---|
| "Any incidents are now an eval" | `learn escape <fix-commit>` logs a bug that shipped; `learn eval` replays the cases |
| A reviewer change is kept only if the score goes up | `learn` keeps a REVIEW.md edit only if the eval doesn't get worse |
| Noise is measured by what people do with the comments | `stats` reports useful% and noise% from your answers |
| False alarms are counted on known-clean PRs | `learn eval --clean M` samples old commits, and you label each finding |
| Repeated findings are fixed at the source | `learn` proposes a test, lint rule or CLAUDE.md line before a review rule |

## Cost

Your session stays small: the agents read the diff, and your session only sees their JSON.

| Depth | Agents per round |
|---|---|
| quick | 1 finder, plus 1 verifier only if it found something Important |
| standard | 2 finders (3 when security is on) and 1 verifier |
| deep | 3 finders on Opus and 3 verifiers |

A fix round re-reviews only the fix, so it is usually quick.

## Tests

```
python3 -m unittest discover -s plugins/solo-review/tests
```
