# CLAUDE.md

## Checking a change

- Python tests (bug-hunt, memory, plain-english, project-md): `python3 -m unittest discover -s plugins/<name>/tests`. To run one file, use `python3 plugins/<name>/tests/<file>.py`: the tests folders aren't packages, so a dotted module path fails.
- TypeScript tests (global-memory, plain-english, project-md): `claude plugin test plugins/<name>`. Validate every plugin with `claude plugin validate plugins/<name>`.
- Don't run `unittest discover` over all of `plugins/`: it also finds the eval fixtures' tests, and some fail on purpose.
- Check what a skill does by running it, with the try-plugin skill or the plugin's evals. Unit tests cover only the scripts a skill ships.
- Run `claude plugin eval` only when asked: plain-english's suite costs about $10 to $20 a run. The README of each plugin with evals gives the command.

## Code

- Python scripts run on Python 3.11 with only the standard library: skills run them with the user's `python3`, and nothing installs packages.
- The eval fixtures in `plugins/*/evals/fixtures/` have planted bugs and failing tests. Don't fix them.
- In plain-english, edit graders in `evals/style-graders/`. Each case's `graders/` folder holds symlinks to them, and Edit and Write refuse to write through a symlink.

## Releasing

- Installs get a change only after the plugin's version goes up. Finish the work with a commit that changes only `"version"` in `plugins/<name>/.claude-plugin/plugin.json`, with the subject `chore(<name>): release X.Y.Z so installs get <what changed>`. Raise the patch number for a fix or a wording change, and the minor number for new behavior.
- `.claude-plugin/marketplace.json` has no versions. Change it only to add or remove a plugin.

## Docs

- Read the Decisions in the "astro-plugins" Outline collection before you change how a plugin works.
- Record what an experiment or eval found as a note under Notes.
