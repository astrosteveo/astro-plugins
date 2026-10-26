import type { Register } from 'claude-code'

// A gate refuses a Bash command it matches, with the reason Claude reads: what goes wrong and
// what to run instead. Each pattern is tested line by line, as a shell reads a script.
type Gate = { refuses: (command: string) => boolean; reason: string }

const anyLine = (command: string, pattern: RegExp) => command.split('\n').some(line => pattern.test(line))

// A word on its own: not part of a longer name such as pkill-style.
const word = (name: string) => new RegExp(`(^|[^A-Za-z0-9_-])${name}([^A-Za-z0-9_-]|$)`)

// git, perhaps with -C DIR or -c KEY=VALUE, then a subcommand; the rest of that one command, up
// to the next ; & or |; and where an argument ends.
const GIT = String.raw`(^|[^A-Za-z0-9_./-])git(\s+-[Cc]\s+\S+)*\s+`
const REST = String.raw`(\s+[^;&|]*)?`
const END = String.raw`(\s|[;&|]|$)`

const GATES: Gate[] = [
  {
    refuses: command => anyLine(command, word('pkill')),
    reason:
      "pkill kills every process that matches, the user's own too (their editor, other sessions), and pkill -f also matches this Bash tool's own shell. Kill the one process you started by its PID: find it with pgrep -f '[g]odot' (a bracketed letter keeps the shell out), then kill PID.",
  },
  {
    // The Bash tool runs each command as `<shell> -c '<command>'`, so a pattern found by
    // command line matches that shell too, and kill takes it down. A bracketed letter
    // ('[g]odot') matches the process but not the shell.
    refuses: command =>
      anyLine(command, word('kill')) &&
      !anyLine(command, /\[[^\]]+\]/) &&
      (anyLine(command, /(^|[^A-Za-z0-9_-])pgrep[^|;&]*\s(-[A-Za-z0-9]*f|--full)/) ||
        anyLine(command, /(^|[^A-Za-z0-9_-])ps(\s[^|]*)?\|.*grep/)),
    reason:
      "This kills its own shell: the Bash tool runs the command as `<shell> -c <command>`, so the pgrep -f or grep pattern matches that shell too. Bracket one letter of the pattern so it still matches the process but not the shell, e.g. pgrep -f '[g]odot' or grep '[g]odot'.",
  },
  {
    refuses: command =>
      anyLine(command, new RegExp(`${GIT}add${REST}\\s(-[A-Za-z]*[Au][A-Za-z]*|--all|--update|\\.)${END}`)),
    reason:
      "git add -A, --all, -u, --update or . stages every change in the tree, including files this task didn't make (captures, scratch output, another session's edits). Check git status, then stage the files this change made by name: git add path/to/file other/file.",
  },
  {
    refuses: command => anyLine(command, new RegExp(`${GIT}commit${REST}\\s(-[A-Za-z]*a[A-Za-z]*|--all)${END}`)),
    reason:
      "git commit -a or --all commits every tracked change, including ones this task didn't make. Stage the files this change made by name with git add, then git commit without -a.",
  },
]

// A gate reads text too: a commit message that names a command it refuses trips it.
const MENTION =
  ' If the command only mentions this in text, such as a commit message, put that text in a file and pass the file (git commit -F FILE).'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const gate = GATES.find(gate => gate.refuses(e.command))
    return gate ? { deny: gate.reason + MENTION } : next(e)
  }).catch(($, e, next) =>
    // A gate that fails refuses: a broken gate must not wave a command through.
    next.called ? next(e) : { deny: `${$.plugin.name}: a gate failed, so the command was refused.` },
  )
}
