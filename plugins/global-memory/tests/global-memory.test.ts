import { expect, test } from 'claude-code/testing'

const DIR = '/home/u/.claude/memory'

// An in-memory disk under the plugin; the engine's memory section reads "core memory".
function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const files = new Map<string, string>()
  on('env.get', () => ({ value: '/home/u' }))
  on('tool.register', (_, e) => ({ value: e }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.section', (_, e) => ({ text: e.text }))
  on('fs.read', (_, e) => {
    const text = files.get(String(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.exists', (_, e) => ({ value: files.has(String(e.path)) }))
  on('fs.write', (_, e) => {
    files.set(String(e.path), String(e.text))
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    files.delete(String((e.argv as string[])[2]))
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  return files
}

const write = ($: any, name: string, extra: object = {}) =>
  $.tool.call({
    tool: 'mcp__global-memory__global_memory_write',
    name,
    description: 'The user wants answers short',
    type: 'feedback',
    body: 'Keep answers short.\n\n**Why:** they said so.',
    ...extra,
  })

test('a saved memory is a file, a line in the index, and joins the memory section', async ($, on) => {
  const files = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const saved = await write($, 'short-answers', { title: 'Short answers' })
  expect(saved.result).toBe('Saved global memory short-answers.')
  expect(files.get(`${DIR}/short-answers.md`)).toContain('name: short-answers\ndescription: The user wants answers short\nmetadata:\n  type: feedback')
  expect(files.get(`${DIR}/MEMORY.md`)).toBe('- [Short answers](short-answers.md) — The user wants answers short\n')

  const section = await $.prompt.section({ name: 'memory', text: 'core memory' })
  expect(section.text).toContain('core memory')
  expect(section.text).toContain('- [Short answers](short-answers.md) — The user wants answers short')
  expect(section.text).toContain(DIR)
})

test('writing a name again replaces it in place; delete removes file and line', async ($, on) => {
  const files = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await write($, 'a')
  await write($, 'b')
  const again = await write($, 'a', { description: 'changed' })
  expect(again.result).toBe('Replaced global memory a.')
  expect(files.get(`${DIR}/MEMORY.md`)).toBe('- [a](a.md) — changed\n- [b](b.md) — The user wants answers short\n')

  const gone = await $.tool.call({ tool: 'mcp__global-memory__global_memory_delete', name: 'a' })
  expect(gone.result).toBe('Deleted global memory a.')
  expect(files.get(`${DIR}/MEMORY.md`)).toBe('- [b](b.md) — The user wants answers short\n')
  expect(files.has(`${DIR}/a.md`)).toBe(false)
})

test('read returns the file; a bad or unknown name is refused', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await write($, 'a')
  const read = await $.tool.call({ tool: 'mcp__global-memory__global_memory_read', name: 'a' })
  expect(read.result).toContain('Keep answers short.')
  expect((await $.tool.call({ tool: 'mcp__global-memory__global_memory_read', name: 'zzz' })).deny).toContain('No global memory')
  expect((await $.tool.call({ tool: 'mcp__global-memory__global_memory_read', name: '../x' })).deny).toContain('No global memory')
  expect((await write($, '../escape')).deny).toContain('is not a name')
  expect((await write($, 'ok', { type: 'project' })).deny).toContain('type must be')
})

test('with the engine memory off, the section stays off', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.prompt.section({ name: 'memory', text: null })).text).toBeNull()
})
