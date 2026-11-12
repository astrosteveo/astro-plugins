// The files of the global memory on disk: read, written whole, and changed by one session at a time.
import type { EngineInterface } from 'claude-code'
import { hasEntry, indexNote, withoutEntry } from './memory'

export const noMemory = (name: string) => ({ deny: `No global memory is named "${name}".` })

export const why = (error: unknown) => (error instanceof Error ? error.message : String(error))

// A missing index is an empty one. Any other failure to read it throws, so no call writes the
// index back over a file it could not see.
export async function readIndex($: EngineInterface, dir: string) {
  if (!(await $.fs.exists(`${dir}/MEMORY.md`))) return ''
  const text = await $.fs.read(`${dir}/MEMORY.md`)
  if (typeof text !== 'string') throw new Error('MEMORY.md did not read as text')
  return text
}

// A file is written whole or not at all: to a temp file beside it, then renamed over it. Another
// session reads the index without the lock, and a crash must not leave it cut short.
export async function put($: EngineInterface, path: string, text: string) {
  const temp = `${path}.tmp`
  await $.fs.write(temp, text)
  const moved = await $.process.run(['mv', '-f', '--', temp, path])
  if (moved.exitCode !== 0) throw new Error(`could not move ${temp} into place: ${moved.stderr.trim() || `mv exited ${moved.exitCode}`}`)
}

export type Answer = { result: string } | { deny: string }

// Sessions in other projects share this folder. A directory is the lock: mkdir makes one or fails,
// in one step. A change takes a moment, so a lock older than STALE_MS belongs to a session that died.
const LOCK_TRIES = 100
const LOCK_WAIT_MS = 50
const STALE_MS = 15_000

async function isOld($: EngineInterface, path: string) {
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
  for (let tries = 1, missing = false; ; tries++) {
    const took = await $.process.run(['mkdir', '--', lock])
    if (took.exitCode === 0) break
    // Only a lock that is there is waited for. With none, mkdir failed for a reason of its own,
    // such as no permission or a read-only disk, that waiting will not mend; but a lock let go
    // just now looks the same, so mkdir is tried once more first.
    const held = await $.fs.stat(lock).catch(() => undefined)
    if (held === undefined) {
      if (missing) throw new Error(`could not make ${lock}: ${took.stderr.trim() || `mkdir exited ${took.exitCode}`}`)
      missing = true
      continue
    }
    missing = false
    if (tries >= LOCK_TRIES) throw new Error('another session holds the memory lock: try again shortly')
    if ((await $.clock.now()) - held.mtimeMs > STALE_MS) await breakStale($, lock)
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

// Calls that change the files take turns, and hold the lock, as each reads the index and writes
// it back. A failure is a refusal the model can read, not an opaque error from a skipped hook.
let queue: Promise<unknown> = Promise.resolve()

export function change($: EngineInterface, dir: string, job: () => Promise<Answer>): Promise<Answer> {
  const run = queue.then(() => withLock($, dir, job))
  queue = run.catch(() => undefined)
  return run.catch((error: unknown) => ({
    deny: `The global memory was not changed: ${why(error)}`,
  }))
}

// Deletes a memory's file and its index line, alone and under the lock, with no permission check:
// the tool checks first, and the menu deletes only what the person pressed Delete on.
export function deleteMemory($: EngineInterface, dir: string, name: string) {
  const file = `${dir}/${name}.md`
  return change($, dir, async () => {
    const index = await readIndex($, dir)
    // A line the index keeps for a file that is gone is cleared too, or nothing could.
    const onDisk = await $.fs.exists(file)
    if (!onDisk && !hasEntry(index, name)) return noMemory(name)
    if (onDisk) {
      const removed = await $.process.run(['rm', '--', file])
      if (removed.exitCode !== 0)
        return { deny: `Could not delete global memory ${name}: ${removed.stderr.trim() || `rm exited ${removed.exitCode}`}.` }
    }
    const next = withoutEntry(index, name)
    try {
      await put($, `${dir}/MEMORY.md`, next)
    } catch (error) {
      const done = onDisk ? `Deleted ${name}.md` : `${name}.md was already gone`
      return { deny: `${done} but could not clear its index line (${why(error)}). Delete it again to clear the line.` }
    }
    return { result: `Deleted global memory ${name}.${indexNote(next)}` }
  })
}
