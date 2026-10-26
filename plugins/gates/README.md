# gates

Gates that refuse risky Bash commands before they run, and tell Claude why and what to run instead. Every gate lives here, so enabling this one plugin turns them all on, in every project and for subagents too.

| Gate | Refuses | Says to |
| --- | --- | --- |
| pkill | any `pkill` | find the one process with `pgrep -f '[g]odot'` and `kill` its PID |
| kill by pattern | `kill` with `pgrep -f` or `ps \| grep`, unless a letter of the pattern is bracketed | bracket a letter, so the pattern can't match the Bash tool's own shell |
| stage everything | `git add -A`, `--all`, `-u`, `--update` or `.` | check `git status` and stage files by name |
| commit everything | `git commit -a` or `--all` | stage by name, then commit without `-a` |

A gate reads each line of a command on its own, as a shell does, and catches a command after `cd … &&` or `;`, and `git -C dir`. It reads text too, so a commit message that names a refused command, such as one describing these gates, trips it. Every refusal says the way round: put the text in a file and pass the file, `git commit -F FILE`.

A gate that fails refuses the command: a broken gate never waves one through. Claude Code skips a failed hook and runs the tool, so the module's `.catch` answers with a refusal in its place.

## Adding a gate

Add an entry to `GATES` in `hooks/register.ts`: a `refuses` test on the command and the `reason` Claude reads. Write the reason as what goes wrong and what to run instead, so Claude picks a safe form rather than guessing. Add its cases to `tests/gates.test.ts`, the commands it refuses and the near misses it lets run.

```
claude plugin validate plugins/gates
claude plugin test plugins/gates
```
