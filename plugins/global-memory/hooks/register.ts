import type { EngineInterface, Register } from 'claude-code'
import {
  MAX_ENTRIES,
  TYPES,
  entryCount,
  guide,
  hasEntry,
  isName,
  memoryFile,
  overLimit,
  saveQuestion,
  withEntry,
  withoutEntry,
} from './memory'
import type { MemoryType } from './memory'

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
      title: { type: 'string', description: 'A few words for the index, at most 80 characters. Defaults to the name.' },
      description: {
        type: 'string',
        description: 'One line for the index, at most 400 characters: the fact, and when a later session needs it.',
      },
      type: { type: 'string', enum: [...TYPES], description: 'user: who they are. feedback: how they want you to work. reference: where something lives.' },
      body: { type: 'string', description: 'The memory, at most 20,000 characters. For feedback: the rule, then **Why:** and **How to apply:** lines.' },
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

const noMemory = (name: string) => ({ deny: `No global memory is named "${name}".` })

const why = (error: unknown) => (error instanceof Error ? error.message : String(error))

// A missing index is an empty one. Any other failure to read it throws, so no call writes the
// index back over a file it could not see.
async function readIndex($: EngineInterface, dir: string) {
  if (!(await $.fs.exists(`${dir}/MEMORY.md`))) return ''
  const text = await $.fs.read(`${dir}/MEMORY.md`)
  if (typeof text !== 'string') throw new Error('MEMORY.md did not read as text')
  return text
}

// A file is written whole or not at all: to a temp file beside it, then renamed over it. Another
// session reads the index without the lock, and a crash must not leave it cut short.
async function put($: EngineInterface, path: string, text: string) {
  const temp = `${path}.tmp`
  await $.fs.write(temp, text)
  const moved = await $.process.run(['mv', '-f', '--', temp, path])
  if (moved.exitCode !== 0) throw new Error(`could not move ${temp} into place: ${moved.stderr.trim() || `mv exited ${moved.exitCode}`}`)
}

type Answer = { result: string } | { deny: string }

// Sessions in other projects share this folder. A directory is the lock: mkdir makes one or fails,
// in one step. A lock a minute old belongs to a session that died.
const LOCK_TRIES = 100
const LOCK_WAIT_MS = 50

async function withLock<T>($: EngineInterface, dir: string, job: () => Promise<T>) {
  const lock = `${dir}/.lock`
  const made = await $.process.run(['mkdir', '-p', '--', dir])
  if (made.exitCode !== 0) throw new Error(`could not make ${dir}: ${made.stderr.trim() || `mkdir exited ${made.exitCode}`}`)
  for (let tries = 1; ; tries++) {
    if ((await $.process.run(['mkdir', '--', lock])).exitCode === 0) break
    if (tries >= LOCK_TRIES) throw new Error('another session holds the memory lock')
    const stale = await $.process.run(['find', lock, '-maxdepth', '0', '-mmin', '+1'])
    if (stale.stdout.trim() !== '') await $.process.run(['rmdir', '--', lock])
    else await $.clock.sleep(LOCK_WAIT_MS)
  }
  try {
    return await job()
  } finally {
    // A lock that will not come off must not turn a change that was made into an error.
    await $.process.run(['rmdir', '--', lock]).catch(() => undefined)
  }
}

// The engine's permission decision for the call, since a hook that answers it skips the check.
// A rule or mode that denies refuses; an ask goes to the person, and where none can be asked, refuses.
async function permitted(
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>,
  what: string,
  question = `${what}?`,
) {
  const verdict = await $.tool.check({ tool: `${OWN}${tool}`, input })
  if (verdict.decision === 'allow') return undefined
  if (verdict.decision === 'deny') return { deny: verdict.reason ?? `${what} is not permitted.` }
  const answer = await $.ui.ask(question, { options: ['Allow', 'Refuse'], header: 'Memory' }).catch(() => undefined)
  return answer === 'Allow' ? undefined : { deny: `${what} was not approved.` }
}

// Calls that change the files take turns, and hold the lock, as each reads the index and writes
// it back. A failure is a refusal the model can read, not an opaque error from a skipped hook.
let queue: Promise<unknown> = Promise.resolve()

function change($: EngineInterface, dir: string, job: () => Promise<Answer>): Promise<Answer> {
  const run = queue.then(() => withLock($, dir, job))
  queue = run.catch(() => undefined)
  return run.catch((error: unknown) => ({
    deny: `The global memory was not changed: ${why(error)}`,
  }))
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
    const index = await readIndex($, dir).catch(() => undefined)
    return index === undefined ? core : { text: `${core.text}\n\n${guide(dir, index)}` }
  })

  on('tool.call', { tool: `${OWN}global_memory_write` }, async ($, e) => {
    const name = nameOf(e.name)
    const type = asText(e.type)
    const description = asText(e.description)
    const body = asText(e.body)
    const title = asText(e.title)
    if (dir === '') return { deny: 'HOME is not set, so there is no place for a global memory.' }
    if (!isName(name))
      return { deny: `"${name}" is not a name: use lowercase letters, digits and hyphens, such as "no-gui-tools" ("memory" is reserved).` }
    if (!TYPES.includes(type as MemoryType)) return { deny: `type must be one of ${TYPES.join(', ')}.` }
    if (description.trim() === '' || body.trim() === '') return { deny: 'A memory needs a description and a body.' }
    const tooLong = overLimit({ title, description, body })
    if (tooLong !== undefined) return { deny: tooLong }

    // The person is shown all of what is stored, and whether it replaces a memory, as the title and
    // description join every future system prompt and the body is what a later read hands the model.
    const file = `${dir}/${name}.md`
    const replacing = await $.fs.exists(file)
    const question = saveQuestion({ name, title, description, type: type as MemoryType, body, replacing })
    const refused = await permitted($, 'global_memory_write', { name, title, description, type, body }, `Save global memory "${name}"`, question)
    if (refused) return refused

    // The index joins the system prompt at the next session, not this one: a changed prompt would
    // throw away the cache of the conversation.
    return change($, dir, async () => {
      const index = await readIndex($, dir)
      if (!hasEntry(index, name) && entryCount(index) >= MAX_ENTRIES)
        return { deny: `The index holds ${MAX_ENTRIES} memories, the most it can: delete or fold one first.` }
      const existed = await $.fs.exists(file)
      await put($, file, memoryFile({ name, description, type: type as MemoryType, body }))
      try {
        await put($, `${dir}/MEMORY.md`, withEntry(index, name, title, description))
      } catch (error) {
        return { deny: `Wrote ${name}.md but could not update the index (${why(error)}), so it is not listed. Save it again to list it.` }
      }
      return { result: `${existed ? 'Replaced' : 'Saved'} global memory ${name}.` }
    })
  }).catch(() => ({
    deny: 'global-memory: the save did not finish, so it may or may not have been made. Read it with global_memory_read before saving again.',
  }))

  on('tool.call', { tool: `${OWN}global_memory_read` }, async ($, e) => {
    const name = nameOf(e.name)
    if (!isName(name) || dir === '') return noMemory(name)
    const text = await $.fs.read(`${dir}/${name}.md`).catch(() => undefined)
    return typeof text === 'string' ? { result: text } : noMemory(name)
  }).catch(() => ({ deny: 'global-memory: the read failed.' }))

  on('tool.call', { tool: `${OWN}global_memory_delete` }, async ($, e) => {
    const name = nameOf(e.name)
    if (!isName(name) || dir === '') return noMemory(name)
    // Ask about a memory that is there: its file, or the index line a file once had.
    const listed = (await $.fs.exists(`${dir}/${name}.md`)) || hasEntry(await readIndex($, dir).catch(() => ''), name)
    if (!listed) return noMemory(name)
    const refused = await permitted($, 'global_memory_delete', { name }, `Delete global memory "${name}"`)
    if (refused) return refused

    return change($, dir, async () => {
      const file = `${dir}/${name}.md`
      const index = await readIndex($, dir)
      // A line the index keeps for a file that is gone is cleared too, or nothing could.
      const onDisk = await $.fs.exists(file)
      if (!onDisk && !hasEntry(index, name)) return noMemory(name)
      if (onDisk) {
        const removed = await $.process.run(['rm', '--', file])
        if (removed.exitCode !== 0)
          return { deny: `Could not delete global memory ${name}: ${removed.stderr.trim() || `rm exited ${removed.exitCode}`}.` }
      }
      try {
        await put($, `${dir}/MEMORY.md`, withoutEntry(index, name))
      } catch (error) {
        const done = onDisk ? `Deleted ${name}.md` : `${name}.md was already gone`
        return { deny: `${done} but could not clear its index line (${why(error)}). Delete it again to clear the line.` }
      }
      return { result: `Deleted global memory ${name}.` }
    })
  }).catch(() => ({
    deny: 'global-memory: the delete did not finish, so it may or may not have been made. Read the memory to see whether it is still there.',
  }))
}
