import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'
import { pieces, shellPieces, words } from '../hooks/gate'
import { parseFindings } from '../hooks/judge'

const STYLE = '---\nname: Plain English\ndescription: Plain words\n---\n\n# Plain English\n\nWrite plainly.\n'

type World = {
  files: Map<string, string>
  // What the model answers each call, or undefined for an API error.
  reply?: string
  asked: string[]
  ran: string[]
  verdict: 'allow' | 'ask'
}

const world = (over: Partial<World> = {}): World => ({ files: new Map(), reply: '[]', asked: [], ran: [], verdict: 'allow', ...over })

// Each hook stands for the engine beneath the plugin.
function engine(on: On, w: World) {
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', () => ({ value: '/home/u' }))
  // The person's rules for reading a file; every other call is allowed.
  on('tool.check', (_, e) => ({ decision: e.tool === 'Read' ? w.verdict : 'allow' }))
  on('fs.read', (_, e) => {
    const path = String(e.path)
    const text = path.endsWith('/output-styles/plain-english.md') ? STYLE : w.files.get(path)
    if (text === undefined) throw new Error(`ENOENT: ${path}`)
    return { value: text }
  })
  on('model.complete', (_, e) => {
    w.asked.push(e.prompt)
    if (w.reply === undefined)
      return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage: { input_tokens: 0, output_tokens: 0 } } } as never
    return { value: { isAnswered: true, text: w.reply, usage: { input_tokens: 1, output_tokens: 1 } } } as never
  })
  on('tool.call', (_, e) => {
    w.ran.push(e.tool)
    return { result: 'ran' } as never
  })
  on('classic.SubagentStop', () => ({}))
}

// The kit's types for `$.tool.call` know each built-in tool's input; these tests pass loose ones.
const call = ($: Engine, tool: string, input: Record<string, unknown>) =>
  ($.tool as any).call({ tool, ...input }) as Promise<{ result?: unknown; text?: string; deny?: string; isError?: boolean }>
const refusal = (r: { text?: string; deny?: string; isError?: boolean }) => (r.isError === true ? (r.text ?? '') : (r.deny ?? ''))

const LONG =
  'This change moves the refresh logic into one handler. The handler reads the token, checks its expiry, and asks the server for a new one when fewer than five minutes remain. Errors go back to the caller unchanged.'

// What a shell command publishes

test('a commit message is read from -m, --message and a here-document', () => {
  expect(shellPieces('git commit -m "fix: one" -m "Two."')).toEqual([{ what: 'the commit message', text: 'fix: one\n\nTwo.' }])
  expect(shellPieces("git add a.ts && git commit --message='feat: x'")).toEqual([{ what: 'the commit message', text: 'feat: x' }])
  const heredoc = `git commit -m "$(cat <<'EOF'\nfeat: add it\n\nIt's here.\nEOF\n)"`
  expect(shellPieces(heredoc)).toEqual([{ what: 'the commit message', text: "feat: add it\n\nIt's here." }])
  expect(shellPieces("git commit -F - <<'EOF'\nfix: from stdin\nEOF")).toEqual([{ what: 'the commit message', text: 'fix: from stdin' }])
  expect(shellPieces('git -C /repo commit -F msg.txt')).toEqual([{ what: 'the commit message', file: 'msg.txt' }])
})

test('commands that publish no prose carry none', () => {
  for (const command of ['git commit --amend --no-edit', 'git status', 'echo "git commit -m robust"', 'gh pr view 3', 'git log -m'])
    expect(shellPieces(command)).toEqual([])
})

test('a pull request or issue gives its title, body and body file', () => {
  expect(shellPieces('gh pr create --title "Add it" --body "The body."')).toEqual([
    { what: 'the pull request title', text: 'Add it' },
    { what: 'the pull request body', text: 'The body.' },
  ])
  expect(shellPieces('gh issue comment 4 -b "Thanks."')).toEqual([{ what: 'the issue comment', text: 'Thanks.' }])
  expect(shellPieces('gh pr edit 3 --body-file /tmp/b.md')).toEqual([{ what: 'the pull request body', file: '/tmp/b.md' }])
})

test('quotes, escapes and operators split as a shell splits them', () => {
  expect(words(`a "b \\"c\\"" 'd e'&&f;g`)).toEqual(['a', 'b "c"', 'd e', '&', '&', 'f', ';', 'g'])
})

test('prose files and pull request tools are matched; code files are not', () => {
  expect(pieces('Write', { file_path: '/r/README.md', content: 'x' })).toEqual([{ what: '/r/README.md', text: 'x', beforeFile: '/r/README.md' }])
  expect(pieces('Edit', { file_path: '/r/docs/a.mdx', old_string: 'a', new_string: 'b' })).toEqual([{ what: '/r/docs/a.mdx', text: 'b', before: 'a' }])
  expect(pieces('Write', { file_path: '/r/src/a.ts', content: 'robust' })).toEqual([])
  expect(pieces('mcp__review-gate__pull_request', { action: 'open', title: 'T', body: 'B' })).toEqual([
    { what: 'the title', text: 'T' },
    { what: 'the body', text: 'B' },
  ])
  expect(pieces('mcp__plain-english__scan', { text: 'robust' })).toEqual([])
})

// The model's findings

test('a finding stands only where its quote is in the text', () => {
  const text = 'The real fix was simple.\nIt lives in one place.'
  const reply = 'Here:\n[{"quote":"The real fix","why":"crowned","fix":"The fix"},{"quote":"made up","why":"x","fix":"y"},{"quote":"lives in\\none place","why":"metaphor","fix":"is in one place"}]'
  expect(parseFindings(reply, text).map(f => f.quote)).toEqual(['The real fix', 'lives in\none place'])
  expect(parseFindings('not json', text)).toEqual([])
})

// The gate

test('a commit message with a stock word is refused with the fix, and runs once rewritten', async ($, on) => {
  const w = world()
  engine(on, w)
  const r = await call($, 'Bash', { command: 'git commit -m "feat: a robust parser"' })
  expect(refusal(r)).toContain('In the commit message:')
  expect(refusal(r)).toContain('"robust"')
  expect(w.ran).toEqual([])
  await call($, 'Bash', { command: 'git commit -m "feat: a parser that reads CSV"' })
  expect(w.ran).toEqual(['Bash'])
})

test('the model judges a paragraph, and its findings refuse the call', async ($, on) => {
  const w = world({ reply: '[{"quote":"Errors go back to the caller","why":"fine really","fix":"cut"}]' })
  engine(on, w)
  const r = await call($, 'Bash', { command: `git commit -m "fix: refresh" -m "${LONG}"` })
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]).toContain('Write plainly.')
  expect(refusal(r)).toContain('"Errors go back to the caller": fine really. Plainer: cut it.')
  expect(w.ran).toEqual([])
})

test('a short text goes to the word scan alone', async ($, on) => {
  const w = world()
  engine(on, w)
  await call($, 'Bash', { command: 'git commit -m "fix: keep the path"' })
  expect(w.asked).toEqual([])
  expect(w.ran).toEqual(['Bash'])
})

test('when the model cannot answer, only the word scan holds the call', async ($, on) => {
  const w = world({ reply: undefined })
  engine(on, w)
  await call($, 'Bash', { command: `git commit -m "fix: refresh" -m "${LONG}"` })
  expect(w.ran).toEqual(['Bash'])
  const r = await call($, 'Bash', { command: `git commit -m "fix: refresh" -m "${LONG} It is robust."` })
  expect(refusal(r)).toContain('"robust"')
})

test('the same text sent again unchanged goes through', async ($, on) => {
  const w = world()
  engine(on, w)
  const command = 'git commit -m "feat: a seamless handoff"'
  expect(refusal(await call($, 'Bash', { command }))).toContain('seamless')
  await call($, 'Bash', { command })
  expect(w.ran).toEqual(['Bash'])
  // Held once more after that, as a new attempt.
  expect(refusal(await call($, 'Bash', { command }))).toContain('seamless')
})

test('an edit answers only for what it adds', async ($, on) => {
  const w = world()
  engine(on, w)
  await call($, 'Edit', { file_path: '/r/README.md', old_string: 'A robust tool.', new_string: 'A robust tool that reads CSV.' })
  expect(w.ran).toEqual(['Edit'])
  const r = await call($, 'Edit', { file_path: '/r/README.md', old_string: 'A tool.', new_string: 'A comprehensive tool.' })
  expect(refusal(r)).toContain('"comprehensive"')
})

test('a write over a prose file answers only for what it adds; a code file is not checked', async ($, on) => {
  const w = world({ files: new Map([['/r/README.md', '# Tool\n\nA robust tool.\n']]) })
  engine(on, w)
  await call($, 'Write', { file_path: '/r/README.md', content: '# Tool\n\nA robust tool.\n\nIt reads CSV.\n' })
  await call($, 'Write', { file_path: '/r/a.ts', content: '// a robust, seamless parser\n' })
  expect(w.ran).toEqual(['Write', 'Write'])
  const r = await call($, 'Write', { file_path: '/r/NOTES.md', content: 'Let me know if this helps.\n' })
  expect(refusal(r)).toContain('In /r/NOTES.md:')
})

test('a body file is read where the person lets Claude read it, and passed over where not', async ($, on) => {
  const w = world({ files: new Map([['/tmp/b.md', 'A game-changing release.']]) })
  engine(on, w)
  expect(refusal(await call($, 'Bash', { command: 'gh pr create -t "Release" -F /tmp/b.md' }))).toContain('In the pull request body:')
  w.verdict = 'ask'
  await call($, 'Bash', { command: 'gh pr create -t "Release" -F /tmp/b.md --draft' })
  expect(w.ran).toEqual(['Bash'])
})

test('a pull request opened through an MCP tool is checked', async ($, on) => {
  const w = world()
  engine(on, w)
  const r = await call($, 'mcp__review-gate__pull_request', { action: 'open', title: 'Leverage the cache' })
  expect(refusal(r)).toContain('In the title:')
})

// Subagent reports

const STOP = { stop_hook_active: false, agent_id: 'a1', agent_transcript_path: '/t', agent_type: 'general-purpose' } as const

test('a subagent report with Claudisms is sent back once, with the list', async ($, on) => {
  const w = world()
  engine(on, w)
  const r = await $.classic.SubagentStop({ ...STOP, last_assistant_message: 'Found it. Hope this helps!' })
  expect(r.block).toContain('"Hope this helps"')
  const again = await $.classic.SubagentStop({ ...STOP, stop_hook_active: true, last_assistant_message: 'Found it. Hope this helps!' })
  expect(again.block).toBeUndefined()
})

test('a clean report, an empty one and a JSON answer finish as they are', async ($, on) => {
  const w = world()
  engine(on, w)
  for (const text of [LONG, '', '{"verdict":"robust"}']) {
    const r = await $.classic.SubagentStop({ ...STOP, last_assistant_message: text })
    expect(r.block).toBeUndefined()
  }
  expect(w.asked).toHaveLength(1)
})
