import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const DIR = '/home/u/.claude/memory'
const INDEX = `${DIR}/MEMORY.md`

type Disk = {
  rmExit?: number
  indexUnreadable?: boolean
  verdict?: 'allow' | 'ask' | 'deny'
  // Attempts at the lock that fail before one succeeds, as another session holds it.
  lockBusy?: number
  // Whether the held lock is a minute old.
  lockStale?: boolean
}

// An in-memory disk under the plugin; the engine's memory section reads "core memory".
function engine(on: On, disk: Disk = {}) {
  const files = new Map<string, string>()
  const log: string[] = []
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
    return { value: undefined }
  })
  const ran = (exitCode: number, stdout = '', stderr = '') => ({
    value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })
  let busy = disk.lockBusy ?? 0
  let held = false
  on('process.run', (_, e) => {
    const [cmd] = e.argv
    const isLock = e.argv.includes(`${DIR}/.lock`)
    if (cmd === 'mkdir' && isLock) {
      if (busy > 0 || held) return ran(1, '', 'File exists')
      held = true
      log.push('lock')
      return ran(0)
    }
    if (cmd === 'find') return ran(0, disk.lockStale ? `${DIR}/.lock\n` : '')
    if (cmd === 'rmdir') {
      if (held) log.push('unlock')
      else busy = 0
      held = false
      return ran(0)
    }
    if (cmd === 'mkdir') return ran(0)
    const exitCode = disk.rmExit ?? 0
    if (exitCode === 0) files.delete(String(e.argv[2]))
    return ran(exitCode, '', exitCode === 0 ? '' : 'rm: cannot remove: Permission denied')
  })
  on('clock.sleep', () => {
    busy--
    return { value: undefined }
  })
  return Object.assign(files, { log })
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
  expect((await remove($, 'short-answers')).deny).toBeDefined()
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

test('a lock a minute old is broken', async ($, on) => {
  const files = engine(on, { lockBusy: 1, lockStale: true })
  await start($)
  expect((await write($, 'short-answers')).result).toBe('Saved global memory short-answers.')
  expect(files.log).toEqual(['lock', 'unlock'])
})

test('a lock that is never freed refuses the change and writes nothing', async ($, on) => {
  const files = engine(on, { lockBusy: 1_000 })
  await start($)
  const saved = await write($, 'short-answers')
  expect(saved.deny).toContain('another session holds the memory lock')
  expect(files.has(INDEX)).toBe(false)
})

test('a full index takes no new memory, but replaces one it holds', async ($, on) => {
  const files = engine(on)
  files.set(INDEX, Array.from({ length: 200 }, (_, i) => `- [m${i}](m${i}.md) — d`).join('\n') + '\n')
  await start($)
  expect((await write($, 'one-more')).deny).toContain('200 memories')
  expect(files.has(`${DIR}/one-more.md`)).toBe(false)
  expect((await write($, 'm7')).result).toBe('Saved global memory m7.')
})
