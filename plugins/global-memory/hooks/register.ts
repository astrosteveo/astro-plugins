import type { EngineInterface, Register } from 'claude-code'
import {
  TYPES,
  entryLine,
  fileNote,
  guide,
  hasEntry,
  indexContent,
  briefWrite,
  indexFull,
  indexNote,
  isName,
  memoryFile,
  overLimit,
  saveQuestion,
  withEntry,
} from './memory'
import type { MemoryType } from './memory'
import { MENU_COMMAND, menu } from './menu'
import { change, deleteMemory, noMemory, put, readIndex, why } from './files'
import type { Answer } from './files'

const OWN = 'mcp__global-memory__'

const NAME = {
  type: 'string',
  description: 'The memory\'s short kebab-case name, such as "no-gui-tools": its index link without ".md". It is also the file name.',
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
      title: { type: 'string', description: 'A few words for the index line. Defaults to the name.' },
      description: {
        type: 'string',
        description:
          'One line for the index, used to decide relevance in future conversations, so be specific. With the title and name, the index line is at most 150 characters.',
      },
      type: {
        type: 'string',
        enum: [...TYPES],
        description:
          'user: who the user is (role, expertise, preferences). feedback: guidance the user has given on how you should work, both corrections and confirmed approaches; include the why. reference: pointers to external resources.',
      },
      body: {
        type: 'string',
        description:
          "The memory, structured as the system prompt's memory section says. With its front matter, the file is at most 4,096 bytes and 200 lines, the most recall shows of a memory.",
      },
    },
    required: ['name', 'description', 'type', 'body'],
  },
}

const READ_TOOL = {
  name: 'global_memory_read',
  description: 'Read one global memory in full, by the name in its index line\'s link (without ".md").',
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

// The name a call gives, taken from the index link as it may be: "short-answers.md" is "short-answers".
const nameOf = (value: unknown) => asText(value).trim().replace(/\.md$/, '')


type Call = { tool: string; input: Record<string, unknown>; what: string; question?: string }

// The engine's permission decision for the call, since a hook that answers it skips the check.
// A rule or mode that denies refuses; an ask goes to the person, and where none can be asked, refuses.
async function permitted($: EngineInterface, call: Call) {
  const verdict = await $.tool.check({ tool: `${OWN}${call.tool}`, input: call.input })
  if (verdict.decision === 'allow') return undefined
  if (verdict.decision === 'deny') return { deny: verdict.reason ?? `${call.what} is not permitted.` }
  const answer = await $.ui
    .ask(call.question ?? `${call.what}?`, { options: ['Allow', 'Refuse'], header: 'Memory' })
    .catch(() => undefined)
  return answer === 'Allow' ? undefined : { deny: `${call.what} was not approved.` }
}


// A change the permission check allows, made alone and under the lock.
async function changeWith($: EngineInterface, dir: string, call: Call, job: () => Promise<Answer>) {
  return (await permitted($, call)) ?? change($, dir, job)
}

// What a hook answers when it overran its budget: the job it queued may still land.
const unfinished = (verb: string, check: string) => ({
  deny: `global-memory: the ${verb} did not finish, so it may or may not have been made. ${check}`,
})

type Args = Record<string, unknown>

async function save($: EngineInterface, dir: string, e: Args): Promise<Answer> {
  const name = nameOf(e.name)
  const type = asText(e.type)
  const description = asText(e.description)
  const body = asText(e.body)
  const title = asText(e.title)
  if (dir === '') return { deny: 'Neither CLAUDE_CONFIG_DIR nor HOME is set, so there is no place for a global memory.' }
  if (!isName(name))
    return { deny: `"${name}" is not a name: use lowercase letters, digits and hyphens, such as "no-gui-tools" ("memory" is reserved).` }
  if (!TYPES.includes(type as MemoryType)) return { deny: `type must be one of ${TYPES.join(', ')}.` }
  if (description.trim() === '' || body.trim() === '') return { deny: 'A memory needs a description and a body.' }
  // Checked against the index as it stands, as a blank title keeps the one its line has. The
  // index may not be readable: the change then fails under the lock, before anything is written.
  const line = entryLine(await readIndex($, dir).catch(() => ''), name, title, description)
  const fileOf = async () => memoryFile({ name, description, type: type as MemoryType, body, modified: await $.clock.now() })
  const tooLong = overLimit({ line, file: await fileOf() })
  if (tooLong !== undefined) return { deny: tooLong }

  // The person is shown all of what is stored, and whether it replaces a memory, as the title and
  // description join every future system prompt and the body is what a later read hands the model.
  const file = `${dir}/${name}.md`
  const call = {
    tool: 'global_memory_write',
    input: { name, title, description, type, body },
    what: `Save global memory "${name}"`,
    question: saveQuestion({ name, title, description, type: type as MemoryType, body, replacing: await $.fs.exists(file) }),
  }

  // The index joins the system prompt at the next session, not this one: a changed prompt would
  // throw away the cache of the conversation.
  return changeWith($, dir, call, async () => {
    const index = await readIndex($, dir)
    const next = withEntry(index, name, title, description)
    const full = indexFull(index, next)
    if (full !== undefined) return { deny: full }
    const existed = await $.fs.exists(file)
    const text = await fileOf()
    await put($, file, text)
    try {
      await put($, `${dir}/MEMORY.md`, next)
    } catch (error) {
      return { deny: `Wrote ${name}.md but could not update the index (${why(error)}), so it is not listed. Save it again to list it.` }
    }
    return { result: `${existed ? 'Replaced' : 'Saved'} global memory ${name}.${fileNote(text)}${indexNote(next)}` }
  })
}

async function remove($: EngineInterface, dir: string, e: Args): Promise<Answer> {
  const name = nameOf(e.name)
  if (!isName(name) || dir === '') return noMemory(name)
  const file = `${dir}/${name}.md`
  // Ask about a memory that is there: its file, or the index line a file once had.
  const listed = (await $.fs.exists(file)) || hasEntry(await readIndex($, dir).catch(() => ''), name)
  if (!listed) return noMemory(name)

  const call = { tool: 'global_memory_delete', input: { name }, what: `Delete global memory "${name}"` }
  return (await permitted($, call)) ?? deleteMemory($, dir, name)
}


export const register: Register = on => {
  let dir = ''

  // The global memory sits beside the projects' folders in Claude Code's config folder, which
  // CLAUDE_CONFIG_DIR moves away from ~/.claude.
  on('session.start', async ($, e, next) => {
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || ''
    const home = (await $.env.get('HOME')) || ''
    dir = config !== '' ? `${config.replace(/\/+$/, '')}/memory` : home !== '' ? `${home}/.claude/memory` : ''
    await $.tool.register(WRITE_TOOL)
    await $.tool.register(READ_TOOL)
    await $.tool.register(DELETE_TOOL)
    await $.command.register(MENU_COMMAND)
    return next(e)
  })

  // Only where the engine keeps memory at all: its section is null when memory is off.
  on('prompt.section', { name: 'memory' }, async ($, e, next) => {
    const core = await next(e)
    return core.text === null || dir === '' ? core : { text: `${core.text}\n\n${guide(dir)}` }
  })

  // The index reaches the model as Claude Code's own MEMORY.md does: an instruction file of the
  // memory kind, in the first message's context, which the engine reads again after a compaction.
  // This runs before the memory section is built, so the composed prompt says whether memory is on.
  on('prompt.context', async ($, e, next) => {
    const below = await next(e)
    const files = below.instructionFiles ?? e.instructionFiles
    if (files === undefined || dir === '') return below
    const composed = await $.prompt.compose()
    if (!composed.sections.some(section => section.id === 'memory')) return below
    const index = await readIndex($, dir).catch(() => '')
    const content = indexContent(index)
    if (content === '') return below
    return { ...below, instructionFiles: [...files, { path: `${dir}/MEMORY.md`, kind: 'memory' as const, content }] }
  })

  // A save's row names the memory and sizes its body; ctrl+o still shows all of it.
  on('ui.render', { component: 'ToolUse', props: { tool: `${OWN}global_memory_write` } }, (_, e, next) =>
    e.props.isExpanded === true ? next(e) : next({ ...e, props: { ...e.props, input: briefWrite(e.props.input) } }),
  )

  on('tool.call', { tool: `${OWN}global_memory_write` }, ($, e) => save($, dir, e)).catch(() =>
    unfinished('save', 'Read it with global_memory_read before saving again.'),
  )

  on('tool.call', { tool: `${OWN}global_memory_read` }, async ($, e) => {
    const name = nameOf(e.name)
    if (!isName(name) || dir === '') return noMemory(name)
    const text = await $.fs.read(`${dir}/${name}.md`).catch(() => undefined)
    return typeof text === 'string' ? { result: text } : noMemory(name)
  }).catch(() => ({ deny: 'global-memory: the read failed.' }))

  on('tool.call', { tool: `${OWN}global_memory_delete` }, ($, e) => remove($, dir, e)).catch(() =>
    unfinished('delete', 'Read the memory to see whether it is still there.'),
  )

  menu(on, () => dir)
}
