import type { EngineInterface, Register } from 'claude-code'
import { SLUG, TYPES, guide, memoryFile, withEntry, withoutEntry } from './memory'
import type { MemoryType } from './memory'

const OWN = 'mcp__global-memory__'

const NAME = {
  type: 'string',
  description: 'The memory\'s short kebab-case name, such as "no-gui-tools". It is also the file name.',
}

const WRITE_TOOL = {
  name: 'global_memory_write',
  description:
    'Save a memory that holds in every project, to the global memory. Writing an existing name replaces it. Updates the index.',
  isDeferred: false,
  inputSchema: {
    type: 'object',
    properties: {
      name: NAME,
      title: { type: 'string', description: 'A few words for the index. Defaults to the name.' },
      description: {
        type: 'string',
        description: 'One line for the index: the fact, and when a later session needs it.',
      },
      type: { type: 'string', enum: [...TYPES], description: 'user: who they are. feedback: how they want you to work. reference: where something lives.' },
      body: { type: 'string', description: 'The memory. For feedback: the rule, then **Why:** and **How to apply:** lines.' },
    },
    required: ['name', 'description', 'type', 'body'],
  },
}

const READ_TOOL = {
  name: 'global_memory_read',
  description: 'Read one global memory in full, by the name its index line links to.',
  isDeferred: false,
  inputSchema: { type: 'object', properties: { name: NAME }, required: ['name'] },
}

const DELETE_TOOL = {
  name: 'global_memory_delete',
  description: 'Delete a global memory that has proved wrong or no longer holds, and its index line.',
  isDeferred: false,
  inputSchema: { type: 'object', properties: { name: NAME }, required: ['name'] },
}

const asText = (value: unknown) => (typeof value === 'string' ? value : '')

async function readIndex($: EngineInterface, dir: string) {
  const text = await $.fs.read(`${dir}/MEMORY.md`).catch(() => '')
  return typeof text === 'string' ? text : ''
}

export const register: Register = on => {
  let dir = ''

  // The global memory sits beside the projects' folders in the user's .claude.
  on('session.start', async ($, e, next) => {
    const home = await $.env.get('HOME')
    dir = home === undefined || home === '' ? '' : `${home}/.claude/memory`
    await $.tool.register(WRITE_TOOL)
    await $.tool.register(READ_TOOL)
    await $.tool.register(DELETE_TOOL)
    return next(e)
  })

  // Only where the engine keeps memory at all: its section is null when memory is off.
  on('prompt.section', { name: 'memory' }, async ($, e, next) => {
    const core = await next(e)
    if (core.text === null || dir === '') return core
    return { text: `${core.text}\n\n${guide(dir, await readIndex($, dir))}` }
  })

  on('tool.call', { tool: `${OWN}global_memory_write` }, async ($, e) => {
    const name = asText(e.name)
    const type = asText(e.type)
    const description = asText(e.description)
    const body = asText(e.body)
    if (dir === '') return { deny: 'HOME is not set, so there is no place for a global memory.' }
    if (!SLUG.test(name)) return { deny: `"${name}" is not a name: use lowercase letters, digits and hyphens, such as "no-gui-tools".` }
    if (!TYPES.includes(type as MemoryType)) return { deny: `type must be one of ${TYPES.join(', ')}.` }
    if (description.trim() === '' || body.trim() === '') return { deny: 'A memory needs a description and a body.' }

    const existed = await $.fs.exists(`${dir}/${name}.md`)
    await $.fs.write(`${dir}/${name}.md`, memoryFile({ name, description, type: type as MemoryType, body }))
    const index = await readIndex($, dir)
    await $.fs.write(
      `${dir}/MEMORY.md`,
      withEntry(index, name, asText(e.title) === '' ? name : asText(e.title), description),
    )
    $.ui.invalidate('prompt.section')
    return { result: `${existed ? 'Replaced' : 'Saved'} global memory ${name}.` }
  })

  on('tool.call', { tool: `${OWN}global_memory_read` }, async ($, e) => {
    const name = asText(e.name)
    if (!SLUG.test(name) || dir === '') return { deny: `No global memory is named "${name}".` }
    const text = await $.fs.read(`${dir}/${name}.md`).catch(() => undefined)
    if (typeof text !== 'string') return { deny: `No global memory is named "${name}".` }
    return { result: text }
  })

  on('tool.call', { tool: `${OWN}global_memory_delete` }, async ($, e) => {
    const name = asText(e.name)
    if (!SLUG.test(name) || dir === '' || !(await $.fs.exists(`${dir}/${name}.md`)))
      return { deny: `No global memory is named "${name}".` }
    await $.process.run(['rm', '--', `${dir}/${name}.md`])
    await $.fs.write(`${dir}/MEMORY.md`, withoutEntry(await readIndex($, dir), name))
    $.ui.invalidate('prompt.section')
    return { result: `Deleted global memory ${name}.` }
  })
}
