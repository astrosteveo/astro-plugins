import type { EngineInterface, Register } from 'claude-code'
import { list, problems } from './check'
import { type Piece, type Published, commits, directories, gh, isGenerated, isTestPath, pieces, published, pushedRefs, pushes, resolvePath, reusesMessage } from './gate'
import { report, scan } from './scan'
import { STYLE_FILE, hasRules, parseStyle, withRules } from './style'

const SCAN = 'mcp__plain-english__scan'

const SCAN_TOOL = {
  name: 'scan',
  description:
    'Scan prose for Claudisms: the stock words, set phrases and forms that mark machine-written text. Give a file path, or text, or neither to scan the reply that ended your last turn. To check a draft before you send it, pass the draft as text; a subagent always does. Lists each word-scan hit by line and column, as one to rewrite or one to check by eye, then the forms a model found that a word search cannot see, each with a plainer form. The word scan skips code, block quotes and URLs, but not text in quotation marks.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A file to scan: absolute, under ~, or relative to the working directory.' },
      text: { type: 'string', description: 'Text to scan, in place of a file.' },
    },
  },
}

const LAST_REPLY = { plugin: 'plain-english', key: 'lastReply' } as const

const asText = (value: unknown) => (typeof value === 'string' ? value : '')

// The absolute path, or undefined for a path under ~ when HOME is not set.
async function resolve($: EngineInterface, path: string) {
  if (path.startsWith('/')) return path
  if (path === '~' || path.startsWith('~/')) {
    const home = await $.env.get('HOME')
    return home === undefined || home === '' ? undefined : `${home}${path.slice(1)}`
  }
  return `${await $.session.cwd()}/${path}`
}

// A file's text, read only where the person's rules let Claude read it; elsewhere the model reads
// it with Read, which asks, and passes the text.
async function readFile($: EngineInterface, path: string): Promise<{ text: string } | { deny: string }> {
  const file = await resolve($, path)
  if (file === undefined) return { deny: `HOME is not set, so ${path} has no place. Give an absolute path.` }
  const verdict = await $.tool.check({ tool: 'Read', input: { file_path: file } })
  if (verdict.decision !== 'allow')
    return { deny: `Reading ${path} is not allowed without asking. Read it with the Read tool and pass its text as text.` }
  const body = await $.fs.read(file).catch(() => undefined)
  return typeof body === 'string' ? { text: body } : { deny: `Could not read ${path} as text.` }
}

const readable = async ($: EngineInterface, path: string) => {
  const read = await readFile($, path)
  return 'text' in read ? read.text : undefined
}

async function scanFile($: EngineInterface, path: string): Promise<Answer> {
  const read = await readFile($, path)
  return 'text' in read ? { result: await judged($, path, read.text) } : read
}

// The word scan's report, and under it what the model found that the scan did not.
async function judged($: EngineInterface, source: string, text: string) {
  const base = report(source, scan(text))
  const found = (await problems($, text)).filter(p => p.fix !== undefined)
  return found.length === 0 ? base : `${base}\n\nFound by a model reading the text:\n${list(found)}`
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

// An Edit applied to the file's text, or undefined where the old text is not in it.
function applied(file: string, edit: { old: string; new: string; all: boolean }) {
  if (edit.old === '' || !file.includes(edit.old)) return undefined
  return edit.all ? file.split(edit.old).join(edit.new) : file.replace(edit.old, () => edit.new)
}

// A piece's text, what it replaces, and what the model reads of it. An Edit is scanned as the file
// it leaves, so code fences around it keep their meaning, and the model reads only its new words.
async function prepare($: EngineInterface, piece: Piece) {
  const text = piece.text ?? (piece.file === undefined ? undefined : await readable($, piece.file))
  if (text === undefined) return undefined
  const file = piece.beforeFile === undefined ? undefined : await readable($, piece.beforeFile)
  if (piece.edit !== undefined) {
    const after = file === undefined ? undefined : applied(file, piece.edit)
    return after === undefined ? { text, scanned: text, before: piece.edit.old } : { text, scanned: after, before: file!, judged: piece.edit.new }
  }
  return { text, scanned: text, before: piece.before ?? file ?? '' }
}

type Answer = { result: string } | { deny: string }

// A file, a text, or with neither the main thread's last reply.
async function scanFor($: EngineInterface, e: { path?: unknown; text?: unknown; agentId?: string }): Promise<Answer> {
  const path = asText(e.path).trim()
  const text = asText(e.text)
  if (path !== '' && text !== '') return { deny: 'Give a path or text, not both.' }
  if (path !== '') return scanFile($, path)
  if (text !== '') return { result: await judged($, 'the text', text) }
  // The stored reply is the main thread's. A subagent's own draft is not stored, and the main
  // thread's text is not the subagent's to correct.
  if (e.agentId !== undefined) return { deny: 'In a subagent, pass your draft as text, or a path.' }
  const { value } = await $.state.get(LAST_REPLY)
  if (value === undefined || value === '') return { deny: 'There is no earlier reply to scan. Pass a path or text.' }
  return { result: await judged($, 'your last reply', value) }
}

// A short hash of a text (cyrb53), so what the gate remembers stays small.
function hash(text: string) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

type Memory = {
  // The calls the gate refused, by what they carry. The same call made again goes through: the
  // model read the findings and judged them wrong, as for a word used literally. A pass is kept
  // until the call runs, so a call another hook refuses keeps it.
  held: Set<string>
  // Texts that passed, each with what it is and what it replaced, so the gh that review-gate runs
  // for a pull request already checked here costs no second model call. A text cleared in one
  // place is checked again in another.
  cleared: Set<string>
}

const REWRITE = 'Rewrite them in plain English and make the call again.'

// The refusal for a call's pieces, if any, and the key the call is held by. `advice` says how to
// fix what was found.
async function gate($: EngineInterface, { held, cleared }: Memory, kind: string, found: readonly Piece[], advice = REWRITE) {
  const ready = (await Promise.all(found.map(p => prepare($, p)))).map((p, i) => (p === undefined ? undefined : { ...p, what: found[i]!.what }))
  const known = ready.filter(p => p !== undefined)
  const key = hash(`${kind}\u0000${known.map(p => `${p.what}\u0000${flat(p.text)}`).join('\u0001')}`)
  const clearKey = (p: (typeof known)[number]) => hash(`${p.what}\u0000${p.scanned}\u0000${p.before}`)
  if (known.length === 0) return { key }
  if (held.has(key)) {
    for (const p of known) cleared.add(clearKey(p))
    return { key, passed: true }
  }
  const refusals: string[] = []
  for (const p of known) {
    if (cleared.has(clearKey(p))) continue
    const problem = await problems($, p.scanned, { before: p.before, judged: p.judged })
    if (problem.length === 0) cleared.add(clearKey(p))
    else refusals.push(`In ${p.what}:\n${list(problem)}`)
  }
  if (refusals.length === 0) return { key }
  held.add(key)
  return {
    key,
    deny: `plain-english held this call: its prose has Claudisms. ${advice}\n\n${refusals.join('\n\n')}\n\nIf a finding is wrong, such as a word used literally or text that is not yours to change, make the same call again unchanged and it goes through.`,
  }
}

// A command's output, or undefined where it failed.
async function output($: EngineInterface, argv: string[], cwd: string) {
  const ran = await $.process.run(argv, { cwd, timeoutMs: 20_000 }).catch(() => undefined)
  return ran === undefined || ran.exitCode !== 0 ? undefined : ran.stdout
}

const parsed = (json: string | undefined): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(json ?? '')
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// The text a shell command published, read back as it now stands, with how to fix it. A commit is
// looked for in each directory the command may have made it in.
async function readBack($: EngineInterface, item: Published, dirs: readonly string[]) {
  if (item.kind === 'commit') {
    for (const dir of dirs) {
      const text = await output($, ['git', 'log', '-1', '--format=%B', item.sha], dir)
      if (text !== undefined)
        return { what: `the message of commit ${item.sha}`, text: text.trim(), fix: 'If it is the last commit, amend it with git commit --amend and a rewritten -m or -F; if not, leave it.' }
    }
    return undefined
  }
  if (item.kind === 'comment') {
    const path = `repos/${item.repo}/issues/comments/${item.id}`
    const json = parsed(await output($, ['gh', 'api', '--hostname', item.host, path], dirs[0]!))
    const text = asText(json.body)
    return text === '' ? undefined : { what: `the comment ${item.url}`, text, fix: `Rewrite it with gh api --hostname ${item.host} -X PATCH ${path} -F body=@FILE.` }
  }
  const json = parsed(await output($, ['gh', item.kind, 'view', item.url, '--json', 'title,body'], dirs[0]!))
  const text = [asText(json.title), asText(json.body)].filter(t => t !== '').join('\n\n')
  const what = item.kind === 'pr' ? 'pull request' : 'issue'
  return text === '' ? undefined : { what: `the ${what} ${item.url}`, text, fix: `Rewrite it with gh ${item.kind} edit ${item.url} --title and --body-file.` }
}

// A repository's HEAD and its message, or undefined outside one.
async function headOf($: EngineInterface, dir: string) {
  const out = await output($, ['git', 'log', '-1', '--format=%H%x00%B'], dir)
  if (out === undefined) return undefined
  const [sha, message] = out.split('\0')
  return { sha: sha!, message: (message ?? '').trim() }
}

// Commits by hash, time (seconds) and message: `git log` over a range, each record split on a byte
// no message holds. Only commits whose time is at or after `since` are kept. `clock` says which
// time: the author's, which a rebase, amend or cherry-pick keeps, tells a commit first written in
// the session; the committer's tells one written or rewritten by the command just run. A message
// git wrote from another commit's is not Claude's.
async function commitsIn($: EngineInterface, dir: string, range: readonly string[], since: number, clock: 'author' | 'committer' = 'author') {
  const format = clock === 'author' ? '--format=%H%x00%at%x00%B%x1e' : '--format=%H%x00%ct%x00%B%x1e'
  const out = await output($, ['git', 'log', format, '--max-count=50', ...range], dir)
  return (out ?? '')
    .split('\x1e')
    .map(r => r.trim())
    .filter(r => r !== '')
    .map(r => {
      const [sha, time, message] = r.split('\0')
      return { sha: sha!, time: Number(time), message: (message ?? '').trim() }
    })
    .filter(c => !(c.time < since) && !isGenerated(c.message))
}

// The messages of the commits before `sha`, so a rewrite that kept its message is known.
async function messagesBefore($: EngineInterface, dir: string, sha: string) {
  const out = await output($, ['git', 'log', '--format=%B%x1e', '--max-count=200', sha], dir)
  return new Set((out ?? '').split('\x1e').map(m => m.trim()))
}

// What a finished shell command published that has Claudisms, as notes for the model to act on. A
// commit is found by comparing the session's repository before and after a git commit, merge or
// rebase, keeping the commits the command wrote (by committer time) whose message is new (a rebase
// or an amend that kept its message is not), and by the line git prints for it, so a quiet commit
// and one made elsewhere are both read. A commit that keeps an existing message (`--no-edit`, `-C`,
// a fixup) is not Claude's text to answer for.
async function afterShell($: EngineInterface, command: string, text: string, cwd: string, since: number, before?: { sha: string; message: string }) {
  const items = published(command, text)
  if (before !== undefined && !reusesMessage(command)) {
    const after = await headOf($, cwd)
    if (after !== undefined && after.sha !== before.sha) {
      const seen = await messagesBefore($, cwd, before.sha)
      for (const c of (await commitsIn($, cwd, [`${before.sha}..${after.sha}`], since, 'committer')).reverse())
        if (!seen.has(c.message) && !items.some(i => i.kind === 'commit' && c.sha.startsWith(i.sha))) items.push({ kind: 'commit', sha: c.sha.slice(0, 7) })
    }
  }
  if (items.length === 0) return []
  const dirs = directories(command, cwd, await $.env.get('HOME'))
  const notes: string[] = []
  for (const item of items) {
    const back = await readBack($, item, dirs)
    if (back === undefined) continue
    if (item.kind === 'commit' && ((before !== undefined && back.text === before.message) || isGenerated(back.text))) continue
    const problem = await problems($, back.text)
    if (problem.length > 0)
      notes.push(`plain-english: ${back.what} has Claudisms. ${back.fix} Fix these, unless a finding is wrong (such as a word used literally):\n${list(problem)}`)
  }
  return notes
}

const REWORD =
  'Reword those commits in plain English before you push: amend the last with git commit --amend, and reword an older one with git rebase -i using GIT_SEQUENCE_EDITOR and GIT_EDITOR set to commands that make the change, since no editor can be opened. Then push again.'

// The root of the git repository a file is in, or undefined outside one. The file's folder may not
// exist yet, so git is asked from the nearest folder above it that does.
async function repoRoot($: EngineInterface, path: string) {
  let dir = path.slice(0, path.lastIndexOf('/')) || '/'
  for (let i = 0; i < 12; i++) {
    const ran = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 10_000 }).catch(() => undefined)
    if (ran !== undefined) return ran.exitCode === 0 ? ran.stdout.trim() || undefined : undefined
    if (dir === '/') return undefined
    dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
  }
  return undefined
}

// Each session's start, under a key of its own, kept across restarts so a resumed session keeps
// its own; two sessions writing at once never drop each other's.
const START = 'start:'
const MONTH = 30 * 24 * 60 * 60
// How far back a session the mod meets part-way through is taken to have started.
const UNKNOWN_START = 12 * 60 * 60

// When the session started, in seconds, as git counts commit times. At the session's start it is
// now; a session with no start stored (the mod enabled part-way through) is taken to have started
// twelve hours ago, so its earlier commits are still checked.
async function sessionStart($: EngineInterface, starting = false) {
  const key = `${START}${await $.session.id()}`
  const known: unknown = await $.store.get(key)
  if (typeof known === 'number') return known
  const now = Math.floor(Date.now() / 1000)
  const start = starting ? now : now - UNKNOWN_START
  await $.store.set(key, start)
  return start
}

// Starts older than a month are dropped.
async function pruneStarts($: EngineInterface) {
  const old = Math.floor(Date.now() / 1000) - MONTH
  for (const key of await $.store.keys()) {
    if (!key.startsWith(START)) continue
    const t: unknown = await $.store.get(key)
    if (typeof t !== 'number' || t < old) await $.store.delete(key)
  }
}

// The check of a push: every commit it would send that no remote has yet and that was first
// written in this session, each message checked. `refs` is what the push sends. A commit from
// before the session is not Claude's to reword, and a first push to a new remote is not charged
// with the whole history.
async function checkPush($: EngineInterface, memory: Memory, dir: string, refs: readonly string[]) {
  const commits = refs.length === 0 ? [] : await commitsIn($, dir, [...refs, '--not', '--remotes'], await sessionStart($))
  const found = commits.reverse().map(c => ({ what: `the message of commit ${c.sha.slice(0, 7)}`, text: c.message }))
  return gate($, memory, `push\u0000${dir}`, found, REWORD)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register(SCAN_TOOL)
    // The first start only: a reload or a resumed session keeps the time the session began. A store
    // that fails leaves the start to be set when a push first asks.
    await sessionStart($, true).catch(() => undefined)
    await pruneStarts($).catch(() => undefined)
    return next(e)
  }).catch((_, e, next) => next(e))

  // Every agent the session starts writes under the style too. The style is forced while the mod is
  // on, so no setting is checked. A hook that fails leaves the spawn as it was, so a fault here
  // never stops the work.
  on('agent.spawn', async ($, e, next) => {
    // A resumed run keeps its prompt, and one that holds the rules already is left as it is.
    if (e.resume !== undefined || hasRules(e.prompt)) return next(e)
    const file = await $.fs.read(`${$.plugin.root}/${STYLE_FILE}`)
    const style = typeof file === 'string' ? parseStyle(file) : undefined
    if (style === undefined) return next(e)
    return next({ ...e, prompt: withRules(e.prompt, style.body, e.fork) })
  }).catch((_, e, next) => next(e))

  // Whether the main thread ran a scan this turn: its answer is then a scan's report, not prose to
  // check, so a second scan reads the reply the first one read.
  let scannedThisTurn = false

  // The main thread's last answer, so a scan with nothing given reads the reply before it.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const isReport = scannedThisTurn
      scannedThisTurn = false
      if (!isReport && e.reason === 'answer' && e.answer.trim() !== '') await $.state.set(LAST_REPLY, e.answer)
    }
    return next(e)
  })

  const memory: Memory = { held: new Set(), cleared: new Set() }

  // A prose file, or a pull request or issue opened through a tool, is checked before it is
  // written, and a call that would publish Claudisms is refused with the list to fix. A shell
  // command is checked once it has run: what it published (a commit's message, a pull request,
  // issue or comment) is read back, and Claude is told to fix any Claudisms in it, even where a
  // later step of the command failed. A push is checked before it runs: no commit with Claudisms
  // leaves the machine, however it was made. A check that fails lets the call through.
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Bash') {
      const command = asText(e.command)
      const cwd = await $.session.cwd()
      const home = await $.env.get('HOME')
      const checks = []
      for (const p of pushes(command, cwd, home)) if (p.refs.length > 0) checks.push(await checkPush($, memory, p.dir, p.refs))
      const refused = checks.find(c => c.deny !== undefined)
      if (refused !== undefined) return { deny: refused.deny! }
      // A second's slack: git counts commit times in whole seconds.
      const started = Math.floor(Date.now() / 1000) - 1
      const before = commits(command) ? await headOf($, cwd) : undefined
      const result = await next(e)
      if (result.deny !== undefined) return result
      for (const c of checks) if (c.passed === true) memory.held.delete(c.key)
      const notes = await afterShell($, command, result.text ?? '', cwd, started, before)
      return notes.length === 0 ? result : { ...result, context: [...(result.context ?? []), ...notes] }
    }
    const cwd = await $.session.cwd()
    const found = pieces(e.tool, e as unknown as Record<string, unknown>, cwd, await $.env.get('HOME'))
    if (found.length === 0) return next(e)
    // A doc in its project's test folders may hold Claudisms on purpose.
    if (e.tool === 'Write' || e.tool === 'Edit') {
      const path = found[0]!.what
      if (isTestPath(path, await repoRoot($, path))) return next(e)
    }
    const checked = await gate($, memory, e.tool, found)
    if (checked.deny !== undefined) return { deny: checked.deny }
    const result = await next(e)
    if (checked.passed === true && result.deny === undefined) memory.held.delete(checked.key)
    return result
  }).catch((_, e, next) => next(e))

  // review-gate opens a pull request by pushing and then running gh itself, from its own tool's
  // hook, which may sit outside this mod's: the commits the push sends, and the title and body gh
  // is given, are checked here too, as each is run.
  on('process.run', async ($, e, next) => {
    const program = e.argv[0] ?? ''
    const isGit = program === 'git' || program.endsWith('/git')
    if (!isGit && program !== 'gh' && !program.endsWith('/gh')) return next(e)
    if (isGit && !e.argv.includes('push')) return next(e)
    const cwd = await $.session.cwd()
    const dir = e.init?.cwd === undefined ? cwd : resolvePath(cwd, e.init.cwd)
    if (isGit) {
      const refs = pushedRefs(e.argv)
      if (refs.length === 0) return next(e)
      const push = await checkPush($, memory, dir, refs)
      if (push.deny !== undefined) return { deny: push.deny }
      const result = await next(e)
      if (push.passed === true) memory.held.delete(push.key)
      return result
    }
    const found = gh(['gh', ...e.argv.slice(1)], dir, e.init?.stdin)
    if (found.length === 0) return next(e)
    const checked = await gate($, memory, 'gh', found)
    if (checked.deny !== undefined) return { deny: checked.deny }
    const result = await next(e)
    if (checked.passed === true) memory.held.delete(checked.key)
    return result
  }).catch((_, e, next) => next(e))

  // A subagent's report is checked as it finishes, and sent back once to be rewritten. Text in
  // quotation marks is left alone: a review quotes what it found.
  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    const text = e.last_assistant_message ?? ''
    if (e.stop_hook_active || result.block !== undefined || text.trim() === '' || /^\s*[[{]/.test(text)) return result
    const problem = await problems($, text, { skipQuotes: true })
    if (problem.length === 0) return result
    return {
      ...result,
      block: `Your report has Claudisms. Send it again as your final message, rewritten in plain English, with these fixed:\n\n${list(problem)}`,
    }
  }).catch((_, e, next) => next(e))

  on('tool.call', { tool: SCAN }, async ($, e) => {
    const answer = await scanFor($, e)
    // Only a report counts: a refused scan leaves the turn's answer to be stored.
    if (e.agentId === undefined && 'result' in answer) scannedThisTurn = true
    return answer
  }).catch(() => ({ deny: 'plain-english: the scan failed.' }))
}
