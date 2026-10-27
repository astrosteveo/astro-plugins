import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

const ROOT = '/home/u/proj'
const SESSION = 'abcd1234-0000-0000-0000-000000000000'
const NAME = 'fix-the-login-bug-abcd'
const PATH = `${ROOT}/.claude/worktrees/${NAME}`
const KEY = `wt:${PATH}`
const DAY = 24 * 60 * 60 * 1000

// A repository in memory, and what the mod did to it.
type World = {
  isRepo: boolean
  // Where the session stands; a move into a worktree changes it.
  cwd: string
  isLinked: boolean
  hasOrigin: boolean
  localBehindOrigin: boolean
  // Worktrees git lists besides the main one, by path.
  trees: Map<string, { dirty: boolean; unmerged: boolean; head?: string }>
  branches: Set<string>
  addFails: boolean
  enterFails: boolean
  exitFails: boolean
  exited: number
  added: { branch: string; path: string; base: string }[]
  removed: { path: string; force: boolean }[]
  deleted: string[]
  toasts: string[]
  files: Map<string, string>
  entered: string[]
  kv: Map<string, unknown>
  // What the model reads beside the last prompt.
  context: readonly string[]
  sessionId: string
}

const world = (over: Partial<World> = {}): World => ({
  isRepo: true,
  cwd: ROOT,
  isLinked: false,
  hasOrigin: true,
  localBehindOrigin: false,
  trees: new Map(),
  branches: new Set(['main']),
  addFails: false,
  enterFails: false,
  exitFails: false,
  exited: 0,
  added: [],
  removed: [],
  deleted: [],
  toasts: [],
  files: new Map(),
  entered: [],
  kv: new Map(),
  context: [],
  sessionId: SESSION,
  ...over,
})

const done = (stdout = '', exitCode = 0, stderr = '') => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

// Answers the few git commands the mod runs, from `w`.
function git(w: World, argv: readonly string[], cwd: string) {
  const [, a, b, c] = argv
  const treeAt = (dir: string) => w.trees.get(dir)
  if (a === 'rev-parse' && b === '--path-format=absolute') {
    if (!w.isRepo) return done('', 128, 'fatal: not a git repository')
    return w.isLinked
      ? done(`${cwd}\n${ROOT}/.git/worktrees/x\n${ROOT}/.git\n`)
      : done(`${ROOT}\n${ROOT}/.git\n${ROOT}/.git\n`)
  }
  if (a === 'rev-parse' && b !== '--verify') return done(`${b === 'HEAD' ? (treeAt(cwd)?.head ?? 'base0') : 'base0'}\n`)
  if (a === 'symbolic-ref') return w.hasOrigin ? done('origin/main\n') : done('', 128)
  if (a === 'rev-parse' && b === '--verify') {
    const ref = String(argv[4]).replace('^{commit}', '').replace(/^refs\/(heads|remotes)\//, '')
    return w.branches.has(ref) || (ref === 'origin/main' && w.hasOrigin) ? done('abc\n') : done('', 1)
  }
  if (a === 'merge-base') {
    const [tip, home] = [String(argv[3]), String(argv[4])]
    if (tip === 'main' && home === 'origin/main') return done('', w.localBehindOrigin ? 0 : 1)
    const tree = tip === 'HEAD' ? treeAt(cwd) : [...w.trees].find(([p]) => p.endsWith(tip.replace('wt/', '')))?.[1]
    return done('', tree?.unmerged ? 1 : 0)
  }
  if (a === 'worktree' && b === 'add') {
    if (w.addFails) return done('', 128, 'fatal: boom\nmore')
    const [branch, path, base] = [String(argv[4]), String(argv[5]), String(argv[6])]
    w.added.push({ branch, path, base })
    w.branches.add(branch)
    w.trees.set(path, { dirty: false, unmerged: false })
    return done()
  }
  if (a === 'worktree' && b === 'list') {
    return done([`worktree ${ROOT}`, '', ...[...w.trees.keys()].flatMap(p => [`worktree ${p}`, ''])].join('\n'))
  }
  if (a === 'status') return done(treeAt(cwd)?.dirty ? ' M a.txt\n' : '')
  if (a === 'worktree' && b === 'remove') {
    const force = c === '--force'
    const path = String(argv[force ? 4 : 3])
    if (treeAt(path)?.dirty && !force) return done('', 1, 'contains modified or untracked files')
    w.trees.delete(path)
    w.removed.push({ path, force })
    return done()
  }
  if (a === 'worktree' && b === 'prune') return done()
  if (a === 'branch' && b === '-D') {
    w.deleted.push(String(c))
    w.branches.delete(String(c))
    return done()
  }
  return done('', 1, `unexpected: ${argv.join(' ')}`)
}

// Nothing sits beneath the plugin: these hooks stand for the engine and for git.
function engine(on: On, w: World, store: Record<string, unknown> = {}) {
  for (const [key, value] of Object.entries(store)) w.kv.set(key, value)
  on('store.get', (_, e) => ({ value: w.kv.get(e.key) }))
  on('store.set', (_, e) => {
    w.kv.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    w.kv.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.kv.keys()] }))
  const clock = mock.clock(on, { now: 100 * DAY })
  on('process.run', (_, e) => ({ value: git(w, e.argv, e.init?.cwd ?? w.cwd) }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('session.id', () => ({ value: w.sessionId }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('command.register', () => ({ value: { command: 'worktrees' } }))
  on('prompt.submit', (_, e) => {
    w.context = e.context ?? []
    return { text: e.text }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: w.files.has(String(e.path)) }))
  on('fs.read', (_, e) => ({ value: w.files.get(String(e.path)) ?? '' }))
  on('fs.write', (_, e) => {
    w.files.set(String(e.path), String(e.text))
    return { value: undefined }
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'ExitWorktree') {
      if (w.exitFails) return { deny: 'refused' }
      w.cwd = ROOT
      w.isLinked = false
      w.exited++
      return { result: {} }
    }
    if (e.tool !== 'EnterWorktree') return { result: {} }
    if (w.enterFails) return { deny: 'refused' }
    w.cwd = String(e.path)
    w.isLinked = true
    w.entered.push(w.cwd)
    return { result: {} }
  })
  return clock
}

const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const
const END = { reason: 'prompt_input_exit', sessionId: SESSION, resume: { id: SESSION } } as const
// The engine takes the session back out of the worktree before session.end fires.
function finish($: Engine, w: World) {
  w.cwd = ROOT
  w.isLinked = false
  return $.session.end({ ...END, sessionId: w.sessionId })
}

const PROMPT = { text: 'Fix the login bug', wait: false, origin: { kind: 'composer' } } as const
const run = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

test('with the toggle off, a prompt stays in the main checkout', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  await $.prompt.submit(PROMPT)
  expect(w.added).toEqual([])
  expect([...w.kv.keys()]).toEqual([])
})

test('with it on, the first prompt moves the session into a worktree cut from main', async ($, on) => {
  const w = world()
  engine(on, w, { enabled: true })
  await $.session.start(START)
  await $.prompt.submit(PROMPT)

  expect(w.added).toEqual([{ branch: `wt/${NAME}`, path: PATH, base: 'main' }])
  expect(w.entered).toEqual([PATH])
  // The record exists before anything can end the session.
  const entry = (w.kv.get(KEY)) as Record<string, unknown>
  expect(entry).toMatchObject({ sessionId: SESSION, repo: ROOT, path: PATH, branch: `wt/${NAME}`, base: 'main' })
  expect(entry.endedAt).toBeUndefined()
  // The folder stays out of `git status` in the main checkout.
  expect(w.files.get(`${ROOT}/.git/info/exclude`)).toBe('/.claude/worktrees/\n')
  expect(w.toasts.some(t => t.includes(`wt/${NAME}`))).toBe(true)
  // The model is told where it is now: its first look at the directory came before the move.
  expect(w.context.join('\n')).toContain(PATH)

  // A second prompt finds the session already in a worktree.
  await $.prompt.submit({ ...PROMPT, text: 'and another thing' })
  expect(w.added.length).toBe(1)
})

test('a local main behind origin is not the base', async ($, on) => {
  const w = world({ localBehindOrigin: true })
  engine(on, w, { enabled: true })
  await $.session.start(START)
  await $.prompt.submit(PROMPT)
  expect(w.added[0]?.base).toBe('origin/main')
})

const STAYS = [
  ['already in a worktree', world({ isLinked: true, cwd: PATH }), { ...START, cwd: PATH }],
  ['outside a repository', world({ isRepo: false }), START],
  ['headless', world(), { ...START, isInteractive: false }],
] as const

for (const [why, w, start] of STAYS) {
  test(`a session ${why} is left where it is`, async ($, on) => {
    engine(on, w, { enabled: true })
    await $.session.start(start)
    await $.prompt.submit(PROMPT)
    expect(w.added).toEqual([])
  })
}

test('when git cannot make the worktree the prompt still runs, in the main checkout', async ($, on) => {
  const w = world({ addFails: true })
  engine(on, w, { enabled: true })
  await $.session.start(START)
  const sent = await $.prompt.submit(PROMPT)
  expect(sent).toMatchObject({ text: PROMPT.text })
  expect(w.cwd).toBe(ROOT)
  expect(w.context).toEqual([])
  expect(w.toasts.some(t => t.includes('fatal: boom'))).toBe(true)
  expect([...w.kv.keys()]).toEqual(['enabled'])
})

test('when the move is refused the new worktree is taken away again', async ($, on) => {
  const w = world({ enterFails: true })
  engine(on, w, { enabled: true })
  await $.session.start(START)
  await $.prompt.submit(PROMPT)
  expect(w.removed).toEqual([{ path: PATH, force: false }])
  expect(w.deleted).toEqual([`wt/${NAME}`])
  expect([...w.kv.keys()]).toEqual(['enabled'])
})

test('ending a session with nothing in its worktree removes it and its branch', async ($, on) => {
  const w = world()
  engine(on, w, { enabled: true })
  await $.session.start(START)
  await $.prompt.submit(PROMPT)
  await finish($, w)
  expect(w.removed).toEqual([{ path: PATH, force: false }])
  expect(w.deleted).toEqual([`wt/${NAME}`])
  expect([...w.kv.keys()]).toEqual(['enabled'])
})

const WORK = [
  [{ dirty: true, unmerged: false }, 'uncommitted changes'],
  [{ dirty: false, unmerged: true }, 'commits not in main'],
] as const

for (const [state, reason] of WORK) {
  test(`ending a session with ${reason} in its worktree leaves it, marked ended`, async ($, on) => {
    const w = world()
    const clock = engine(on, w, { enabled: true })
    await $.session.start(START)
    await $.prompt.submit(PROMPT)
    w.trees.set(PATH, state)
    await clock.advance(1000)
    await finish($, w)
    expect(w.removed).toEqual([])
    expect(w.deleted).toEqual([])
    const entry = (w.kv.get(KEY)) as { endedAt?: number; keptBecause?: string }
    expect(entry.endedAt).toBeGreaterThan(100 * DAY)
    expect(entry.keptBecause).toContain(reason)
  })
}

test('a /clear or a resume ends nothing: the process goes on in the worktree', async ($, on) => {
  const w = world()
  engine(on, w, { enabled: true })
  await $.session.start(START)
  await $.prompt.submit(PROMPT)
  await $.session.end({ ...END, reason: 'clear' })
  await $.session.end({ ...END, reason: 'resume' })
  expect(w.removed).toEqual([])
  expect((w.kv.get(KEY)) as { endedAt?: number }).toMatchObject({ path: PATH })
  expect(((w.kv.get(KEY)) as { endedAt?: number }).endedAt).toBeUndefined()
})

const ENTRY = {
  sessionId: 'old',
  repo: ROOT,
  path: `${ROOT}/.claude/worktrees/old-1111`,
  branch: 'wt/old-1111',
  base: 'main',
  createdAt: 99 * DAY,
}

test('the next start finishes what an ended session could not', async ($, on) => {
  const w = world()
  w.trees.set(ENTRY.path, { dirty: false, unmerged: false })
  w.branches.add(ENTRY.branch)
  engine(on, w, { [`wt:${ENTRY.path}`]: { ...ENTRY, endedAt: 99 * DAY + 5 } })
  await $.session.start(START)
  expect(w.removed).toEqual([{ path: ENTRY.path, force: false }])
  expect(w.deleted).toEqual([ENTRY.branch])
  expect([...w.kv.keys()]).toEqual([])
})

test('a start never touches a worktree whose session is still running', async ($, on) => {
  const w = world()
  w.trees.set(ENTRY.path, { dirty: false, unmerged: false })
  engine(on, w, { [`wt:${ENTRY.path}`]: ENTRY })
  await $.session.start(START)
  expect(w.removed).toEqual([])
  expect([...w.kv.keys()]).toEqual([`wt:${ENTRY.path}`])
})

test('a worktree whose session never marked its end is taken for dead after a week', async ($, on) => {
  const w = world()
  w.trees.set(ENTRY.path, { dirty: false, unmerged: false })
  engine(on, w, { [`wt:${ENTRY.path}`]: { ...ENTRY, createdAt: 100 * DAY - 8 * DAY } })
  await $.session.start(START)
  expect(w.removed.length).toBe(1)
})

test('a start tells the person about work left behind, once per repository', async ($, on) => {
  const w = world()
  w.trees.set(ENTRY.path, { dirty: true, unmerged: false })
  engine(on, w, { [`wt:${ENTRY.path}`]: { ...ENTRY, endedAt: 99 * DAY + 5 } })
  await $.session.start(START)
  expect(w.removed).toEqual([])
  expect(w.toasts.some(t => t.includes('old-1111') && t.includes('uncommitted changes'))).toBe(true)
})

test('a session resumed inside its old worktree takes it over again', async ($, on) => {
  const w = world({ isLinked: true, cwd: ENTRY.path })
  w.trees.set(ENTRY.path, { dirty: true, unmerged: false })
  engine(on, w, { [`wt:${ENTRY.path}`]: { ...ENTRY, endedAt: 99 * DAY + 5, keptBecause: 'uncommitted changes' } })
  await $.session.start({ ...START, cwd: ENTRY.path })
  const entry = (w.kv.get(`wt:${ENTRY.path}`)) as { sessionId: string; endedAt?: number; keptBecause?: string }
  expect(entry.sessionId).toBe(SESSION)
  expect(entry.endedAt).toBeUndefined()
  expect(entry.keptBecause).toBeUndefined()
})

test('/worktrees toggles, and says what happens next', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  const on1 = await $.command.run(run('worktrees', ''))
  expect(on1.text).toContain('Worktrees on')
  expect(w.kv.get('enabled')).toBe(true)
  await $.prompt.submit(PROMPT)
  expect(w.added.length).toBe(1)
  const off = await $.command.run(run('worktrees', ''))
  expect(off.text).toContain('Worktrees off')
  expect(off.text).toContain(NAME)
  expect(w.kv.get('enabled')).toBe(false)
})

test('/worktrees clean removes what is safe and names what it left', async ($, on) => {
  const w = world()
  const gone = { ...ENTRY, path: `${ROOT}/.claude/worktrees/gone-2222`, branch: 'wt/gone-2222', endedAt: 99 * DAY }
  const kept = { ...ENTRY, endedAt: 99 * DAY }
  w.trees.set(gone.path, { dirty: false, unmerged: false })
  w.trees.set(kept.path, { dirty: false, unmerged: true })
  engine(on, w, { [`wt:${gone.path}`]: gone, [`wt:${kept.path}`]: kept })
  const out = await $.command.run(run('worktrees', 'clean'))
  expect(out.text).toContain('Removed 1: gone-2222')
  expect(out.text).toContain('old-1111')
  expect(w.removed.map(r => r.path)).toEqual([gone.path])
})

test('/worktrees discard forces one named worktree away and never a running one', async ($, on) => {
  const w = world()
  const ended = { ...ENTRY, endedAt: 99 * DAY }
  const running = { ...ENTRY, path: `${ROOT}/.claude/worktrees/live-3333`, branch: 'wt/live-3333' }
  w.trees.set(ended.path, { dirty: true, unmerged: true })
  w.trees.set(running.path, { dirty: true, unmerged: true })
  engine(on, w, { [`wt:${ended.path}`]: ended, [`wt:${running.path}`]: running })

  expect((await $.command.run(run('worktrees', 'discard live'))).text).toContain('No ended worktree matches')
  expect((await $.command.run(run('worktrees', 'discard'))).text).toContain('No ended worktree matches')
  const out = await $.command.run(run('worktrees', 'discard old-1111'))
  expect(out.text).toContain('Discarded old-1111')
  expect(w.removed).toEqual([{ path: ended.path, force: true }])
  expect(w.deleted).toEqual([ended.branch])
  expect(w.kv.get(`wt:${ended.path}`)).toBeUndefined()
})

test('a /clear gives the session a new id, and the worktree still goes when it ends', async ($, on) => {
  const w = world()
  engine(on, w, { enabled: true })
  await $.session.start(START)
  await $.prompt.submit(PROMPT)
  await $.session.end({ ...END, reason: 'clear' })
  w.sessionId = 'ffff0000-0000-0000-0000-000000000000'
  await $.prompt.submit({ ...PROMPT, text: 'next task' })
  expect((w.kv.get(KEY) as { sessionId: string }).sessionId).toBe(w.sessionId)
  // It is the same worktree: nothing new was cut.
  expect(w.added.length).toBe(1)
  await finish($, w)
  expect(w.removed).toEqual([{ path: PATH, force: false }])
})

const TURN = { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' } as const
const MERGED = { dirty: false, unmerged: false, head: 'work1' }

test('once the work is merged and the tree is clean, the session steps back out to main', async ($, on) => {
  const w = world()
  engine(on, w, { enabled: true })
  await $.session.start(START)
  await $.prompt.submit(PROMPT)
  w.trees.set(PATH, MERGED)
  await $.turn.complete(TURN)

  expect(w.exited).toBe(1)
  expect(w.cwd).toBe(ROOT)
  expect(w.removed).toEqual([{ path: PATH, force: false }])
  expect(w.deleted).toEqual([`wt/${NAME}`])
  expect([...w.kv.keys()]).toEqual(['enabled'])
  expect(w.toasts.some(t => t.includes('back on the main checkout'))).toBe(true)

  // The next task gets a worktree of its own, and the model is told what happened to the last one.
  await $.prompt.submit({ ...PROMPT, text: 'next task' })
  expect(w.added.length).toBe(2)
  expect(w.context.join('\n')).toContain('its branch is merged')
  expect(w.context.join('\n')).toContain('next-task-abcd')
})

test('with the toggle turned off meanwhile, the next prompt stays on main and the model is still told', async ($, on) => {
  const w = world()
  engine(on, w, { enabled: true })
  await $.session.start(START)
  await $.prompt.submit(PROMPT)
  w.trees.set(PATH, MERGED)
  await $.turn.complete(TURN)
  w.kv.set('enabled', false)
  await $.prompt.submit({ ...PROMPT, text: 'next task' })
  expect(w.added.length).toBe(1)
  expect(w.context.join('\n')).toContain('its branch is merged')
})

const STAYS_PUT = [
  ['the session has committed nothing yet', { dirty: false, unmerged: false }, TURN],
  ['the commits are not in main', { dirty: false, unmerged: true, head: 'work1' }, TURN],
  ['the tree still has changes', { dirty: true, unmerged: false, head: 'work1' }, TURN],
  ['the turn was a subagent\'s', MERGED, { ...TURN, agentId: 'a1' }],
] as const

for (const [why, state, turn] of STAYS_PUT) {
  test(`the session stays in its worktree while ${why}`, async ($, on) => {
    const w = world()
    engine(on, w, { enabled: true })
    await $.session.start(START)
    await $.prompt.submit(PROMPT)
    w.trees.set(PATH, state)
    await $.turn.complete(turn)
    expect(w.exited).toBe(0)
    expect(w.removed).toEqual([])
    expect(w.cwd).toBe(PATH)
  })
}

test('when the engine will not step out, the worktree is left alone', async ($, on) => {
  const w = world({ exitFails: true })
  engine(on, w, { enabled: true })
  await $.session.start(START)
  await $.prompt.submit(PROMPT)
  w.trees.set(PATH, MERGED)
  await $.turn.complete(TURN)
  expect(w.removed).toEqual([])
  expect(w.cwd).toBe(PATH)
})
