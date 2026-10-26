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
// in one step. A change takes a moment, so a lock older than STALE_MS belongs to a session that died.
const LOCK_TRIES = 100
const LOCK_WAIT_MS = 50
const STALE_MS = 15_000

const isOld = async ($: EngineInterface, path: string) => {
  const [stat, now] = await Promise.all([$.fs.stat(path).catch(() => undefined), $.clock.now()])
  return stat !== undefined && now - stat.mtimeMs > STALE_MS
}

// Only one session at a time breaks a lock, by holding the breaker, and it looks again once it
// does: a lock another session has broken and made anew is fresh, and stays.
async function breakStale($: EngineInterface, lock: string) {
  const breaker = `${lock}.break`
  if ((await $.process.run(['mkdir', '--', breaker])).exitCode !== 0) {
    if (await isOld($, breaker)) await $.process.run(['rmdir', '--', breaker])
    return
  }
  try {
    if (await isOld($, lock)) await $.process.run(['rm', '-rf', '--', lock])
  } finally {
    await $.process.run(['rmdir', '--', breaker])
  }
}

async function withLock<T>($: EngineInterface, dir: string, job: () => Promise<T>) {
  const lock = `${dir}/.lock`
  const owner = `${lock}/owner`
  const made = await $.process.run(['mkdir', '-p', '--', dir])
  if (made.exitCode !== 0) throw new Error(`could not make ${dir}: ${made.stderr.trim() || `mkdir exited ${made.exitCode}`}`)
  for (let tries = 1; ; tries++) {
    if ((await $.process.run(['mkdir', '--', lock])).exitCode === 0) break
    if (tries >= LOCK_TRIES) throw new Error('another session holds the memory lock: try again shortly')
    if (await isOld($, lock)) await breakStale($, lock)
    else await $.clock.sleep(LOCK_WAIT_MS)
  }
  const token = `${await $.clock.now()}-${Math.random().toString(36).slice(2)}`
  try {
    await $.fs.write(owner, token)
    return await job()
  } finally {
    // The lock comes off only if it is still ours: one held past STALE_MS may have been broken
    // and made anew by another session. A lock that will not come off must not turn a change
    // that was made into an error.
    const held = await $.fs.read(owner).catch(() => undefined)
    if (held === token) await $.process.run(['rm', '-rf', '--', lock]).catch(() => undefined)
  }
}

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
}

async function remove($: EngineInterface, dir: string, e: Args): Promise<Answer> {
  const name = nameOf(e.name)
  if (!isName(name) || dir === '') return noMemory(name)
  const file = `${dir}/${name}.md`
  // Ask about a memory that is there: its file, or the index line a file once had.
  const listed = (await $.fs.exists(file)) || hasEntry(await readIndex($, dir).catch(() => ''), name)
  if (!listed) return noMemory(name)

  const call = { tool: 'global_memory_delete', input: { name }, what: `Delete global memory "${name}"` }
  return changeWith($, dir, call, async () => {
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

  // The prompt section is cached for the session, so a memory saved since it was read is missing
  // from it. A compaction rebuilds the conversation anyway: read the index again then.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    if (e.agentId === undefined) $.ui.invalidate('prompt.section')
    return compacted
  })

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
}
