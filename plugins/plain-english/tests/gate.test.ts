import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'
import { directories, gh, isProseFile, pieces, published, resolvePath } from '../hooks/gate'
import { parseFindings } from '../hooks/judge'

const STYLE = '---\nname: Plain English\ndescription: Plain words\n---\n\n# Plain English\n\nWrite plainly.\n'

type World = {
  files: Map<string, string>
  // What the model answers each call, or undefined for an API error.
  reply?: string
  asked: string[]
  ran: string[]
  verdict: 'allow' | 'ask'
  // What a Bash command prints, and whether it fails.
  output: string
  failed?: boolean
  // Each commit's message, by hash, in the directory it was made in.
  commits: Map<string, { dir: string; message: string }>
  // What gh reads back, by the URL or API path it is given.
  github: Map<string, Record<string, unknown>>
}

const world = (over: Partial<World> = {}): World => ({
  files: new Map(),
  reply: '[]',
  asked: [],
  ran: [],
  verdict: 'allow',
  output: '',
  commits: new Map(),
  github: new Map(),
  ...over,
})

const ran = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

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
    return (w.failed ? { result: w.output, isError: true, text: w.output } : { result: 'ran', text: w.output }) as never
  })
  on('classic.SubagentStop', () => ({}))
  on('process.run', (_, e) => {
    const argv = e.argv
    w.ran.push(argv.join(' '))
    if (argv[0] === 'git' && argv[1] === 'log') {
      const commit = w.commits.get(argv.at(-1)!)
      return commit === undefined || commit.dir !== e.init?.cwd ? ran(128, '') : ran(0, `${commit.message}\n`)
    }
    if (argv[0] === 'gh' && (argv[2] === 'view' || argv[1] === 'api')) {
      const json = w.github.get(argv[1] === 'api' ? argv[2]! : argv[3]!)
      return json === undefined ? ran(1, '') : ran(0, JSON.stringify(json))
    }
    return ran(0, 'https://github.com/o/r/pull/1')
  })
}

// The kit's types for `$.tool.call` know each built-in tool's input; these tests pass loose ones.
type Answer = { result?: unknown; text?: string; deny?: string; isError?: boolean; context?: readonly string[] }
const call = ($: Engine, tool: string, input: Record<string, unknown>) => ($.tool as any).call({ tool, ...input }) as Promise<Answer>
const refusal = (r: Answer) => (r.isError === true ? (r.text ?? '') : (r.deny ?? ''))
const notes = (r: Answer) => (r.context ?? []).join('\n')

const LONG =
  'This change moves the refresh logic into one handler. The handler reads the token, checks its expiry, and asks the server for a new one when fewer than five minutes remain. Errors go back to the caller unchanged.'

// What a call carries, and what a shell command published

test('a commit is found by the line git prints for it, a pull request or comment by its URL', () => {
  expect(published('git commit -m "x"', '[main 1a2b3c4] feat: x\n 1 file changed')).toEqual([{ kind: 'commit', sha: '1a2b3c4' }])
  expect(published('git commit -m x', '[main (root-commit) 1a2b3c4] feat: x')).toEqual([{ kind: 'commit', sha: '1a2b3c4' }])
  expect(published('git log', '[main 1a2b3c4] feat: x')).toEqual([])
  expect(published('gh pr create -t T -b B', 'https://github.com/o/r/pull/7\n')).toEqual([{ kind: 'pr', url: 'https://github.com/o/r/pull/7' }])
  expect(published('gh issue comment 4 -b x', 'https://github.com/o/r/issues/4#issuecomment-99')).toEqual([
    { kind: 'comment', url: 'https://github.com/o/r/issues/4#issuecomment-99', repo: 'o/r', id: '99' },
  ])
  expect(published('gh pr view 7', 'https://github.com/o/r/pull/7')).toEqual([])
})

test('a commit is looked for in each directory the command names', () => {
  expect(directories('cd ~/proj && git commit -m x', '/work', '/home/u')).toEqual(['/work', '/home/u/proj'])
  expect(directories('git -C ../other commit -m x', '/work/a', '/home/u')).toEqual(['/work/a', '/work/other'])
})

test('paths resolve ~, . and ..', () => {
  expect(resolvePath('/work', './m.txt')).toBe('/work/m.txt')
  expect(resolvePath('/work/a', '../b/./m.txt')).toBe('/work/b/m.txt')
  expect(resolvePath('/work', '~/x', '/home/u')).toBe('/home/u/x')
})

test('gh gives its title, body and body file, with values attached or apart', () => {
  expect(gh(['gh', 'pr', 'create', '--title', 'T', '--body=B'], '/r')).toEqual([
    { what: 'the pull request title', text: 'T' },
    { what: 'the pull request body', text: 'B' },
  ])
  expect(gh(['gh', 'issue', 'create', '-tA title', '-bA body'], '/r')).toEqual([
    { what: 'the issue title', text: 'A title' },
    { what: 'the issue body', text: 'A body' },
  ])
  expect(gh(['gh', 'pr', 'edit', '3', '-Fbody.md'], '/r')).toEqual([{ what: 'the pull request body', file: '/r/body.md' }])
  expect(gh(['gh', 'pr', 'view', '3'], '/r')).toEqual([])
})

test('prose files and pull request tools are matched; code, config and test files are not', () => {
  expect(pieces('Write', { file_path: '/w/README.md', content: 'x' }, '/w')).toEqual([{ what: '/w/README.md', text: 'x', beforeFile: '/w/README.md' }])
  expect(pieces('Edit', { file_path: 'docs/a.mdx', old_string: 'a', new_string: 'b' }, '/w')).toEqual([
    { what: '/w/docs/a.mdx', text: 'b', before: 'a', beforeFile: '/w/docs/a.mdx', edit: { old: 'a', new: 'b', all: false } },
  ])
  for (const file_path of ['/w/src/a.ts', '/w/CMakeLists.txt', '/w/requirements.txt', '/w/tests/fixtures/claudish.md'])
    expect(pieces('Write', { file_path, content: 'robust' }, '/w')).toEqual([])
  expect(pieces('Write', { file_path: '/w/NOTES.txt', content: 'x' }, '/w')).toHaveLength(1)
  expect(pieces('mcp__review-gate__pull_request', { action: 'open', title: 'T', body: 'B' }, '/w')).toEqual([
    { what: 'the pull request title', text: 'T' },
    { what: 'the pull request body', text: 'B' },
  ])
  expect(pieces('mcp__plain-english__scan', { text: 'robust' }, '/w')).toEqual([])
  expect(pieces('Bash', { command: 'git commit -m "robust"' }, '/w')).toEqual([])
})

test('a project that sits under a folder named tests is still prose', () => {
  expect(isProseFile('/home/u/tests/app/README.md', '/home/u/tests/app')).toBe(true)
  expect(isProseFile('/home/u/tests/app/tests/data.md', '/home/u/tests/app')).toBe(false)
})

// The model's findings

test('a finding stands only where its quote is in the text', () => {
  const text = 'The real fix was simple.\nIt lives in one place.'
  const reply = 'Here:\n[{"quote":"The real fix","why":"crowned","fix":"The fix"},{"quote":"made up","why":"x","fix":"y"},{"quote":"lives in\\none place","why":"metaphor","fix":"is in one place"}]'
  expect(parseFindings(reply, text).map(f => f.quote)).toEqual(['The real fix', 'lives in\none place'])
  expect(parseFindings('not json', text)).toEqual([])
})

test('a reply cut off at its token cap keeps the findings before the cut', () => {
  const text = 'The real fix is here. It does the heavy lifting.'
  expect(parseFindings('[{"quote":"The real fix","why":"crowned","fix":"The fix"},{"quote":"the heavy', text).map(f => f.quote)).toEqual(['The real fix'])
})

// Commits and shell commands, checked after they run

const commit = (w: World, message: string, dir = '/work') => {
  w.commits.set('1a2b3c4', { dir, message })
  w.output = `[main 1a2b3c4] ${message.split('\n')[0]}\n 1 file changed`
}

test('a commit whose message has Claudisms runs, and Claude is told to amend it', async ($, on) => {
  const w = world()
  engine(on, w)
  commit(w, 'feat: a robust parser')
  const r = await call($, 'Bash', { command: 'git commit -am "feat: a robust parser"' })
  expect(w.ran[0]).toBe('Bash')
  expect(notes(r)).toContain('the message of commit 1a2b3c4 has Claudisms')
  expect(notes(r)).toContain('git commit --amend')
  expect(notes(r)).toContain('"robust"')
})

test('a clean commit, and a command that made no commit, get no note', async ($, on) => {
  const w = world()
  engine(on, w)
  commit(w, 'feat: a parser that reads CSV')
  expect(notes(await call($, 'Bash', { command: 'git commit -m "feat: a parser that reads CSV"' }))).toBe('')
  w.output = 'nothing to commit, working tree clean'
  expect(notes(await call($, 'Bash', { command: 'git commit -m "feat: robust"' }))).toBe('')
  expect(w.asked).toEqual([])
})

test('a message written by any shell form is read back whole', async ($, on) => {
  const w = world({ reply: '[{"quote":"Errors go back to the caller","why":"fine really","fix":"cut"}]' })
  engine(on, w)
  commit(w, `fix: refresh\n\nIt says "don't" once. ${LONG}`)
  const r = await call($, 'Bash', { command: `x=$((1<<2))\ncat <<'EOF' | git commit -F -\nfix: refresh\nEOF` })
  expect(w.asked).toHaveLength(1)
  expect(notes(r)).toContain('"Errors go back to the caller": fine really. Plainer: cut it.')
})

test('a short message the scan marked words in still goes to the model', async ($, on) => {
  const w = world({ reply: '[{"quote":"elevate the README","why":"hype verb","fix":"note how to stop it"}]' })
  engine(on, w)
  commit(w, 'docs: elevate the README')
  const r = await call($, 'Bash', { command: 'git commit -m "docs: elevate the README"' })
  expect(w.asked).toHaveLength(1)
  expect(notes(r)).toContain('"elevate the README": hype verb.')
})

test('a commit made in another directory is read there', async ($, on) => {
  const w = world()
  engine(on, w)
  commit(w, 'feat: a seamless handoff', '/home/u/proj')
  const r = await call($, 'Bash', { command: 'cd ~/proj && git commit -m "feat: a seamless handoff"' })
  expect(notes(r)).toContain('"seamless"')
})

test('a pull request, issue or comment made in the shell is read back from GitHub', async ($, on) => {
  const w = world()
  engine(on, w)
  w.output = 'https://github.com/o/r/pull/7'
  w.github.set('https://github.com/o/r/pull/7', { title: 'Leverage the cache', body: 'It reads rows once.' })
  const r = await call($, 'Bash', { command: 'gh pr create --fill' })
  expect(notes(r)).toContain('the pull request https://github.com/o/r/pull/7 has Claudisms')
  expect(notes(r)).toContain('gh pr edit https://github.com/o/r/pull/7')
  w.output = 'https://github.com/o/r/issues/4#issuecomment-99'
  w.github.set('repos/o/r/issues/comments/99', { body: 'Done. Hope this helps!' })
  expect(notes(await call($, 'Bash', { command: 'gh issue comment 4 -b "Done. Hope this helps!"' }))).toContain('gh api -X PATCH repos/o/r/issues/comments/99')
})

test('a failed command gets no check', async ($, on) => {
  const w = world()
  engine(on, w)
  w.failed = true
  commit(w, 'feat: robust')
  await call($, 'Bash', { command: 'git commit -m "feat: robust"' })
  expect(w.ran.filter(c => c.startsWith('git log'))).toEqual([])
})

// Files and tools, checked before they run

test('a write with Claudisms is refused, and runs once rewritten', async ($, on) => {
  const w = world()
  engine(on, w)
  const r = await call($, 'Write', { file_path: '/w/NOTES.md', content: 'A robust parser.\n' })
  expect(refusal(r)).toContain('In /w/NOTES.md:')
  expect(refusal(r)).toContain('"robust"')
  expect(w.ran).toEqual([])
  await call($, 'Write', { file_path: '/w/NOTES.md', content: 'A parser that reads CSV.\n' })
  expect(w.ran).toEqual(['Write'])
})

test('the model judges a paragraph, and its findings refuse the call', async ($, on) => {
  const w = world({ reply: '[{"quote":"Errors go back to the caller","why":"fine really","fix":"cut"}]' })
  engine(on, w)
  const r = await call($, 'Write', { file_path: '/w/NOTES.md', content: LONG })
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]).toContain('Write plainly.')
  expect(refusal(r)).toContain('"Errors go back to the caller": fine really. Plainer: cut it.')
})

test('a short text goes to the word scan alone, and when the model cannot answer the scan stands alone', async ($, on) => {
  const w = world({ reply: undefined })
  engine(on, w)
  await call($, 'Write', { file_path: '/w/NOTES.md', content: 'Keep the path.' })
  expect(w.asked).toEqual([])
  await call($, 'Write', { file_path: '/w/A.md', content: LONG })
  expect(w.ran).toEqual(['Write', 'Write'])
  expect(refusal(await call($, 'Write', { file_path: '/w/B.md', content: `${LONG} It is robust.` }))).toContain('"robust"')
})

test('the same call made again unchanged goes through, and its text stays cleared', async ($, on) => {
  const w = world()
  engine(on, w)
  const input = { file_path: '/w/NOTES.md', content: 'A seamless handoff.\n' }
  expect(refusal(await call($, 'Write', input))).toContain('seamless')
  await call($, 'Write', input)
  await call($, 'Write', input)
  expect(w.ran).toEqual(['Write', 'Write'])
})

test('a call refused for two pieces goes through when made again unchanged', async ($, on) => {
  const w = world()
  engine(on, w)
  const input = { action: 'open', title: 'Leverage the cache', body: 'A seamless handoff.' }
  expect(refusal(await call($, 'mcp__review-gate__pull_request', input))).toContain('In the pull request body:')
  expect(refusal(await call($, 'mcp__review-gate__pull_request', { ...input, body: 'A robust handoff.' }))).toContain('In the pull request title:')
  await call($, 'mcp__review-gate__pull_request', { ...input, body: 'A robust handoff.' })
  expect(w.ran).toEqual(['mcp__review-gate__pull_request'])
})

test('an edit answers only for what it adds, counting repeats', async ($, on) => {
  const w = world({ files: new Map([['/w/README.md', '# Tool\n\nA robust tool.\n\nIt reads CSV.\n']]) })
  engine(on, w)
  await call($, 'Edit', { file_path: '/w/README.md', old_string: 'It reads CSV.', new_string: 'It reads CSV and TSV.' })
  expect(w.ran).toEqual(['Edit'])
  const r = await call($, 'Edit', { file_path: '/w/README.md', old_string: 'It reads CSV.', new_string: 'It reads CSV. A robust reader.' })
  expect(refusal(r)).toContain('"robust"')
})

test('a model finding already in the file excuses only as many as were there', async ($, on) => {
  const file = `# Tool\n\nThe parser does the heavy lifting.\n\n## Use\n\nRun it.\n`
  const w = world({ files: new Map([['/w/README.md', file]]), reply: '[{"quote":"does the heavy lifting","why":"metaphor","fix":"parses"}]' })
  engine(on, w)
  const r = await call($, 'Edit', { file_path: '/w/README.md', old_string: 'Run it.', new_string: `Run it. The cache does the heavy lifting. ${LONG}` })
  expect(refusal(r)).toContain('"does the heavy lifting"')
})

test('an edit inside a code fence is not prose', async ($, on) => {
  const w = world({ files: new Map([['/w/README.md', '# Tool\n\n```js\nconst x = parse(a)\n```\n']]) })
  engine(on, w)
  await call($, 'Edit', { file_path: '/w/README.md', old_string: 'const x = parse(a)', new_string: 'const robust = parse(a)' })
  expect(w.ran).toEqual(['Edit'])
})

test('a text cleared in a code fence is checked again as prose', async ($, on) => {
  const w = world({ files: new Map([['/w/README.md', '# Tool\n\n```\nx\n```\n\nRun it.\n']]) })
  engine(on, w)
  await call($, 'Edit', { file_path: '/w/README.md', old_string: 'x', new_string: 'a robust cache' })
  expect(refusal(await call($, 'Edit', { file_path: '/w/README.md', old_string: 'Run it.', new_string: 'a robust cache' }))).toContain('"robust"')
})

test('a pull request opened through an MCP tool is checked', async ($, on) => {
  const w = world()
  engine(on, w)
  expect(refusal(await call($, 'mcp__review-gate__pull_request', { action: 'open', title: 'Leverage the cache' }))).toContain('In the pull request title:')
})

test('a word used twice is listed once', async ($, on) => {
  const w = world()
  engine(on, w)
  expect(refusal(await call($, 'Write', { file_path: '/w/A.md', content: 'A robust, robust parser.' })).match(/"robust"/g)).toHaveLength(1)
})

test('a model finding that holds a word-scan hit is kept', async ($, on) => {
  const w = world({ reply: '[{"quote":"The real fix — a cache","why":"crowned claim","fix":"A cache fixed it"}]' })
  engine(on, w)
  const r = await call($, 'Write', { file_path: '/w/A.md', content: `${LONG} The real fix — a cache.` })
  expect(refusal(r)).toContain('"The real fix — a cache": crowned claim.')
})

test('literal unlock and elevated are left to the model; empower is a rewrite in every form', async ($, on) => {
  const w = world()
  engine(on, w)
  await call($, 'Write', { file_path: '/w/A.md', content: 'Unlock the mutex with elevated privileges.' })
  expect(w.ran).toEqual(['Write'])
  for (const word of ['empower', 'empowers', 'empowered'])
    expect(refusal(await call($, 'Write', { file_path: '/w/B.md', content: `It will ${word} teams.` }))).toContain(`"${word}"`)
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

test('a subagent report may quote the Claudisms it found', async ($, on) => {
  const w = world()
  engine(on, w)
  const r = await $.classic.SubagentStop({ ...STOP, last_assistant_message: 'The commit says "a seamless handoff" and “Hope this helps”.' })
  expect(r.block).toBeUndefined()
})
