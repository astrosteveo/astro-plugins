# solo-review

A review and git workflow harness for one developer, adapted from
[How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/).

That article answers "who reviews the code?" with layers. Agents find bugs, other agents vote on each finding,
every finding is answered before merge, and a merge queue re-checks the change against the latest main. The
answers feed back into the reviewer. A solo developer has no team, so this plugin assigns the roles like this:

| Team role in the article | Solo stand-in here |
|---|---|
| Review runs before a PR exists; Claude shows the output of something checkable | With `workflow: auto`, when a task is done Claude runs REVIEW.md's `check` command, shows the output, and runs the review without being asked |
| A subagent reviews the diff with fresh context | `finder` agents in a fresh context, each with one lens (`change`, `system`, `security`), reading CLAUDE.md and REVIEW.md, and reporting what they found for each line of REVIEW.md's "What failure looks like here" and "Always check" |
| Verifiers vote on each finding | `verifier` agent(s) trying to refute each candidate from the code alone (they see the claim, not the finder's reasoning, and quote the lines it depends on): 1 vote at standard depth, 2-of-3 at deep |
| An agent picks up the fix and runs another round | A fresh-context `fixer` agent fixes every verified Important finding and nit, and the next round re-reviews what changed. No human approves rounds |
| "A person can wave off a nit in seconds. An agent fixes it, which means another commit and another round" | Nits are capped (`max_nits`) and must name a real defect; style and cleanup are dropped. The round cap bounds the extra rounds |
| Pre-existing bugs don't look like the author's fault | Bugs on lines the whole change didn't touch are deferred to a backlog, not fixed in the loop |
| Every finding answered (fix, or resolve with a reason) | `fixed` / `wrong` / `intentional` / `wontfix` / `deferred` / `merged-past`, recorded in the ledger with who decided |
| Open findings block merge; security review also blocks | `ship` refuses while any finding is open, nits included, and a hook blocks Claude's `git push` while any finding is open too |
| Round cap, diff-only re-review, no repeats | One cycle is one review-and-fix loop. After 3 rounds without a clean pass it stops and tells you to rethink the approach |
| Human approval scaled by risk: Low needs no person, Medium one, High two; the change sets the tier, and some paths always need a person | [Risk tiers](#risk-tiers) from the changed paths. High (a built-in list, plus `high` globs) gets a deep review and you read those files before a merge. Low (every file matches a `low` glob) lands on a clean review and passing checks without you, when you wrote every commit. Medium, everything else, merges when you say so |
| An approval covers one specific commit | `ship` re-checks right before landing, reviews any commit added after the review, and asks you again if one landed after you said to merge |
| Merge queue re-runs checks on latest main | `ship` rebases onto the default branch, reruns the check, opens a PR with the review results, and waits for CI |
| Humans read the evidence and own the outcome | Claude opens the PR from a GitHub template with every finding, its outcome, and (in a collapsed section) the finder's evidence, the path the verifier traced, and the fix; you read it and say when to merge, unless the change is Low risk |
| Noise measured by author response; false alarms counted on clean PRs | `stats` reports useful% and noise% from your answers only; `review-learn eval --clean` counts false alarms on sampled commits that were never reverted or tied to an escape, each one labeled by you |
| Incidents become evals; keep a reviewer change only if the score goes up | `review-learn escape` logs a shipped bug, and REVIEW.md edits are kept only if the eval doesn't get worse |
| Fix repeated findings at the source; check the reviewer follows REVIEW.md | `review-learn` proposes a test, lint rule, or CLAUDE.md line before a review rule, and `stats` reports how often the verifier rejects findings that REVIEW.md says not to flag |

## Install

```
/plugin marketplace add astrosteveo/astro-plugins
/plugin install solo-review --marketplace astrosteveo/astro-plugins
```

Requires `git` and `python3`. No other dependencies. Landing through pull requests also needs the GitHub CLI, `gh`.

Then turn it off everywhere, and on only in the projects you set up, so it never acts in a repo you didn't opt in:

```
claude plugin disable solo-review@astro-plugins --scope user
```

In each project you want it in:

```
claude plugin enable solo-review@astro-plugins --scope local
/reload-plugins
/solo-review:setup
```

Elsewhere it isn't loaded at all: no skills, hooks or agents. `--scope local` keeps the switch out of the repo, in
`.claude/settings.local.json`. Use `--scope project` instead to commit it in `.claude/settings.json`, so every clone
has it on.

## The workflow

```
/solo-review:setup           # once per project, after turning the plugin on there: REVIEW.md, CLAUDE.md, .review/, the PR template
  (just work)                # Claude branches, commits as it works, then by itself: check, review loop, PR
  "merge it"                 # you read the PR and say when to merge; ship lands it (a Low-risk PR lands by itself)
/solo-review:review-learn    # every couple of weeks: tune REVIEW.md from the ledger
```

Setup prints the workflow rules, so they apply in the session that ran it, and the SessionStart hook gives them to
every session after. In a new project, setup works from an empty folder:
- If the folder isn't a git repository yet, Claude runs `git init` first.
- With no commits yet, the setup doesn't go on a branch, since that branch would take the first commit and the
  default branch would never exist. Claude shows you REVIEW.md and CLAUDE.md, and when you say they're ready,
  commits them as the first commit on the default branch, with the PR template and `.review/`'s empty ledger, so
  every clone and worktree has opted in. A first commit has nothing before it to be reviewed against, so your read
  is its only review. Everything after it goes on a branch.

With `workflow: auto`, everything between your request and the open PR runs without you (the default, `manual`, stops
after step 1 until you ask for the review and the PR):

1. Claude works on a branch and commits each piece as it finishes it.
2. When the task is done (with `workflow: auto`), it runs `ledger.py check`, which prints the `check` command from REVIEW.md, runs that command itself, and shows the output. `ledger.py check` never runs the command: it comes from the repo, so Claude runs it through the normal permission prompt, unless you have allowed it. The `check_record` tool stores the result for the review ledger, with a one-line summary Claude gives it as typed input (never on a command line, since it comes from the repo-controlled output); without the plugin's hooks module, `ledger.py check --record --status <code> --file .review/.check.txt` does the same from a file.
3. It runs `/solo-review:review`, which loops by itself. Finders look for bugs, a verifier tries to refute each
   finding, a `fixer` agent fixes the verified Important findings and nits, the fix is committed, and the next round
   re-reviews only what changed since the last reviewed snapshot. It stops at the first round with no Important
   findings or nits. At standard and deep depth, a finder that comes back empty without showing what it checked runs
   once more, and if the second pass does the same, the round is marked thin and the PR says so.
4. It runs `/solo-review:ship`, which rebases onto the latest default branch, reruns the check, opens the PR from
   the template (what and why, testing, the risk tier and what the checks don't cover, how to revert, every finding
   and its outcome, and a sign-off box only you tick), and waits for CI. A Low-risk change it then lands by itself.

You are asked about only these things:
- a finding (Important or nit) the fixer could not fix without a design decision
- a review that didn't come back clean after three rounds, which means the approach needs rethinking rather than
  another patch
- a High-risk change, whose High-risk files you read before it merges
- the merge itself, which you call, unless the change is Low risk

You can run any step by hand:
- `review deep` forces a depth.
- When the round cap stops a review, it ends with a short summary: rounds run, findings fixed and still open, commits
  made after the last review, and the commands that get past ship's block.
- `review --force` runs one round past the round cap; `review --until-clean` lifts the cap for the rest of the
  cycle, so rounds go on until one comes back clean.
- `review --fresh` reviews the whole change from its base again, rather than only what changed since the last round,
  so you can re-check a round that came back clean when nothing has changed since.
- `review open` lists open findings.
- `review backlog` lists deferred pre-existing findings.
- `review resolve <ids> <outcome> <reason>` answers a finding.
- `/solo-review:commit` splits a diff that mixes several purposes.
- `review-learn escape <fix-commit>` logs a bug that got past review.
- `review-learn eval [N] [--clean M]` replays escapes and sampled commits, at about 3 agent runs per case. It asks
  you whether each finding on a sampled commit is real before counting it as a false alarm.
- `review-learn spotcheck` asks you to confirm decisions the agents made.
- `review-learn` makes the REVIEW.md or CLAUDE.md edits you approve on a branch (`chore/review-tuning` when it starts
  on the default branch), which you review and ship like any change.

### Branches and commits

- **Branch from the first edit.** In an opted-in project (one with a `.review/` directory), editing a file on the
  default branch, or on a detached HEAD outside a rebase or merge, is blocked until Claude starts a branch.
- **Plain branches.** The block message and the session rules say `git switch -c <type>/<name>`, in the checkout
  you're in, and uncommitted changes come with you. Nothing makes you use worktrees. If you make one yourself, ship
  still lands from it, and the session note lists the other worktrees. The note also says when the default branch
  is behind `origin/<default>`. `init` adds `/.claude/worktrees/` to `.git/info/exclude`, and reviews never count
  those folders as changes.
- **Commit as you work.** At session start Claude is told to commit each piece of a task as soon as it is done,
  without asking. A task that changes the API, the UI, and shared code ends up as three commits, so any one of them
  can be reverted on its own.
- **Land through a pull request.** On GitHub, `ship` pushes the branch and opens a PR by itself.
  - The description is the repo's GitHub pull request template, filled in. `init` installs the plugin's template
    at `.github/pull_request_template.md` unless the repo already has one, and `ship` fills whichever template the
    repo uses.
  - It waits for CI and stops there, unless the change is Low risk. The wait (`gh pr checks --watch`) runs in the
    background, so a long CI run doesn't hold a call open until it times out.
  - When you say to merge, or by itself for a Low-risk change, it fast-forwards the default branch, which marks the PR merged and keeps the exact
    commits. Without a GitHub remote, it merges locally.
  - From a git worktree, or while another worktree has the default branch checked out, it never checks the default
    branch out: it pushes the branch's commits to it, fast-forwards the local default branch where it lives (asking
    you to when that checkout has uncommitted changes), detaches the worktree so the branch can be deleted, and
    removes a worktree the session entered under `.claude/worktrees/`. A
    squash or merge landing without GitHub needs a checkout of the default branch, so ship asks you to run it there.
    `ship-check` reports `linked_worktree` and `default_worktree` for this.
  - It leaves the tree clean. Ledger entries recorded after the branch's last ledger commit are committed and pushed
    to the default branch as a ledger-only `Update review ledger` commit (through a small PR if the branch is
    protected), so nothing is left uncommitted after a merge.
  - Ledger entries recorded on the default branch itself, from a `review --range` there, a `resolve`, or
    `review-learn`, are committed the same way: run `ship` on the default branch, and when the ledger is the only
    change, it commits and pushes just the ledger. Unpushed commits outside `.review/` still stop it. The
    session-start message says when the ledger has uncommitted entries.

### Who decides what

- **Agents** find, verify, and fix. The session that wrote the code never fixes review findings itself, because
  its context holds the assumptions that produced the bugs. A fresh `fixer` agent does it.
- **Nobody dismisses a finding on an agent's judgment.** A finding closes when it is fixed, when a later round finds
  it gone, or when you answer it. The one standing rule: a pre-existing finding (on lines the whole change didn't
  touch) is recorded as `deferred` with the reason "pre-existing; outside this change", and stays in the backlog.
- **You** decide what to build, read the PR (and any High-risk files it touches), answer anything the loop leaves
  open, and say when to merge a Medium- or High-risk change.
- **`review-learn spotcheck`** samples the agents' decisions. Agent-decided outcomes count as unlabeled in `stats`
  until you confirm them.

## Token cost

Claude's own context stays small, because the agents read the diff and Claude only sees their JSON.

| Depth | Picked when | Agents |
|---|---|---|
| quick | Docs only, or 20 changed lines or fewer (typical for a fix round) | 1 finder (Sonnet), Important only; 1 Haiku verifier only when the finder reports something or open findings need re-checking |
| standard | Default | 2 finders, plus a security finder if the added code lines (not docs) touch a real sink (command execution, SQL, deserialization, HTML injection, auth, crypto, secrets), plus 1 verifier (Haiku) |
| deep | Any High-risk path (always-High or a `high` glob) is touched, whatever `depth` says | 3 finders (`change`, `system`, `security`; `security: never` drops the security finder only when no High-risk path is touched), plus 3 verifiers (Sonnet), 2-of-3 vote |

Other cost controls:
- Nits are capped at `max_nits` per round, so fixing them adds little, and quick fix rounds report Important findings
  only.
- Rounds after the first review only what changed since the last reviewed snapshot, and the round cap is 3 per
  cycle (`max_rounds`), unless you pass `--until-clean`.
- `review-learn` can't be invoked by the model, so its description doesn't use context in every session. `review`,
  `commit`, and `ship` are model-invocable, because Claude runs them on its own when a task is done.
- The hooks are plain Python, and the module only runs `ledger.py`: neither makes model calls.

## Risk tiers

The article scales human approval by risk: a Low-risk change needs no approval "once automated review and security
checks are green", a Medium one needs one person, and a High one two. "The change sets the tier, not the author."
Here the tier comes from the paths a branch changes, matched against settings from the default branch's REVIEW.md,
so a branch can't lower its own tier.

| Tier | When | What happens |
|---|---|---|
| High | Any file is always High (below), matches a `high` glob, or is an added or changed symlink | Every round reviews deep with a security pass, whatever `depth` and `security` say. You read the High-risk files themselves, not only the PR, and say when to merge: one developer has no second person, so that stands in for the second approval |
| Medium | Everything else | Reviewed at the usual depth; you say when to merge |
| Low | Every file matches a `low` glob, and none is High | Reviewed at the usual depth; `ship` lands it by itself once the review is clean, the check passes on the latest default branch, and CI is green |

`low` is empty by default, so nothing is Low until you list paths in REVIEW.md, such as `docs/**`.

A Low change still waits for you when someone else wrote any of its commits, such as a contributor's PR you checked
out. The article keeps the lighter paths for trusted authors, and here that means commits whose author email is your
git `user.email` or is in REVIEW.md's `trusted` list (for your other addresses). Author email is not proof of who wrote a commit, since anyone can set it, so this is a
convenience guard for the PR-checkout case and not a trust boundary. It also waits when `ship-check`
reports a problem, when a review round came back thin, or when its added lines touch a security sink (the hint that
turns on the security finder). That stands in for the article's second classifier, which asks for a person even
when the tier says none is needed. `ship` checks the tier again right
before landing, so a commit added after the review that touches a Medium or High path makes it wait. The status
line, the findings pane and the PR description show the tier.

### Always-High files

Some files are a security risk on their own, whatever the change, so they are always High risk. No setting can
remove them, no `low` glob lowers them, and `skip` never hides them. Matching ignores case. A pattern ending in `/**`
also matches the bare directory path, because git stores a symlinked directory as one path. Any added or changed
symlink in a change is High too, whatever its name.

- **What steers Claude and the review:** `REVIEW.md`, every `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md`,
  `.claude/`, `.mcp.json`, `CODEOWNERS`, plugin manifests (`.claude-plugin/`), and anything under a `skills/`,
  `agents/`, `commands/` or `hooks/` directory.
- **What runs automatically:** CI (GitHub Actions at the repo root, GitLab CI, CircleCI, Jenkins, Azure Pipelines,
  Buildkite, Travis) and `dependabot.yml`, git hooks (`.husky/`, `.githooks/`, pre-commit, lefthook), `Dockerfile*`,
  `*.dockerfile`, Docker Compose files, `.devcontainer/`, `.vscode/tasks.json`, `.envrc`, and `Makefile`.
- **What gets installed, and from where:** dependency manifests and lockfiles (`package.json`, `requirements*.txt`,
  `pyproject.toml`, `setup.py`, `Cargo.toml`, `go.mod`, `Gemfile`, `composer.json`, `*.lock`), `.gitmodules`, and
  registry and build configs (`.npmrc`, `.pypirc`, `.yarnrc`, `.cargo/`, `.netrc`).
- **Secrets, which should never be committed:** `.env` files, `*.pem`, `*.key`, SSH keys, and `credentials*`.

`python3 scripts/ledger.py config` prints the full list (`always_high`) next to the project's own `high` and `low`
globs.

## Where settings come from

`depth`, `security`, `max_nits`, `max_rounds`, `quick_max_lines`, `gate`, `branch`, `check`, `high`, `low`, `trusted` and `skip` are read from REVIEW.md on the
default branch (`origin/<default>` when it exists), so a branch can't weaken the review of its own change. When the
default branch has no REVIEW.md, or git can't read it, the branch's REVIEW.md can only strengthen review: `low`, `trusted`, `skip`,
`security: never`, `gate: off`, `branch: off` and a depth below auto are ignored, `max_rounds` and `quick_max_lines`
can only go down, `check` is inferred from the manifest instead of taken from the branch, and `high` is used.
`check` is inferred the same way when the default branch's REVIEW.md sets none, as in a new project whose first
branch with code is also the one that sets it: that branch's own `check` applies once it merges, and `ledger.py check`
says so. `python3 scripts/ledger.py config` shows which case applies in `source`.

## Per-project files

- `REVIEW.md`: your review guide, under GitHub Code Review's headings: what Important means here, what to always
  check, what not to report, and what is intentional. Guides with the older headings still work. The frontmatter
  holds the settings:
  - `check`: the one command that builds and tests the project; `init` infers it from the manifest
  - `depth`, `security`, `max_nits`, `max_rounds`
  - `gate`, `branch`, `merge`
  - `workflow`: `manual` (default) leaves `/solo-review:review` and `/solo-review:ship` to you, for prototyping; `auto`
    tells Claude to run both, and the check, when a task is done. Unlike the gate settings it is read from the branch's REVIEW.md, so
    flipping it takes effect in the next session without a merge. Branch and push gates still apply.
  - `high`, `low` and `skip` globs. `high` adds to the built-in always-High list; nothing removes an entry from it,
    no `low` glob lowers one, and `skip` never hides one. `low` is empty until you list paths. `sensitive`, the old
    name for `high`, still works
  - `trusted`: author emails, besides your git `user.email`, whose commits can take the Low path (matched ignoring
    case)
- `CLAUDE.md`: the reviewer holds code to its conventions and flags lines a change makes untrue. `init` installs a
  template (goals, non-goals, stack, conventions, check, pointers) if the project has none, and the review skill
  fills it in from the README, the manifest and the code. If one exists, a fresh agent checks each line against the
  code and you approve any edits.
  The scope also hands the reviewers every CLAUDE.md in the changed files' directories and their parents.
- `.github/pull_request_template.md`: installed by `init` if the repo has no PR template.
- `.review/ledger.jsonl`: append-only events. It stays uncommitted while you work, so it follows you across branch
  switches and an abandoned branch doesn't lose its labels. `ship` commits it. It has `merge=union` set, so two
  branches that both added events merge cleanly. A new finding or escape id counts up from the highest one in any
  ledger the checkout can see (other worktrees', and the one on every local and remote-tracking branch), so two
  branches reviewed side by side don't hand out the same id. Unpushed reviews in two clones still can; when they
  do, `ship-check` lists the ids in `duplicate_ids` and the PR's review summary names them.
  - `run`: scope, cycle, round, depth, candidate, reported, and Important counts, the check result, the
    compliance counts, the lenses that came back thin, whether it was a `--fresh` re-review, and the REVIEW.md
    version
  - `finding`: file, line, severity, category, title, evidence, fix, votes, and the verifier's reason (`verified`)
  - `outcome`: the outcome, the reason, the fix commit, and who decided (`user`, `agent`, or `auto` when a
    re-review found the defect gone)
  - `escape`: a bug that shipped, the commit that introduced it, and the finding that flagged it, if any
  - `learn`: a REVIEW.md tuning, with the version before and after and the eval score, or an eval alone
    (`eval_only`), which doesn't count as a tuning in `stats`

## How it learns

1. **Labels come from people.** `useful` and `noise` count only outcomes you decided, or that a later round cleared
   (`auto`). An agent fixing its own findings is not a label. Your answers in spot-checks are. Older ledgers may hold
   `merged-past` nits, merged without fixing before nits were fixed in the loop: answered, but neither useful nor
   noise.
2. **Proposed edits cite evidence.** `review-learn` reads the stats and reasons, then proposes REVIEW.md edits, each
   citing the findings behind it. It prefers preventing a bug class at the source (a test, type, lint rule, or
   CLAUDE.md line) over adding a review rule.
3. **Edits must not make the eval worse.** When escapes exist, an edit is scored before it is kept: the eval must
   catch no fewer escapes and raise no more false alarms on sampled commits. Every run is tagged with the REVIEW.md
   version, so later stats show whether the edit helped.
4. **Escapes are the recall check.** If a finding flagged a bug and you dismissed it, `review-learn` says so plainly.
5. **Compliance is measured.** `stats` reports how many candidates the verifier rejected because REVIEW.md says not
   to flag them, how often the finders found more nits than the cap, and how often each lens came back thin in the
   standard and deep rounds that ran it.
6. **Lessons that would apply anywhere go back into the plugin.** They are listed as candidate changes to
   `agents/finder.md` and `agents/verifier.md`. That is how the base criteria improve across projects.

## Hooks

The hooks do nothing in repos without a `.review/` directory. Each hook entry point catches every exception and exits 0;
only the deliberate blocks exit 2.

| Hook | Setting | Effect |
|---|---|---|
| SessionStart | (always) | Tells Claude to work on a branch (in a repo with no commits, to commit the setup first), commit as it works, and (with `workflow: auto`) run `ledger.py check`, review, and ship when a task is done; plus the current branch and open findings |
| PreToolUse on Edit/Write | `branch: require` | Blocks file edits on the default branch once it has a commit (files under `.review/` are exempt) |
| PreToolUse on Bash | `gate: push` | Blocks a command that runs `git push` while any finding, Important or nit, is open on the branch of a repo the command starts in or names |

They only govern Claude. Your own terminal commands aren't checked, and another installed mod that answers a tool
call itself, rather than passing it on, skips them too.

The push gate applies ship's rule: a branch with an open finding doesn't leave the machine. It reads the command the
way the shell would, so it finds a `git push` after a newline or `;`, `&&`, `||` and `|`, inside a subshell,
`$(...)`, backticks, `if`/`for` blocks, `sh -c '...'` and `eval`, behind variable assignments and wrappers such as
`sudo`, `env` and `timeout`, and after git's global options. It checks the repo the command starts in and every
directory a `cd` or `git -C` in it names, rather than working out which one the push runs in, so `cd other && git
push` is blocked while the repo you started in has an open finding, and a subshell or a target it can't resolve
only adds repos to check. A `git push` that is only text, in a quoted argument such as a commit message, a comment
or a here-document, doesn't count. It doesn't see a push made through a git alias or a script.

### The hooks module: status line, findings pane and ledger tools

A hooks module (`hooks/register.tsx`, early-access Claude Code API) shows the review state and serves the ledger
tools. It blocks nothing, and it never runs the `check` command.

- **Status line.** At session start and after every turn (a review's subagents included) it reads `ledger.py status`
  and pins one line under the prompt: `review: 2 open (1 Important, 1 nit) · round 2/3`, `review: round 3 running
  (quick)`, `review: changes since round 2`, `review: clean (round 2)` (with `· thin` when a finder came back thin),
  or `review: not reviewed yet`. Once the branch has commits, the line ends with its risk tier, as in
  `review: clean (round 2) · Low risk`; a round in progress shows the round alone. A run started more than 6 hours ago is treated as abandoned, not running. It is blank outside an opted-in repo, and on the default branch when nothing is open
  there. It never says clean about code that changed after the clean round.
- **`/solo-review-findings`** opens a pane listing the branch and its risk tier, its open findings with their fixes,
  the last round (its depth, result, check and thin lenses), a round in progress, and the backlog count. It redraws as the status
  changes. Module commands aren't namespaced, so the name carries the plugin's. Where a pane can't be shown (a
  headless session), the command answers with the same list as text.
- **Notifications.** When a main-loop turn ends with no finder, verifier or fixer still running, and the review has
  settled since the session started, a desktop notification says how: `Review of <branch> came back clean (round
  N).`, `... stopped at the round cap with N findings open.`, or `... needs you: N findings open.` Each state is sent
  once. Nothing is sent while a round runs, outside an opted-in repo, or when your notifications are off (Claude
  Code's own notification channel setting).
- **Answering from the pane.** Each open finding has an **Answer** button. It opens a form: pick wrong, intentional,
  wontfix or deferred, give the required reason, and **Record** runs `ledger.py resolve --by user --via ui`. A refused
  answer stays in the form with the ledger's reason. `via: ui` marks the answer as yours, given in the pane rather
  than relayed through Claude, and `stats` counts the two apart. It is a mark, not a proof: Claude never sets it, but
  the flag exists on the command line. **Send to fixer** queues a prompt in your name that runs review step 5 for
  that finding once Claude is idle (a fresh fixer, a `Fix review finding` commit, `resolve --as fixed`). The prompt
  names the finding by id alone, and Claude reads its details from the ledger, so text an agent wrote from the repo
  never reaches a prompt sent as you. On mobile, which has no text fields, the pane offers Send to fixer only.
- **Ledger tools.** `mcp__solo-review__record`, `mcp__solo-review__check_record` and `mcp__solo-review__resolve` take
  the same input as `ledger.py record`, `check --record` and `resolve`, as typed JSON. The module runs `ledger.py` with
  no shell and the payload on stdin, so a check's output or a finder's evidence never reaches a command line, and the
  review loop writes no temp files. `resolve` refuses an id or commit that could read as an option. The review and
  review-learn skills use the tools, and fall back to the file-based commands when the module didn't load.
  The module answers tool calls only for these three, by name, so the branch guard and push gate run beneath every
  other call.

## Script

`scripts/ledger.py` handles all the bookkeeping, so the model never reads or rewrites the ledger itself.
- **Commands:** `init`, `check`, `scope`, `record`, `resolve`, `open`, `status`, `backlog`, `stats`, `reasons`,
  `spotcheck`, `escape`, `evals`, `clean-sample`, `learned`, `config`, `ship-check`, `pr-summary`.
- `status` prints the branch's review state as one JSON object (open findings, the last round, its check and whether
  anything outside `.review/` changed since its snapshot, a round in progress, the backlog count, the branch's risk
  `tier`, `workflow` and `max_rounds`), or `{"opted_in": false}` outside an opted-in repo. It only reads.
- `ship-check` reports, among the rest, the branch's risk `tier`, its `high_files`, and `waits_for_user`: null when
  `ship` may land the branch without you, otherwise why it waits.
- `resolve --via ui` (only with `--by user`) marks an answer given in the findings pane; the module sets it.
- `record` reads its JSON from `--file` or stdin, and names what is wrong with a malformed payload before writing
  anything. `check --record --status <code>` reads its one-line summary from `--file` or stdin.
- **Hook entry points:** `session-context`, `branch-guard`, `gate`.

`scope` snapshots the working tree into a dangling commit through a temporary index. It does not touch your index
or refs.

## Known limits

- Finding ids count up from the highest one in any ledger the checkout can see, so parallel worktrees of one clone
  don't collide. Unpushed reviews in two clones still can; `ship` merges both ledgers, but an id then refers to two
  findings, and `ship-check` lists it in `duplicate_ids`.
- On `main`, with no upstream and no branch, each commit starts a new review scope. The branch workflow avoids this.
- The article's nightly review agents over existing code are left out to save tokens. Deferred pre-existing findings
  stay visible in `review backlog` instead.
