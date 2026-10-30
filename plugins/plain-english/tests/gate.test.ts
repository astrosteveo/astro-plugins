import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'
import { gh, parse, pieces, shellPieces } from '../hooks/gate'
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
  on('process.run', (_, e) => {
    w.ran.push(e.argv.join(' '))
    return { value: { exitCode: 0, stdout: 'https://github.com/o/r/pull/1', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
}

// The kit's types for `$.tool.call` know each built-in tool's input; these tests pass loose ones.
const call = ($: Engine, tool: string, input: Record<string, unknown>) =>
  ($.tool as any).call({ tool, ...input }) as Promise<{ result?: unknown; text?: string; deny?: string; isError?: boolean }>
const refusal = (r: { text?: string; deny?: string; isError?: boolean }) => (r.isError === true ? (r.text ?? '') : (r.deny ?? ''))

const LONG =
  'This change moves the refresh logic into one handler. The handler reads the token, checks its expiry, and asks the server for a new one when fewer than five minutes remain. Errors go back to the caller unchanged.'

// What a shell command publishes

const sh = (line: string) => shellPieces(line, '/work')
const message = (text: string) => [{ what: 'the commit message', text }]

test('a commit message is read from -m, --message and a here-document', () => {
  expect(sh('git commit -m "fix: one" -m "Two."')).toEqual(message('fix: one\n\nTwo.'))
  expect(sh("git add a.ts && git commit --message='feat: x'")).toEqual(message('feat: x'))
  expect(sh(`git commit -m "$(cat <<'EOF'\nfeat: add it\n\nIt's here.\nEOF\n)"`)).toEqual(message("feat: add it\n\nIt's here."))
  expect(sh("git commit -F - <<'EOF'\nfix: from stdin\nEOF")).toEqual(message('fix: from stdin'))
  expect(sh('git -C /repo commit -F msg.txt')).toEqual([{ what: 'the commit message', file: '/repo/msg.txt' }])
})

test('a commit on a later line of the command is found', () => {
  expect(sh('git add -A\ngit commit -m "feat: a parser"')).toEqual(message('feat: a parser'))
  expect(sh('git status\ngh pr create --title "T" --body "B"')).toHaveLength(2)
})

test('combined short flags give their message', () => {
  for (const flags of ['-am', '-sm', '-nm', '-vm']) expect(sh(`git commit ${flags} "feat: x"`)).toEqual(message('feat: x'))
  expect(sh('git commit -mfeat:x')).toEqual(message('feat:x'))
})

test('a here-document leaves the rest of its line, and each command reads its own', () => {
  expect(sh("cat <<'EOF' | git commit -F -\nfeat: piped\nEOF")).toEqual(message('feat: piped'))
  expect(sh("cat > notes.md <<'EOF'\nA robust tool.\nEOF\ngit commit -F - <<'EOF'\nfix: x\nEOF")).toEqual(message('fix: x'))
  expect(sh('echo "fix: echoed" | git commit -F -')).toEqual(message('fix: echoed'))
})

test('a message file the same line writes is read as written, in the directory it was written', () => {
  expect(sh("cat > /tmp/msg.txt <<'EOF'\nfeat: new\nEOF\ngit commit -F /tmp/msg.txt")).toEqual(message('feat: new'))
  expect(sh("cat <<EOF > m.txt && git commit -F m.txt\nfeat: same line\nEOF")).toEqual(message('feat: same line'))
  expect(sh('cd /repo && git commit -F msg.txt')).toEqual([{ what: 'the commit message', file: '/repo/msg.txt' }])
})

test('commands that publish no prose carry none', () => {
  for (const command of ['git commit --amend --no-edit', 'git status', 'echo "git commit -m robust"', 'gh pr view 3', 'git log -m', 'ls 2>&1 | head'])
    expect(sh(command)).toEqual([])
})

test('a pull request or issue gives its title, body and body file', () => {
  expect(sh('gh pr create --title "Add it" --body "The body."')).toEqual([
    { what: 'the pull request title', text: 'Add it' },
    { what: 'the pull request body', text: 'The body.' },
  ])
  expect(sh('gh issue comment 4 -b "Thanks."')).toEqual([{ what: 'the issue comment', text: 'Thanks.' }])
  expect(sh('gh pr edit 3 --body-file /tmp/b.md')).toEqual([{ what: 'the pull request body', file: '/tmp/b.md' }])
  expect(gh(['gh', 'pr', 'create', '--title', 'T', '--body=B'], '/r')).toEqual([
    { what: 'the pull request title', text: 'T' },
    { what: 'the pull request body', text: 'B' },
  ])
})

test('quotes, escapes, comments and operators split as a shell splits them', () => {
  expect(parse(`a "b \\"c\\"" 'd e'&&f;g # h`).map(c => c.words)).toEqual([['a', 'b "c"', 'd e'], ['f'], ['g']])
})

test('prose files and pull request tools are matched; code, config and test files are not', () => {
  expect(pieces('Write', { file_path: '/r/README.md', content: 'x' }, '/w')).toEqual([{ what: '/r/README.md', text: 'x', beforeFile: '/r/README.md' }])
  expect(pieces('Edit', { file_path: 'docs/a.mdx', old_string: 'a', new_string: 'b' }, '/w')).toEqual([
    { what: '/w/docs/a.mdx', text: 'b', before: 'a', beforeFile: '/w/docs/a.mdx', edit: { old: 'a', new: 'b', all: false } },
  ])
  for (const file_path of ['/r/src/a.ts', '/r/CMakeLists.txt', '/r/requirements.txt', '/r/tests/fixtures/claudish.md'])
    expect(pieces('Write', { file_path, content: 'robust' }, '/w')).toEqual([])
  expect(pieces('Write', { file_path: '/r/NOTES.txt', content: 'x' }, '/w')).toHaveLength(1)
  expect(pieces('mcp__review-gate__pull_request', { action: 'open', title: 'T', body: 'B' }, '/w')).toEqual([
    { what: 'the title', text: 'T' },
    { what: 'the body', text: 'B' },
  ])
  expect(pieces('mcp__plain-english__scan', { text: 'robust' }, '/w')).toEqual([])
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
  // A text sent through stays cleared: checking it again would only repeat what Claude set aside.
  await call($, 'Bash', { command })
  expect(w.ran).toEqual(['Bash', 'Bash'])
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

test('a word used twice is listed once', async ($, on) => {
  const w = world()
  engine(on, w)
  const r = await call($, 'Bash', { command: 'git commit -m "feat: a robust, robust parser"' })
  expect(refusal(r).match(/"robust"/g)).toHaveLength(1)
})

// The fixes of review round 1

test('a call refused for two pieces goes through when made again unchanged', async ($, on) => {
  const w = world()
  engine(on, w)
  const input = { action: 'open', title: 'Leverage the cache', body: 'A seamless handoff.' }
  expect(refusal(await call($, 'mcp__review-gate__pull_request', input))).toContain('In the body:')
  expect(refusal(await call($, 'mcp__review-gate__pull_request', { ...input, body: 'A robust handoff.' }))).toContain('In the title:')
  await call($, 'mcp__review-gate__pull_request', { ...input, body: 'A robust handoff.' })
  expect(w.ran).toEqual(['mcp__review-gate__pull_request'])
})

test('an edit inside a code fence is not prose', async ($, on) => {
  const w = world({ files: new Map([['/r/README.md', '# Tool\n\n```js\nconst x = parse(a)\n```\n']]) })
  engine(on, w)
  await call($, 'Edit', { file_path: '/r/README.md', old_string: 'const x = parse(a)', new_string: 'const robust = parse(a)' })
  expect(w.ran).toEqual(['Edit'])
})

test('a subagent report may quote the Claudisms it found', async ($, on) => {
  const w = world()
  engine(on, w)
  const r = await $.classic.SubagentStop({ ...STOP, last_assistant_message: 'The commit says "a seamless handoff" and “Hope this helps”.' })
  expect(r.block).toBeUndefined()
})

test('a reply cut off at its token cap keeps the findings before the cut', () => {
  const text = 'The real fix is here. It does the heavy lifting.'
  expect(parseFindings('[{"quote":"The real fix","why":"crowned","fix":"The fix"},{"quote":"the heavy', text).map(f => f.quote)).toEqual(['The real fix'])
})

test('a model finding that holds a word-scan hit is kept', async ($, on) => {
  const w = world({ reply: '[{"quote":"The real fix — a cache","why":"crowned claim","fix":"A cache fixed it"}]' })
  engine(on, w)
  const r = await call($, 'Bash', { command: `git commit -m "fix: x" -m "${LONG} The real fix — a cache."` })
  expect(refusal(r)).toContain('"The real fix — a cache": crowned claim.')
})

test('literal unlock and elevated are left to the model; empower is a rewrite in every form', async ($, on) => {
  const w = world()
  engine(on, w)
  await call($, 'Bash', { command: 'git commit -m "fix: unlock the mutex with elevated privileges"' })
  expect(w.ran).toEqual(['Bash'])
  for (const word of ['empower', 'empowers', 'empowered'])
    expect(refusal(await call($, 'Bash', { command: `git commit -m "feat: ${word} teams"` }))).toContain(`"${word}"`)
})
