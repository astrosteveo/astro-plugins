import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// Nothing sits beneath the plugin: this hook stands for the engine running the command.
function engine(on: On) {
  on('tool.call', () => ({ result: {} }))
}

// Each command, and the start of the reason a gate refuses it with; null for one that runs.
const CASES: [string, string | null][] = [
  ['pkill -f no-such-process', 'pkill kills every process'],
  ['pkill godot', 'pkill kills every process'],
  ["cd /tmp; pkill -f '[g]odot'", 'pkill kills every process'],
  ['kill $(pgrep -f godot)', 'This kills its own shell'],
  ["ps aux | grep godot | awk '{print $2}' | xargs kill", 'This kills its own shell'],
  ["kill $(pgrep -f '[g]odot')", null],
  ['kill 12345', null],
  ['echo pkill-style', null],
  ['ls', null],
  ['git add -A', 'git add -A, --all'],
  ['cd /home/astrosteveo/Projects/DOOM && git add -A', 'git add -A, --all'],
  ['git add --all', 'git add -A, --all'],
  ['git add .', 'git add -A, --all'],
  ['git add -u', 'git add -A, --all'],
  ['git add --update', 'git add -A, --all'],
  ['git add -Av', 'git add -A, --all'],
  ['git -C /tmp/repo add -A', 'git add -A, --all'],
  ['git commit -am "message"', 'git commit -a or --all'],
  ['git commit -a -m message', 'git commit -a or --all'],
  ['git commit --all -m message', 'git commit -a or --all'],
  ['git add . && git commit -m x', 'git add -A, --all'],
  ['git add docs/game.md godot/zone/player.gd', null],
  ['git add .gitignore', null],
  ['git add ./docs/game.md', null],
  ['git add -p docs/game.md', null],
  ['git commit -m "Narrow the view"', null],
  ['git commit --amend --no-edit', null],
  ['git commit -m x && git log --all --oneline', null],
  ['git log --all', null],
  ['git diff -u', null],
  ['git status --short', null],
  // A shell reads each line as its own command.
  ['git status\ngit add -A', 'git add -A, --all'],
  ['git add docs/game.md\ngit log --all', null],
]

test('each gate refuses what it should, with its reason, and lets the rest run', async ($, on) => {
  engine(on)
  for (const [command, reason] of CASES) {
    const ran = await $.tool.call({ tool: 'Bash', command })
    if (reason === null) {
      expect({ command, deny: ran.deny }).toEqual({ command, deny: undefined })
    } else {
      expect({ command, reason: ran.deny?.startsWith(reason) }).toEqual({ command, reason: true })
    }
  }
})

test('a refusal says how to pass text that only names a refused command', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Bash', command: 'git commit -m "Refuse git add -A and pkill"' })
  expect(ran.deny?.endsWith('put that text in a file and pass the file (git commit -F FILE).')).toBe(true)
})

test('a gate that fails refuses the command', async ($, on) => {
  engine(on)
  // No command at all: the gate throws reading it, and its catch answers.
  const ran = await $.tool.call({ tool: 'Bash' } as never)
  expect(ran.deny).toBe('gates: a gate failed, so the command was refused.')
})

test('the gates leave other tools alone', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Read', file_path: '/tmp/pkill' } as never)
  expect(ran.deny).toBe(undefined)
})
