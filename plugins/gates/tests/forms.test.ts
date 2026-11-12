import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// Nothing sits beneath the plugin: this hook stands for the engine running the command.
function engine(on: On) {
  on('tool.call', () => ({ result: {} }))
}

// Other ways of writing what a gate refuses (#70), with the start of the reason it's refused
// with, and the near misses beside them that must still run (null). Each runs as its own test,
// so a miss names itself.
const FORMS: [string, string | null][] = [
  // Only a bracket in the pgrep -f or grep pattern itself keeps the pattern off the shell.
  ['[ -n "$(pgrep -f godot)" ] && kill $(pgrep -f godot)', 'This kills its own shell'],
  ['[[ -n $(pgrep -f godot) ]] && kill $(pgrep -f godot)', 'This kills its own shell'],
  ['pids=($(pgrep -f godot)); kill ${pids[0]}', 'This kills its own shell'],
  ['echo "[done]" && kill $(pgrep -f godot)', 'This kills its own shell'],
  ["echo \"[done]\"; ps aux | grep godot | awk '{print $2}' | xargs kill", 'This kills its own shell'],
  ["[ -n \"$(pgrep -f '[g]odot')\" ] && kill $(pgrep -f godot)", 'This kills its own shell'],
  ["echo \"[done]\" && kill $(pgrep -f '[g]odot')", null],
  ["[ -n \"$(pgrep -f '[g]odot')\" ] && kill $(pgrep -f '[g]odot')", null],
  ["ps aux | grep '[g]odot' | awk '{print $2}' | xargs kill", null],

  // A line that ends in a backslash runs on into the next.
  ['git -C /home/me/Projects/game \\\n  add -A', 'git add -A, --all'],
  ['git commit \\\n  -a -m x', 'git commit -a or --all'],
  ['git add docs/a.md \\\n  docs/b.md', null],
  ['git commit -m x \\\n  && git log --all', null],
]

for (const [command, reason] of FORMS) {
  test(`${reason === null ? 'runs' : 'refuses'}: ${command.replaceAll('\n', '\\n')}`, async ($, on) => {
    engine(on)
    const ran = await $.tool.call({ tool: 'Bash', command })
    if (reason === null) {
      expect({ command, deny: ran.deny }).toEqual({ command, deny: undefined })
    } else {
      expect({ command, reason: ran.deny?.startsWith(reason) }).toEqual({ command, reason: true })
    }
  })
}
