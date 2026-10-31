import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'
import { directories, gh, isGenerated, isTestPath, pieces, published, pushedRefs, pushes, resolvePath, reusesMessage } from '../hooks/gate'
import { parseFindings } from '../hooks/judge'
import { editedLines } from '../hooks/register'

const STYLE = '---\nname: Plain English\ndescription: Plain words\n---\n\n# Plain English\n\nWrite plainly.\n'

type World = {
  files: Map<string, string>
  // What the model answers each call, or undefined for an API error.
  reply?: string
  asked: string[]
  ran: string[]
  // The commands the plugin ran itself.
  runs: string[]
  verdict: 'allow' | 'ask'
  // What a Bash command prints, and whether it fails.
  output: string
  failed?: boolean
  // Each commit's message, by hash, in the directory it was made in.
  commits: Map<string, { dir: string; message: string }>
  // What gh reads back, by the URL or API path it is given.
  github: Map<string, Record<string, unknown>>
  // HEAD as each read finds it, the commits between two HEADs, the commits no remote has, and the
  // repository's root.
  heads: { sha: string; message: string }[]
  between: { sha: string; message: string; time?: number }[]
  unpushed: { sha: string; message: string; time?: number }[]
  root?: string
  // Folders that do not exist yet: git cannot run in them.
  missing: string[]
  // The mod's store, kept across sessions.
  store: Map<string, unknown>
  // The messages in the history before a command.
  history: string[]
}

const world = (over: Partial<World> = {}): World => ({
  files: new Map(),
  reply: '[]',
  asked: [],
  ran: [],
  runs: [],
  verdict: 'allow',
  output: '',
  commits: new Map(),
  github: new Map(),
  heads: [],
  between: [],
  unpushed: [],
  missing: [],
  store: new Map(),
  history: [],
  ...over,
})

const ran = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

// Each hook stands for the engine beneath the plugin.
function engine(on: On, w: World) {
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 's1' }))
  on('store.get', (_, e) => ({ value: w.store.get(e.key) }) as never)
  on('store.set', (_, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }) as never)
  on('store.delete', (_, e) => {
    w.store.delete(e.key)
    return { value: undefined } as never
  })
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
    w.runs.push(argv.join(' '))
    if (w.missing.includes(e.init?.cwd ?? '')) throw new Error(`ENOENT: ${e.init?.cwd}`)
    if (argv[0] === 'git' && argv[1] === 'rev-parse') return w.root === undefined ? ran(128, '') : ran(0, `${w.root}\n`)
    if (argv[0] === 'git' && argv[1] === 'log') {
      // HEAD before and after a command, then the commits between, then one commit's message.
      if (argv.includes('--format=%H%x00%B')) {
        const head = w.heads.shift()
        return head === undefined ? ran(128, '') : ran(0, `${head.sha}\0${head.message}\n`)
      }
      if (argv.includes('--format=%H%x00%at%x00%B%x1e') || argv.includes('--format=%H%x00%ct%x00%B%x1e')) {
        const range = argv.includes('--remotes') ? w.unpushed : w.between
        return ran(0, range.map(c => `${c.sha}\0${c.time ?? Math.floor(Date.now() / 1000)}\0${c.message}\n\x1e`).join(''))
      }
      // The messages already in the history before a command.
      if (argv.includes('--format=%B%x1e')) return ran(0, w.history.map(m => `${m}\n\x1e`).join(''))
      const commit = w.commits.get(argv.at(-1)!)
      return commit === undefined || commit.dir !== e.init?.cwd ? ran(128, '') : ran(0, `${commit.message}\n`)
    }
    if (argv[0] === 'gh' && (argv[2] === 'view' || argv[1] === 'api')) {
      const json = w.github.get(argv[1] === 'api' ? argv.at(-1)! : argv[3]!)
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
    { kind: 'comment', url: 'https://github.com/o/r/issues/4#issuecomment-99', host: 'github.com', repo: 'o/r', id: '99' },
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
  for (const file_path of ['/w/src/a.ts', '/w/CMakeLists.txt', '/w/requirements.txt'])
    expect(pieces('Write', { file_path, content: 'robust' }, '/w')).toEqual([])
  expect(pieces('Write', { file_path: '/w/NOTES.txt', content: 'x' }, '/w')).toHaveLength(1)
  expect(pieces('mcp__github__pull_request', { action: 'open', title: 'T', body: 'B' }, '/w')).toEqual([
    { what: 'the pull request title', text: 'T' },
    { what: 'the pull request body', text: 'B' },
  ])
  expect(pieces('mcp__plain-english__scan', { text: 'robust' }, '/w')).toEqual([])
  expect(pieces('Bash', { command: 'git commit -m "robust"' }, '/w')).toEqual([])
})

test('a project that sits under a folder named tests is still prose', () => {
  expect(isTestPath('/home/u/tests/app/README.md', '/home/u/tests/app')).toBe(false)
  expect(isTestPath('/home/u/tests/app/tests/data.md', '/home/u/tests/app')).toBe(true)
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
  expect(notes(await call($, 'Bash', { command: 'gh issue comment 4 -b "Done. Hope this helps!"' }))).toContain('gh api --hostname github.com -X PATCH repos/o/r/issues/comments/99')
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
  expect(refusal(await call($, 'mcp__github__pull_request', input))).toContain('In the pull request body:')
  expect(refusal(await call($, 'mcp__github__pull_request', { ...input, body: 'A robust handoff.' }))).toContain('In the pull request title:')
  await call($, 'mcp__github__pull_request', { ...input, body: 'A robust handoff.' })
  expect(w.ran).toEqual(['mcp__github__pull_request'])
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

test('a sentence an edit makes longer is the edit\'s, when the edit holds the whole sentence', async ($, on) => {
  const opening = 'The hook reads the message of each commit that the push would send'
  const file = `# Tool\n\n${opening}.\nIt runs once.\n`
  const long = `${opening}, compares its author time with the start of the session, and then refuses the push when any message has a problem.`
  const w = world({ files: new Map([['/w/README.md', file]]), reply: JSON.stringify([{ quote: long, why: 'sentence over 30 words', fix: 'split it' }]) })
  engine(on, w)
  const r = await call($, 'Edit', { file_path: '/w/README.md', old_string: `${opening}.`, new_string: long })
  // The model reads the lines the edit wrote; the quote is the whole sentence, which the file did not have.
  expect(w.asked[0]).toContain(long)
  expect(w.asked[0]).not.toContain('It runs once.')
  expect(refusal(r)).toContain('sentence over 30 words')
})

test('the model reads the lines an edit wrote in the context of the file', () => {
  const at = (file: string, old: string, now: string) => {
    const after = file.replace(old, now)
    return editedLines(after, file.indexOf(old), now.length)
  }
  // A line inside a code block is code, even when the edit holds no fence.
  expect(at('Intro.\n\n```sh\n# a long comment line\nrun --flag a\n```\n', '--flag a', '--flag b').trim()).toBe('')
  // A nested list item is prose, though it starts with four spaces.
  expect(at('- Top item.\n    - Nested item.\n', 'Nested item.', 'Nested item that reads each message.')).toContain('Nested item that reads each message.')
  // An edit that starts inside a code span sees the span blanked, as the file has it.
  const line = at('Run `npm test --coverage` before you push.\n', 'test --coverage` before you push.', 'test --coverage` before you push, and read it.')
  expect(line).toContain('before you push, and read it.')
  expect(line).not.toContain('coverage')
  // An edit over two lines reads both, and no more.
  expect(at('One.\nTwo.\nThree.\n', 'Two.', 'Two.\nTwo and a half.')).toBe('Two.\nTwo and a half.')
  // Line breaks at either end of the edit add no line it did not write.
  expect(at('A.\nB unchanged line.\n', 'A.\n', 'Z.\n')).toBe('Z.')
  expect(at('Prev line words.\nNext.\n', '\nNext.', '\nNew next.')).toBe('New next.')
  expect(at('Prev.\r\nNext.\r\nLast.\r\n', 'Next.\r\n', 'New next.\r\n')).toBe('New next.')
})

test('a long sentence the file had before, inline code and all, is not the edit\'s', async ($, on) => {
  const old = `Run \`npm test\` before you push, and read what it prints, and fix each failure it lists before you ask anyone for a review of the change you made.`
  const w = world({ files: new Map([['/w/README.md', `# Tool\n\n${old}\n`]]), reply: '[{"quote":"Run before you push, and read what it prints","why":"sentence over 30 words","fix":"split it"}]' })
  engine(on, w)
  await call($, 'Write', { file_path: '/w/README.md', content: `# Tool\n\n${old}\n\n${LONG}\n` })
  expect(w.ran).toEqual(['Write'])
  // The brief leaves tables, headings and unpunctuated list items alone.
  expect(w.asked[0]).toContain('A table row, a heading, or a list item with no full stop')
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
  expect(refusal(await call($, 'mcp__github__pull_request', { action: 'open', title: 'Leverage the cache' }))).toContain('In the pull request title:')
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

test('a refusal says that a tone the person asked for is a reason to make the call again', async ($, on) => {
  const w = world({ reply: '[{"quote":"Errors go back to the caller","why":"fine really","fix":"cut"}]' })
  engine(on, w)
  expect(refusal(await call($, 'Write', { file_path: '/w/NOTES.md', content: LONG }))).toContain('a tone the person asked for')
  expect(w.asked[0]).toContain('A tone the whole text keeps on purpose')
  expect(w.asked[0]).toContain('A sentence over 30 words')
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

// The fixes of review round 3

const OLD = { sha: 'a'.repeat(40), message: 'feat: the person’s own words, robust and all' }
const NEW = { sha: `b${'0'.repeat(39)}`, message: 'feat: a seamless handoff' }

test('a quiet commit is found by comparing HEAD before and after', async ($, on) => {
  const w = world({ heads: [OLD, NEW], between: [NEW] })
  engine(on, w)
  w.commits.set('b000000', { dir: '/work', message: NEW.message })
  const r = await call($, 'Bash', { command: 'git commit -q -m "feat: a seamless handoff"' })
  expect(notes(r)).toContain('commit b000000 has Claudisms')
})

test('an amend that keeps the message it replaced is not flagged', async ($, on) => {
  const amended = { sha: `c${'0'.repeat(39)}`, message: OLD.message }
  const w = world({ heads: [OLD, amended], between: [amended] })
  engine(on, w)
  w.commits.set('c000000', { dir: '/work', message: OLD.message })
  expect(notes(await call($, 'Bash', { command: 'git commit --amend --no-edit' }))).toBe('')
})

test('a commit made before a later step failed is still read back', async ($, on) => {
  const w = world({ failed: true })
  engine(on, w)
  commit(w, 'feat: a robust parser')
  w.output += '\nerror: failed to push some refs'
  const r = await call($, 'Bash', { command: 'git commit -m "feat: a robust parser" && git push' })
  expect(notes(r)).toContain('"robust"')
})

test('a push that would send a commit with Claudisms is refused, and goes through when made again', async ($, on) => {
  const w = world({ unpushed: [NEW] })
  engine(on, w)
  const r = await call($, 'Bash', { command: 'git push -u origin HEAD' })
  expect(refusal(r)).toContain('In the message of commit b000000:')
  expect(refusal(r)).toContain('git rebase -i')
  expect(w.ran.includes('Bash')).toBe(false)
  await call($, 'Bash', { command: 'git push -u origin HEAD' })
  expect(w.ran.includes('Bash')).toBe(true)
})

test('a push sends what its refspec names', () => {
  expect(pushedRefs(['git', 'push', '-u', 'origin', 'abc123:refs/heads/feat'])).toEqual(['abc123'])
  expect(pushedRefs(['git', 'push'])).toEqual(['HEAD'])
  expect(pushedRefs(['git', 'push', 'origin', '+main'])).toEqual(['main'])
})

test('a doc in its project test folder is not checked, wherever the shell is', async ($, on) => {
  const w = world({ root: '/w' })
  engine(on, w)
  await call($, 'Write', { file_path: '/w/tests/fixtures/claudish.md', content: 'A robust, seamless parser.' })
  expect(w.ran).toContain('Write')
})

test('gh edits and URLs that are not the last line are not read back; any host is', () => {
  expect(published('gh pr edit 12 --add-label bug', 'https://github.com/o/r/pull/12')).toEqual([])
  expect(published('cat CHANGELOG.md; gh issue comment 4 -b x', 'see https://github.com/o/r/pull/3\nhttps://github.com/o/r/issues/4#issuecomment-9')).toEqual([
    { kind: 'comment', url: 'https://github.com/o/r/issues/4#issuecomment-9', host: 'github.com', repo: 'o/r', id: '9' },
  ])
  expect(published('gh pr create --fill', 'https://github.example.com/o/r/pull/7')).toEqual([{ kind: 'pr', url: 'https://github.example.com/o/r/pull/7' }])
})

test('a short flag value after = is read without it', () => {
  expect(gh(['gh', 'pr', 'create', '-t=T', '-F=body.md'], '/r')).toEqual([
    { what: 'the pull request title', text: 'T' },
    { what: 'the pull request body', file: '/r/body.md' },
  ])
})

test('cd paths chain, and a quoted path may hold spaces', () => {
  expect(directories('cd ../other && cd pkg && git commit -m x', '/w/a')).toEqual(['/w/a', '/w/other', '/w/other/pkg'])
  expect(directories('cd "/path/with space" && git commit -m x', '/w')).toEqual(['/w', '/path/with space'])
})

// The fixes of review round 4

test('a pull or checkout that moves HEAD is not taken for Claude committing', async ($, on) => {
  const w = world({ heads: [OLD, NEW], between: [{ ...NEW, time: 1000 }] })
  engine(on, w)
  w.commits.set('b000000', { dir: '/work', message: NEW.message })
  expect(notes(await call($, 'Bash', { command: 'git pull' }))).toBe('')
  expect(w.runs).toEqual([])
})

test('a commit pulled in by a git commit command is left out by its time', async ($, on) => {
  const w = world({ heads: [OLD, NEW], between: [{ ...NEW, time: 1000 }] })
  engine(on, w)
  w.commits.set('b000000', { dir: '/work', message: NEW.message })
  expect(notes(await call($, 'Bash', { command: 'git merge origin/main && git commit -q -m "x"' }))).toBe('')
})

test('a commit that reuses another message is not flagged', async ($, on) => {
  const w = world()
  engine(on, w)
  commit(w, 'feat: a robust parser')
  expect(notes(await call($, 'Bash', { command: 'git commit -C HEAD~1' }))).toBe('')
  expect(notes(await call($, 'Bash', { command: 'git -c user.name=x commit -m "feat: a robust parser"' }))).toContain('"robust"')
})

test('push counts only as git push, in the directory and for the ref it names', () => {
  expect(pushes('git stash push -m wip', '/w')).toEqual([])
  expect(pushes('git commit -m "push the fix"', '/w')).toEqual([])
  expect(pushes('git log | grep push', '/w')).toEqual([])
  expect(pushes('git push', '/w')).toEqual([{ dir: '/w', refs: ['HEAD'] }])
  expect(pushes('cd ../lib && git push origin feature', '/w/a')).toEqual([{ dir: '/w/lib', refs: ['feature'] }])
  expect(pushes('git -C ../lib push -u origin HEAD', '/w/a')).toEqual([{ dir: '/w/lib', refs: ['HEAD'] }])
})

test('a push option value is not taken for the remote; a delete or tags push sends no commits', () => {
  expect(pushedRefs(['git', 'push', '-o', 'ci.skip', 'origin', 'main'])).toEqual(['main'])
  expect(pushedRefs(['git', 'push', '--repo', 'origin', 'origin', 'dev'])).toEqual(['dev'])
  expect(pushedRefs(['git', 'push', 'origin', '--delete', 'old'])).toEqual([])
  expect(pushedRefs(['git', 'push', 'origin', ':old'])).toEqual([])
  expect(pushedRefs(['git', 'push', '--tags'])).toEqual([])
})

test('a push checks only commits made in this session', async ($, on) => {
  const w = world({ unpushed: [{ ...NEW, time: 1000 }] })
  engine(on, w)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__plain-english__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
  await call($, 'Bash', { command: 'git push -u origin main' })
  expect(w.ran).toEqual(['Bash'])
})

test('a gh URL followed by more output is still read back', () => {
  expect(published('gh pr create -t T -F b.md && echo done', 'https://github.com/o/r/pull/7\ndone')).toEqual([{ kind: 'pr', url: 'https://github.com/o/r/pull/7' }])
})

test('a file outside any project is never a test file', () => {
  expect(isTestPath('/tmp/test/README.md')).toBe(false)
  expect(isTestPath('/r/tests/README.md', '/r')).toBe(true)
})

// The fixes of review round 5

test('a commit first written before the session is not charged, however it was rewritten', async ($, on) => {
  // A rebase gives the person's old commit a new hash and committer time but keeps its author time.
  const w = world({ unpushed: [{ ...NEW, time: 1000 }], heads: [OLD, NEW], between: [{ ...NEW, time: 1000 }] })
  engine(on, w)
  w.commits.set('b000000', { dir: '/work', message: NEW.message })
  expect(notes(await call($, 'Bash', { command: 'git rebase main' }))).toBe('')
  await call($, 'Bash', { command: 'git push' })
  expect(w.ran).toEqual(['Bash', 'Bash'])
})

test('a merge or rebase that writes a new message is read back', async ($, on) => {
  const merge = { sha: `d${'0'.repeat(39)}`, message: 'Merge feat: a seamless handoff' }
  const w = world({ heads: [OLD, merge], between: [merge] })
  engine(on, w)
  w.commits.set('d000000', { dir: '/work', message: merge.message })
  expect(notes(await call($, 'Bash', { command: 'git merge --no-ff -m "Merge feat: a seamless handoff" feat' }))).toContain('"seamless"')
})

test('messages git writes from another commit are not charged', async ($, on) => {
  const fixup = { sha: `e${'0'.repeat(39)}`, message: 'fixup! feat: a robust parser' }
  const w = world({ heads: [OLD, fixup], between: [fixup], unpushed: [fixup, { ...NEW, sha: `f${'0'.repeat(39)}`, message: 'Revert "feat: a robust parser"' }] })
  engine(on, w)
  w.commits.set('e000000', { dir: '/work', message: fixup.message })
  w.output = `[main e000000] ${fixup.message}`
  expect(notes(await call($, 'Bash', { command: 'git commit --fixup=abc123' }))).toBe('')
  await call($, 'Bash', { command: 'git push' })
  expect(w.ran).toEqual(['Bash', 'Bash'])
})

test('an option named inside a message is not taken for one, and one reused message does not excuse the rest', () => {
  expect(reusesMessage('git commit -m "fix: handle the -c option"')).toBe(false)
  expect(reusesMessage('git commit --amend --no-edit && git commit -m "feat: new words"')).toBe(false)
  expect(reusesMessage('git commit --amend --no-edit')).toBe(true)
  expect(reusesMessage('git commit --squash=abc')).toBe(true)
})

test('a push sends every refspec it names, all branches for --all, and a branch alongside --tags', () => {
  expect(pushedRefs(['git', 'push', 'origin', 'feat-a', 'feat-b'])).toEqual(['feat-a', 'feat-b'])
  expect(pushedRefs(['git', 'push', '--all', 'origin'])).toEqual(['--branches'])
  expect(pushedRefs(['git', 'push', 'origin', 'main', '--tags'])).toEqual(['main'])
  expect(pushedRefs(['git', 'push', '--prune', 'origin', 'main'])).toEqual(['main'])
})

test('a doc in a test folder not made yet is found by the nearest folder that exists', async ($, on) => {
  const w = world({ root: '/w', missing: ['/w/tests/fixtures/claudisms'] })
  engine(on, w)
  await call($, 'Write', { file_path: '/w/tests/fixtures/claudisms/README.md', content: 'A robust, seamless parser.' })
  expect(w.ran).toEqual(['Write'])
})

test('the session start is kept by session id, so a resumed session keeps its own', async ($, on) => {
  const now = Math.floor(Date.now() / 1000)
  const w = world({ unpushed: [{ ...NEW, time: now - 3600 }], store: new Map([['start:s1', now - 7200]]) })
  engine(on, w)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__plain-english__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
  expect(w.store.get('start:s1')).toBe(now - 7200)
  expect(refusal(await call($, 'Bash', { command: 'git push' }))).toContain('commit b000000')
})

// The fixes of review round 6

test('a session with no start stored is taken to have begun hours ago, not at the push', async ($, on) => {
  const w = world({ unpushed: [{ ...NEW, time: Math.floor(Date.now() / 1000) - 3600 }] })
  engine(on, w)
  expect(refusal(await call($, 'Bash', { command: 'git push' }))).toContain('commit b000000')
  expect(w.store.get('start:s1')).toBeLessThan(Math.floor(Date.now() / 1000) - 3600)
})

test('a quiet amend that gives an earlier commit a new message is read back; one that kept it is not', async ($, on) => {
  const amended = { sha: `c${'0'.repeat(39)}`, message: 'fix: a robust, seamless fix' }
  const w = world({ heads: [OLD, amended], between: [amended], history: [OLD.message] })
  engine(on, w)
  w.commits.set('c000000', { dir: '/work', message: amended.message })
  expect(notes(await call($, 'Bash', { command: 'git commit --amend -q -m "fix: a robust, seamless fix"' }))).toContain('"robust"')
  // A rebase replays commits whose messages were already there.
  w.heads.push(OLD, amended)
  w.history.push(amended.message)
  expect(notes(await call($, 'Bash', { command: 'git rebase main' }))).toBe('')
})

test('a generated subject with a body of Claude’s own is read', async ($, on) => {
  const merge = { sha: `d${'0'.repeat(39)}`, message: "Merge branch 'feat'\n\nThis seamlessly unlocks a robust flow." }
  const w = world({ heads: [OLD, merge], between: [merge] })
  engine(on, w)
  w.commits.set('d000000', { dir: '/work', message: merge.message })
  expect(notes(await call($, 'Bash', { command: 'git merge --no-ff feat -m "Merge branch \'feat\'" -m "This seamlessly unlocks a robust flow."' }))).toContain('"robust"')
})

test('a squash with its own message is Claude’s text; a revert as git words it is not', () => {
  expect(reusesMessage('git commit --squash=abc -m "A robust body"')).toBe(false)
  expect(reusesMessage('git commit --fixup=abc')).toBe(true)
  expect(isGenerated('Revert "feat: x"\n\nThis reverts commit 1a2b3c4d.')).toBe(true)
  expect(isGenerated('Revert "feat: x"\n\nIt was robust.')).toBe(false)
})

test('a store that fails does not break the session start', async ($, on) => {
  const w = world()
  engine(on, w)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__plain-english__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  w.store = { get: () => undefined, set: () => { throw new Error('disk full') }, keys: () => [], delete: () => true } as never
  const r = await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
  expect(r).toEqual({ cwd: '/work' })
})
