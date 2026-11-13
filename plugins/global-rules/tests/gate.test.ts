import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { INIT_LINE, isInstructionFile } from '../hooks/register'

// Nothing sits beneath the plugin: these hooks stand for the engine. `session.now` is the session
// id the engine reports, which a /clear changes.
function engine(on: On) {
  const session = { now: 'session-1' }
  on('session.id', () => ({ value: session.now }))
  on('tool.call', () => ({ result: {} }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  return session
}

const edit = ($: any, file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
const write = ($: any, file_path: string) => $.tool.call({ tool: 'Write', file_path, content: 'x' })

const INSTRUCTION_FILES = [
  '/home/u/.claude/CLAUDE.md',
  '/home/u/.claude/rules/python.md',
  '/home/u/.claude/rules/lang/go.md',
  '/home/u/game/CLAUDE.md',
  '/home/u/game/.claude/CLAUDE.md',
  '/home/u/game/CLAUDE.local.md',
  '/home/u/game/AGENTS.md',
  '/home/u/game/src/levels/CLAUDE.md',
  '/home/u/game/.claude/rules/api.md',
  'C:\\Users\\u\\.claude\\CLAUDE.md',
]

const OTHER_FILES = [
  '/home/u/game/README.md',
  '/home/u/game/PROJECT.md',
  '/home/u/game/docs/claude.md',
  '/home/u/game/NOT-CLAUDE.md',
  '/home/u/game/CLAUDE.md.bak',
  '/home/u/game/.claude/settings.json',
  '/home/u/game/.claude/rules.md',
  '/home/u/game/.claude/rules/notes.txt',
  '/home/u/.claude/global-rules/backups/home-u-.claude-CLAUDE.md.bak-2026-11-12',
]

test('every Claude Code instruction file is one, and nothing else is', async () => {
  for (const path of INSTRUCTION_FILES) expect({ path, is: isInstructionFile(path) }).toEqual({ path, is: true })
  for (const path of OTHER_FILES) expect({ path, is: isInstructionFile(path) }).toEqual({ path, is: false })
})

test('an edit to an instruction file waits for /global-rules:claude-md', async ($, on) => {
  engine(on)
  const ran = await edit($, '/home/u/.claude/CLAUDE.md')
  expect(ran.deny).toContain('/home/u/.claude/CLAUDE.md is a Claude Code instruction file')
  expect(ran.deny).toContain('Load /global-rules:claude-md first')
  expect((await write($, '/home/u/game/AGENTS.md')).deny).toContain('Load /global-rules:claude-md first')
})

test('other files are edited as ever', async ($, on) => {
  engine(on)
  for (const path of OTHER_FILES) expect({ path, deny: (await edit($, path)).deny }).toEqual({ path, deny: undefined })
})

test('once the skill is loaded, edits and writes go ahead', async ($, on) => {
  engine(on)
  await $.skill.prompt({ skill: 'global-rules:claude-md', text: 'Write the instruction files.' })
  for (const path of INSTRUCTION_FILES) {
    expect({ path, deny: (await edit($, path)).deny }).toEqual({ path, deny: undefined })
    expect({ path, deny: (await write($, path)).deny }).toEqual({ path, deny: undefined })
  }
})

test('the skill counts by its bare name when it comes from this plugin', async ($, on) => {
  engine(on)
  await $.skill.prompt({ skill: 'claude-md', pluginName: 'global-rules', text: 'x' })
  expect((await edit($, '/home/u/.claude/CLAUDE.md')).deny).toBeUndefined()
})

test("another skill, or another plugin's claude-md, doesn't count", async ($, on) => {
  engine(on)
  await $.skill.prompt({ skill: 'project-md:init', pluginName: 'project-md', text: 'x' })
  await $.skill.prompt({ skill: 'other:claude-md', pluginName: 'other', text: 'x' })
  await $.skill.prompt({ skill: 'claude-md', pluginName: 'other', text: 'x' })
  expect((await edit($, '/home/u/.claude/CLAUDE.md')).deny).toContain('Load /global-rules:claude-md first')
})

test('after a /clear, the new conversation loads the skill again', async ($, on) => {
  const session = engine(on)
  await $.skill.prompt({ skill: 'global-rules:claude-md', text: 'x' })
  session.now = 'session-2'
  expect((await edit($, '/home/u/.claude/CLAUDE.md')).deny).toContain('Load /global-rules:claude-md first')
})

test("/init is told to load the skill before it writes, and the skill's prompt is kept", async ($, on) => {
  engine(on)
  const { text } = await $.skill.prompt({ skill: 'init', text: 'Analyze this codebase and create a CLAUDE.md.' })
  expect(text).toBe(`Analyze this codebase and create a CLAUDE.md.\n\n${INIT_LINE}`)
  expect(INIT_LINE).toContain('load /global-rules:claude-md')
})

test("a plugin's init skill and other skills are left as they are", async ($, on) => {
  engine(on)
  expect((await $.skill.prompt({ skill: 'init', pluginName: 'project-md', text: 'Draft PROJECT.md.' })).text).toBe('Draft PROJECT.md.')
  expect((await $.skill.prompt({ skill: 'global-rules:claude-md', text: 'Guidance.' })).text).toBe('Guidance.')
})
