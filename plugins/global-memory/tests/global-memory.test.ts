import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { briefWrite, saveQuestion } from '../hooks/memory'

const DIR = '/home/u/.claude/memory'
const INDEX = `${DIR}/MEMORY.md`

type Disk = {
  rmExit?: number
  indexUnreadable?: boolean
  verdict?: 'allow' | 'ask' | 'deny'
  // Another session holds the lock, and lets go of it after this many waits.
  lockBusy?: number
  // Another session holds a lock that is a minute old, and is gone.
  lockStale?: boolean
  // Another session breaks the stale lock and makes it anew while this one waits for the breaker.
  lockRenewed?: boolean
  // Another session takes the lock from this one while it changes the files.
  lockStolen?: boolean
  // The exit status of the `mkdir -p` that makes the folder.
  mkdirExit?: number
  // Whether the move of a temp file over the index fails.
  indexMoveFails?: boolean
}

// An in-memory disk under the plugin; the engine's memory section reads "core memory".
function engine(on: On, disk: Disk = {}) {
  const files = new Map<string, string>()
  const log: string[] = []
  const NOW = 1_000_000
  const LOCK = `${DIR}/.lock`
  // The lock directory, if there is one: when it was made, and whether this session made it.
  let lock: { mtime: number; ours: boolean } | undefined = disk.lockStale
    ? { mtime: NOW - 60_000, ours: false }
    : disk.lockBusy
      ? { mtime: NOW, ours: false }
      : undefined
  let waits = disk.lockBusy ?? 0
  let breaker = false
  // Where each temp file was moved to.
  const moves: string[] = []
  on('tool.check', () => ({ decision: disk.verdict ?? 'allow' }))
  on('env.get', () => ({ value: '/home/u' }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__global-memory__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.section', (_, e) => ({ text: e.text }))
  on('fs.read', async (_, e) => {
    await Promise.resolve()
    const path = String(e.path)
    if (disk.indexUnreadable && path === INDEX) throw new Error('EACCES: permission denied')
    const text = files.get(path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.exists', async (_, e) => {
    await Promise.resolve()
    return { value: files.has(String(e.path)) }
  })
  on('fs.write', async (_, e) => {
    await Promise.resolve()
    files.set(String(e.path), String(e.text))
    // Another session breaks this one's lock and makes its own, which holds no token of ours.
    if (disk.lockStolen && String(e.path) === `${INDEX}.tmp`) {
      for (const path of [...files.keys()]) if (path.startsWith(`${LOCK}/`)) files.delete(path)
      lock = { mtime: NOW, ours: false }
      files.set(`${LOCK}/owner`, 'another-session')
      waits = Infinity
    }
    return { value: undefined }
  })
  const ran = (exitCode: number, stdout = '', stderr = '') => ({
    value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('fs.stat', (_, e) => {
    const path = String(e.path)
    const mtimeMs = path === LOCK && lock ? lock.mtime : path === `${LOCK}.break` && breaker ? NOW : undefined
    if (mtimeMs === undefined) throw new Error('ENOENT')
    return { value: { kind: 'dir' as const, size: 0, mtimeMs, isLink: false } }
  })
  on('clock.now', () => ({ value: NOW }))
  on('process.run', (_, e) => {
    const [cmd] = e.argv
    const target = String(e.argv.at(-1))
    if (cmd === 'mkdir' && target === LOCK) {
      if (lock) return ran(1, '', 'File exists')
      lock = { mtime: NOW, ours: true }
      log.push('lock')
      return ran(0)
    }
    if (cmd === 'mkdir' && target === `${LOCK}.break`) {
      if (breaker) return ran(1, '', 'File exists')
      breaker = true
      // The lock is fresh by the time the breaker looks again.
      if (disk.lockRenewed && lock) {
        lock.mtime = NOW
        waits = 2
      }
      return ran(0)
    }
    if (cmd === 'rmdir' && target === `${LOCK}.break`) {
      breaker = false
      return ran(0)
    }
    if (cmd === 'rm' && e.argv[1] === '-rf') {
      if (lock) log.push(lock.ours ? 'unlock' : 'broken')
      lock = undefined
      for (const path of [...files.keys()]) if (path.startsWith(`${LOCK}/`)) files.delete(path)
      return ran(0)
    }
    if (cmd === 'mkdir') return disk.mkdirExit ? ran(disk.mkdirExit, '', 'mkdir: cannot create directory') : ran(0)
    if (cmd === 'mv') {
      const from = String(e.argv[3])
      const to = String(e.argv[4])
      if (disk.indexMoveFails && to === INDEX) return ran(1, '', 'mv: cannot move: Permission denied')
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      moves.push(to)
      return ran(0)
    }
    const exitCode = disk.rmExit ?? 0
    if (exitCode === 0) files.delete(String(e.argv[2]))
    return ran(exitCode, '', exitCode === 0 ? '' : 'rm: cannot remove: Permission denied')
  })
  on('clock.sleep', () => {
    if (lock && !lock.ours && --waits <= 0) lock = undefined
    return { value: undefined }
  })
  return Object.assign(files, { log, moves })
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

const write = ($: any, name: string, extra: object = {}) =>
  $.tool.call({
    tool: 'mcp__global-memory__global_memory_write',
    name,
    description: 'The user wants answers short',
    type: 'feedback',
    body: 'Keep answers short.\n\n**Why:** they said so.',
    ...extra,
  })

const read = ($: any, name: string) => $.tool.call({ tool: 'mcp__global-memory__global_memory_read', name })
const remove = ($: any, name: string) => $.tool.call({ tool: 'mcp__global-memory__global_memory_delete', name })

test('a saved memory is a file, a line in the index, and joins the memory section', async ($, on) => {
  const files = engine(on)
  await start($)

  const saved = await write($, 'short-answers', { title: 'Short answers' })
  expect(saved.result).toBe('Saved global memory short-answers.')
  expect(files.get(`${DIR}/short-answers.md`)).toContain(
    'name: short-answers\ndescription: "The user wants answers short"\nmetadata:\n  type: feedback',
  )
  expect(files.get(INDEX)).toBe('- [Short answers](short-answers.md) — The user wants answers short\n')

  const section = await $.prompt.section({ name: 'memory', text: 'core memory' })
  expect(section.text).toContain('core memory')
  expect(section.text).toContain('- [Short answers](short-answers.md) — The user wants answers short')
  expect(section.text).toContain(DIR)
})

test('writing a name again replaces it in place; delete removes file and line', async ($, on) => {
  const files = engine(on)
  await start($)
  await write($, 'a')
  await write($, 'b')
  const again = await write($, 'a', { description: 'changed' })
  expect(again.result).toBe('Replaced global memory a.')
  expect(files.get(INDEX)).toBe('- [a](a.md) — changed\n- [b](b.md) — The user wants answers short\n')

  const gone = await remove($, 'a')
  expect(gone.result).toBe('Deleted global memory a.')
  expect(files.get(INDEX)).toBe('- [b](b.md) — The user wants answers short\n')
  expect(files.has(`${DIR}/a.md`)).toBe(false)
})

test('read returns the file; a bad or unknown name is refused', async ($, on) => {
  engine(on)
  await start($)
  await write($, 'a')
  const text = await read($, 'a')
  expect(text.result).toContain('Keep answers short.')
  expect((await read($, 'zzz')).deny).toContain('No global memory')
  expect((await read($, '../x')).deny).toContain('No global memory')
  expect((await write($, '../escape')).deny).toContain('is not a name')
  expect((await write($, 'ok', { type: 'project' })).deny).toContain('type must be')
})

test('with the engine memory off, the section stays off', async ($, on) => {
  engine(on)
  await start($)
  expect((await $.prompt.section({ name: 'memory', text: null })).text).toBeNull()
})

test('a description that links another memory does not stand for it', async ($, on) => {
  const files = engine(on)
  await start($)
  await write($, 'new', { description: 'supersedes [old](old.md)' })
  await write($, 'old')
  expect(files.get(INDEX)).toBe(
    '- [new](new.md) — supersedes [old](old.md)\n- [old](old.md) — The user wants answers short\n',
  )
  await remove($, 'old')
  expect(files.get(INDEX)).toBe('- [new](new.md) — supersedes [old](old.md)\n')
})

test('an index that cannot be read is left alone, not written over', async ($, on) => {
  const files = engine(on, { indexUnreadable: true })
  await start($)
  files.set(INDEX, '- [a](a.md) — x\n- [b](b.md) — y\n')
  files.set(`${DIR}/a.md`, 'a')

  const saved = await write($, 'c')
  expect(saved.deny).toContain('was not changed')
  expect(files.has(`${DIR}/c.md`)).toBe(false)
  expect((await remove($, 'a')).deny).toContain('was not changed')
  expect(files.get(INDEX)).toBe('- [a](a.md) — x\n- [b](b.md) — y\n')
  expect(files.has(`${DIR}/a.md`)).toBe(true)

  const section = await $.prompt.section({ name: 'memory', text: 'core memory' })
  expect(section.text).toBe('core memory')
})

test('a delete whose rm fails says so and keeps the index line', async ($, on) => {
  const files = engine(on, { rmExit: 1 })
  await start($)
  await write($, 'a')
  const failed = await remove($, 'a')
  expect(failed.deny).toContain('Permission denied')
  expect(files.get(INDEX)).toBe('- [a](a.md) — The user wants answers short\n')
  expect(files.has(`${DIR}/a.md`)).toBe(true)
})

test('an index line whose file is gone can still be deleted', async ($, on) => {
  const files = engine(on)
  await start($)
  files.set(INDEX, '- [gone](gone.md) — x\n- [b](b.md) — y\n')
  expect((await remove($, 'gone')).result).toBe('Deleted global memory gone.')
  expect(files.get(INDEX)).toBe('- [b](b.md) — y\n')
  expect((await remove($, 'gone')).deny).toContain('No global memory')
})

test('"memory" is refused, as memory.md would be MEMORY.md where case is ignored', async ($, on) => {
  const files = engine(on)
  await start($)
  expect((await write($, 'memory')).deny).toContain('reserved')
  expect((await remove($, 'memory')).deny).toContain('No global memory')
  expect(files.size).toBe(0)
})

test('a name may come with the .md its index link has', async ($, on) => {
  engine(on)
  await start($)
  await write($, 'a')
  expect((await read($, 'a.md')).result).toContain('Keep answers short.')
  expect((await remove($, 'a.md')).result).toBe('Deleted global memory a.')
})

test('a title is kept, trimmed and unbracketed', async ($, on) => {
  const files = engine(on)
  await start($)
  await write($, 'x', { title: 'Nice [title]' })
  expect(files.get(INDEX)).toBe('- [Nice title](x.md) — The user wants answers short\n')
  await write($, 'x', { description: 'updated' })
  expect(files.get(INDEX)).toBe('- [Nice title](x.md) — updated\n')
  await write($, 'y', { title: '   ' })
  expect(files.get(INDEX)).toContain('- [y](y.md) — ')
})

test('a description is a quoted scalar, so a colon cannot break the front matter', async ($, on) => {
  const files = engine(on)
  await start($)
  await write($, 'y', { description: 'Use X: always, "quoted"' })
  expect(files.get(`${DIR}/y.md`)).toContain('description: "Use X: always, \\"quoted\\""\n')
})

test('writes made at once all reach the index', async ($, on) => {
  const files = engine(on)
  await start($)
  await Promise.all([write($, 'a'), write($, 'b'), write($, 'c')])
  const lines = (files.get(INDEX) ?? '').split('\n').filter(l => l !== '')
  expect(lines.length).toBe(3)
})

test('a rule that denies the call refuses it, and nothing is written', async ($, on) => {
  const files = engine(on, { verdict: 'deny' })
  await start($)
  const saved = await write($, 'short-answers')
  expect(saved.deny).toContain('not permitted')
  expect(files.has(`${DIR}/short-answers.md`)).toBe(false)
  expect(files.has(INDEX)).toBe(false)

  files.set(`${DIR}/kept.md`, 'x')
  expect((await remove($, 'kept')).deny).toContain('not permitted')
  expect(files.has(`${DIR}/kept.md`)).toBe(true)
})

// The kit has no person to answer $.ui.ask, so an ask is one nobody can answer: it refuses.
test('an ask no one can answer refuses, and nothing is written', async ($, on) => {
  const files = engine(on, { verdict: 'ask' })
  await start($)
  expect((await write($, 'short-answers')).deny).toContain('was not approved')
  expect(files.has(INDEX)).toBe(false)
})

test('a write or delete does not change the system prompt mid-session', async ($, on) => {
  engine(on)
  const invalidated: unknown[] = []
  on('ui.invalidate', (_, e) => {
    invalidated.push(e)
    return { value: undefined }
  })
  await start($)
  await write($, 'short-answers')
  await remove($, 'short-answers')
  expect(invalidated).toEqual([])
})

test('the lock is taken for a change and let go after it', async ($, on) => {
  const files = engine(on)
  await start($)
  await write($, 'short-answers')
  await remove($, 'short-answers')
  expect(files.log).toEqual(['lock', 'unlock', 'lock', 'unlock'])
})

test('a lock another session holds is waited for', async ($, on) => {
  const files = engine(on, { lockBusy: 3 })
  await start($)
  expect((await write($, 'short-answers')).result).toBe('Saved global memory short-answers.')
  expect(files.log).toEqual(['lock', 'unlock'])
})

test('a lock gone stale is broken, once, and the change goes on', async ($, on) => {
  const files = engine(on, { lockStale: true })
  await start($)
  expect((await write($, 'short-answers')).result).toBe('Saved global memory short-answers.')
  expect(files.log).toEqual(['broken', 'lock', 'unlock'])
})

test('a lock another session has made anew since is not broken', async ($, on) => {
  const files = engine(on, { lockStale: true, lockRenewed: true })
  await start($)
  expect((await write($, 'short-answers')).result).toBe('Saved global memory short-answers.')
  expect(files.log).toEqual(['lock', 'unlock'])
})

test('a lock another session took from this one is left to it', async ($, on) => {
  const files = engine(on, { lockStolen: true })
  await start($)
  expect((await write($, 'short-answers')).result).toBe('Saved global memory short-answers.')
  expect(files.log).toEqual(['lock'])
  expect(files.get(`${DIR}/.lock/owner`)).toBe('another-session')
})

test('a lock that is never freed refuses the change and writes nothing', async ($, on) => {
  const files = engine(on, { lockBusy: 1_000 })
  await start($)
  const saved = await write($, 'short-answers')
  expect(saved.deny).toContain('another session holds the memory lock')
  expect(files.has(INDEX)).toBe(false)
})

test('a compaction asks for the memory section again', async ($, on) => {
  engine(on)
  const invalidated: string[] = []
  on('ui.invalidate', (_, e) => {
    invalidated.push(e.event)
    return { value: undefined }
  })
  on('session.compact', (_, e) => ({ messages: e.messages }))
  await start($)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  expect(invalidated).toEqual(['prompt.section'])
})

test('a full index takes no new memory, but replaces one it holds', async ($, on) => {
  const files = engine(on)
  files.set(INDEX, Array.from({ length: 200 }, (_, i) => `- [m${i}](m${i}.md) — d`).join('\n') + '\n')
  await start($)
  expect((await write($, 'one-more')).deny).toContain('200 memories')
  expect(files.has(`${DIR}/one-more.md`)).toBe(false)
  expect((await write($, 'm7')).result).toBe('Saved global memory m7.')
})

test('memory files and the index are moved into place whole, and no temp file is left', async ($, on) => {
  const files = engine(on)
  await start($)
  await write($, 'a')
  expect(files.moves).toEqual([`${DIR}/a.md`, INDEX])
  await remove($, 'a')
  expect(files.moves).toEqual([`${DIR}/a.md`, INDEX, INDEX])
  expect([...files.keys()].filter(path => path.endsWith('.tmp'))).toEqual([])
})

test('a save whose index cannot be updated says the file was written', async ($, on) => {
  const disk: Disk = { indexMoveFails: true }
  const files = engine(on, disk)
  await start($)
  const saved = await write($, 'a')
  expect(saved.deny).toContain('Wrote a.md but could not update the index')
  expect(saved.deny).toContain('Permission denied')
  expect(files.has(`${DIR}/a.md`)).toBe(true)
  expect(files.has(INDEX)).toBe(false)
})

test('a delete whose index cannot be updated says the file is gone, and a second delete clears the line', async ($, on) => {
  const disk: Disk = {}
  const files = engine(on, disk)
  await start($)
  await write($, 'a')
  disk.indexMoveFails = true
  const failed = await remove($, 'a')
  expect(failed.deny).toContain('Deleted a.md but could not clear its index line')
  expect(files.has(`${DIR}/a.md`)).toBe(false)
  expect(files.get(INDEX)).toContain('(a.md)')

  disk.indexMoveFails = false
  expect((await remove($, 'a')).result).toBe('Deleted global memory a.')
  expect(files.get(INDEX)).toBe('')
})

test('a title, a description and a body have a size', async ($, on) => {
  const files = engine(on)
  await start($)
  expect((await write($, 'a', { title: 'x'.repeat(81) })).deny).toContain('The title is 81 characters long; the most is 80')
  expect((await write($, 'a', { description: 'x'.repeat(401) })).deny).toContain('The description is 401 characters')
  expect((await write($, 'a', { body: 'x'.repeat(20_001) })).deny).toContain('The body is 20001 characters')
  expect(files.size).toBe(0)
  const atLimit = await write($, 'a', { title: 'x'.repeat(80), description: 'x'.repeat(400), body: 'x'.repeat(20_000) })
  expect(atLimit.result).toBe('Saved global memory a.')
})

test('a folder that cannot be made refuses the change at once', async ($, on) => {
  const files = engine(on, { mkdirExit: 1 })
  await start($)
  const saved = await write($, 'a')
  expect(saved.deny).toContain('was not changed')
  expect(saved.deny).toContain('could not make /home/u/.claude/memory')
  expect(files.size).toBe(0)
})

// The kit has no person to answer $.ui.ask, and does not pass it on to a hook: an ask that is made
// comes back as "was not approved", and one that is not made comes back as a refusal of the call.
test('a delete asks about a memory that is there, not one that is not', async ($, on) => {
  const files = engine(on, { verdict: 'ask' })
  await start($)
  expect((await remove($, 'zzz')).deny).toBe('No global memory is named "zzz".')
  files.set(`${DIR}/a.md`, 'x')
  expect((await remove($, 'a')).deny).toContain('was not approved')
  files.delete(`${DIR}/a.md`)
  files.set(INDEX, '- [a](a.md) — x\n')
  expect((await remove($, 'a')).deny).toContain('was not approved')
})

test('the question shows what is stored, the body in part, and whether it replaces a memory', () => {
  const entry = { name: 'short-answers', title: ' Short [answers] ', description: 'The user\nwants answers short', type: 'feedback' as const }
  const body = `Keep answers short. ${'y'.repeat(400)}`
  const shown = saveQuestion({ ...entry, body, replacing: false })
  expect(shown.split('\n')).toEqual([
    'Save global memory "short-answers" (feedback)?',
    'Title: Short answers',
    'Index line: The user wants answers short',
    `Body: ${body.slice(0, 300)}…`,
  ])
  expect(saveQuestion({ ...entry, title: '', body: 'Short.', replacing: true })).toBe(
    'Replace global memory "short-answers" (feedback)?\nIndex line: The user wants answers short\nBody: Short.',
  )
})

test('an index line with a bullet or an indent is an entry, and a duplicate goes when its memory is saved again', async ($, on) => {
  const files = engine(on)
  files.set(INDEX, '  - [x](x.md) — old\n* [y](y.md) — y\n- [x](x.md) — duplicate\n')
  await start($)
  await write($, 'x', { description: 'new' })
  expect(files.get(INDEX)).toBe('- [x](x.md) — new\n* [y](y.md) — y\n')
  await remove($, 'y')
  expect(files.get(INDEX)).toBe('- [x](x.md) — new\n')
})

test('a save call prints as its name and type, a cut description and the size of its body', () => {
  const long = 'x'.repeat(200)
  expect(briefWrite({ name: 'a', type: 'user', description: long, body: 'hello' })).toEqual({
    name: 'a',
    type: 'user',
    description: `${'x'.repeat(79)}…`,
    body: '5 characters',
  })
  expect(briefWrite({ name: 'a', description: 'short' })).toEqual({ name: 'a', description: 'short' })
  expect(briefWrite(undefined)).toEqual({})
})
