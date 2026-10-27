import type { EngineInterface, Register } from 'claude-code'
import { addWorktree, assess, checkoutState, chooseBase, removeWorktree, repoOf } from './git'
import type { Run } from './git'
import {
  PREFIX,
  EXCLUDE_LINE,
  ago,
  differences,
  entryKey,
  hasWork,
  isInside,
  isSweepable,
  judge,
  needsWorktree,
  withExclude,
  worktreeName,
} from './worktrees'
import type { Entry } from './worktrees'

const ENABLED = 'enabled'

// The tool the model calls to begin a task; the engine names it `mcp__<plugin>__<name>`.
const START_TOOL = 'mcp__worktrees__start'
const START_PATTERN = /^mcp__worktrees__start$/
const START_SPEC = {
  name: 'start',
  description:
    'Moves this session into a git worktree of its own, on a new branch named for the task. Call it once, before your first change to a file or your first command that writes, with a short name for the task. Reading and answering questions need no worktree. A change attempted before this call is refused. Once the work is merged the session returns to the main checkout by itself, and the next task needs this call again.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Two to five words naming the task, such as "fix login redirect". It becomes the branch name.',
      },
    },
    required: ['name'],
  },
  // In the tool list from the first prompt, not behind a search the model must think to make.
  isDeferred: false,
} as const
const REFUSAL = `worktrees: this session works in a git worktree of its own, and none exists yet, so nothing ran. Call ${START_TOOL} with a short name for the task, then repeat this call.`

const runner =
  ($: EngineInterface): Run =>
  (argv, cwd) =>
    $.process.run(argv, cwd === undefined ? undefined : { cwd })

async function entries($: EngineInterface): Promise<Entry[]> {
  const found: Entry[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(PREFIX)) continue
    const value = (await $.store.get(key)) as Entry | undefined
    if (value && typeof value.path === 'string' && typeof value.repo === 'string') found.push(value)
  }
  return found
}

const save = ($: EngineInterface, entry: Entry) => $.store.set(entryKey(entry.path), entry)
const drop = ($: EngineInterface, entry: Entry) => $.store.delete(entryKey(entry.path))
const isOn = async ($: EngineInterface) => (await $.store.get(ENABLED)) === true
const label = (entry: Entry) => entry.path.slice(entry.path.lastIndexOf('/') + 1)

// What a settled entry came to: gone, or left on disk and why.
type Outcome = { entry: Entry; removed: true } | { entry: Entry; removed: false; reason: string }

// Looks at one entry and removes its worktree when nothing in it would be lost.
// Anything else stays, with the reason written on its record.
async function settle($: EngineInterface, entry: Entry): Promise<Outcome> {
  const run = runner($)
  const seen = await assess(run, entry)
  const verdict = judge(seen)
  if (!verdict.remove) {
    const kept = { ...entry, keptBecause: verdict.reason }
    await save($, kept)
    return { entry: kept, removed: false, reason: verdict.reason }
  }
  const failed = await removeWorktree(run, entry, { deleteBranch: seen.unmerged.length === 0 })
  if (failed !== undefined) {
    const kept = { ...entry, keptBecause: failed }
    await save($, kept)
    return { entry: kept, removed: false, reason: failed }
  }
  await drop($, entry)
  return { entry, removed: true }
}

// Settles every entry whose session is over (or long dead); a live session's worktree is never touched.
async function sweep($: EngineInterface): Promise<Outcome[]> {
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  const done: Outcome[] = []
  for (const entry of await entries($)) {
    if (isSweepable(entry, now, cwd)) done.push(await settle($, entry))
  }
  return done
}

const describe = (o: Outcome & { removed: false }) => `${label(o.entry)} (${o.reason})`

// What a call to `start` came to, and what the model reads about it.
type Entered =
  | { outcome: 'entered'; path: string; text: string }
  // Nothing to make: not a repository, or already in a worktree. The directory is fine to change files in.
  | { outcome: 'stays'; cwd: string; text: string }
  | { outcome: 'failed'; text: string }
  | { outcome: 'off'; text: string }

// Moves the session into a worktree named for the task it is about to do.
async function enter($: EngineInterface, task: string): Promise<Entered> {
  const run = runner($)
  const cwd = await $.session.cwd()
  const repo = await repoOf(run, cwd)
  if (repo === undefined) {
    return { outcome: 'stays', cwd, text: 'This directory is not in a git repository, so there is no worktree to make. Carry on here.' }
  }
  if (repo.isLinked) {
    return { outcome: 'stays', cwd, text: `This session is already in a git worktree, ${cwd}. Carry on here.` }
  }

  const id = (await $.session.id()).replace(/-/g, '').slice(0, 4)
  const name = worktreeName(task, id)
  const path = `${repo.root}/.claude/worktrees/${name}`
  const branch = `wt/${name}`
  const base = await chooseBase(run, repo.root)
  const baseSha = (await run(['git', 'rev-parse', base], repo.root)).stdout.trim() || undefined
  const entry: Entry = {
    sessionId: await $.session.id(),
    repo: repo.root,
    path,
    branch,
    base,
    baseSha,
    createdAt: await $.clock.now(),
  }

  // The record comes first: a crash between here and the end leaves something a sweep can find.
  await save($, entry)

  try {
    // Keep the folder out of `git status` in the main checkout. Local to this clone; nothing is committed.
    const exclude = `${repo.root}/.git/info/exclude`
    const current = (await $.fs.exists(exclude)) ? await $.fs.read(exclude) : ''
    if (!current.split('\n').some(line => line.trim() === EXCLUDE_LINE)) await $.fs.write(exclude, withExclude(current))
  } catch {
    // A repository whose .git is not a folder: the worktree still works, git status is just noisier.
  }

  const failed = await addWorktree(run, repo.root, path, branch, base)
  if (failed !== undefined) {
    await drop($, entry)
    const why = failed.split('\n')[0]
    $.ui.toast(`worktrees: could not make a worktree, working in the main checkout. ${why}`)
    return { outcome: 'failed', text: `Could not make a worktree (${why}). Carry on in the main checkout.` }
  }

  const moved = await $.tool.call({ tool: 'EnterWorktree', path })
  if (moved.deny !== undefined || moved.isError === true) {
    await removeWorktree(run, entry, { deleteBranch: true })
    await drop($, entry)
    $.ui.toast('worktrees: could not move into the worktree, working in the main checkout.')
    return { outcome: 'failed', text: 'Could not move into the worktree. Carry on in the main checkout.' }
  }

  // The model read the main checkout before this move; say where the tree it now stands in is not that checkout.
  const unlike = differences({ ...(await checkoutState(run, repo.root)), base, baseSha })
  $.ui.toast(`worktrees: working in ${branch}, cut from ${base}${unlike.length > 0 ? '; your checkout differs, and Claude was told' : ''}`)
  return {
    outcome: 'entered',
    path,
    text: [
      `Moved into the git worktree ${path}, on branch ${branch}, cut from ${base}.`,
      `The working directory is now ${path}; the main checkout at ${repo.root} refuses writes, so use paths under the worktree.`,
      'Read a file again at its new path before you edit it.',
      ...unlike,
    ].join(' '),
  }
}

// What `start` does: the worktree, unless the toggle is off or nobody is at the prompt.
async function begin($: EngineInterface, task: string, interactive: boolean): Promise<Entered> {
  if (!interactive || !(await isOn($))) {
    return { outcome: 'off', text: 'Worktrees are off, so the session stays in this checkout. Carry on.' }
  }
  return enter($, task).catch(
    (): Entered => ({ outcome: 'failed', text: 'The worktree could not be made. Carry on in the main checkout.' }),
  )
}

// After a turn: once the work in this session's worktree has been merged and nothing is left in the tree,
// steps the session back out to the main checkout and removes the worktree. Resolves to the note the
// model reads with the next prompt, or undefined when the session stays.
async function leaveIfMerged($: EngineInterface): Promise<string | undefined> {
  const run = runner($)
  const id = await $.session.id()
  const cwd = await $.session.cwd()
  const entry = (await entries($)).find(entry => entry.sessionId === id && isInside(cwd, entry.path))
  if (entry === undefined) return undefined

  // No commit yet: a fresh worktree is as merged as main itself, and the task has only begun.
  const head = (await run(['git', 'rev-parse', 'HEAD'], entry.path)).stdout.trim()
  if (!hasWork(head, entry.baseSha)) return undefined

  const seen = await assess(run, entry)
  if (!seen.exists || !judge(seen).remove) return undefined

  const left = await $.tool.call({ tool: 'ExitWorktree', action: 'keep' })
  if (left.deny !== undefined || left.isError === true) return undefined

  const failed = await removeWorktree(run, entry, { deleteBranch: true })
  if (failed !== undefined) {
    await save($, { ...entry, endedAt: await $.clock.now(), keptBecause: failed })
    return undefined
  }
  await drop($, entry)
  $.ui.toast(`worktrees: ${entry.branch} is merged, so the worktree is removed and you are back on the main checkout`)
  return `The worktrees plugin removed the worktree ${entry.path}, because its branch is merged. The working directory is back at ${entry.repo}.`
}

export const register: Register = on => {
  // Whether a person is at the prompt: a headless run is never moved into a worktree.
  let interactive = false
  // What the model reads with the next prompt after the session stepped out of a merged worktree.
  let left: string | undefined
  // The directory the session was last found fit to change files in: in a worktree, or with none to make.
  // Any other directory is looked at again, which is how a step back out to main brings the net back.
  let settled: string | undefined
  // Set when a worktree could not be made: the net steps aside rather than refuse every change.
  let blocked = false
  // A `start` in flight; a change that arrives beside it waits for the answer.
  let starting: Promise<unknown> | undefined

  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive
    await $.command.register({
      name: 'worktrees',
      description: 'Work in a git worktree of its own: on, off, status, clean, discard NAME.',
      argumentHint: '[on|off|status|clean|discard NAME]',
    })
    // A headless run is never moved, so the model is not offered the tool.
    if (e.isInteractive && (await isOn($))) await $.tool.register(START_SPEC)
    try {
      // A session resumed inside a worktree this mod made takes it over again.
      for (const entry of await entries($)) {
        if (isInside(e.cwd, entry.path)) {
          await save($, { ...entry, sessionId: await $.session.id(), endedAt: undefined, keptBecause: undefined })
        }
      }
      await sweep($)
      const repo = await repoOf(runner($), e.cwd)
      const mine = (await entries($)).filter(
        entry => entry.keptBecause !== undefined && repo !== undefined && entry.repo === repo.root,
      )
      if (mine.length > 0) {
        $.ui.toast(
          `worktrees: ${mine.length} left with work in them: ${mine.map(entry => `${label(entry)} (${entry.keptBecause})`).join(', ')}. /worktrees status`,
        )
      }
    } catch {
      // Cleanup is never a reason to fail a session's start.
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isUsers = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (interactive && isUsers && !e.isMeta) {
      // A /clear gives the session a new id and fires no session.start: the worktree it sits in is its own still.
      const cwd = await $.session.cwd()
      const id = await $.session.id()
      const mine = (await entries($)).find(entry => isInside(cwd, entry.path) && entry.sessionId !== id)
      if (mine !== undefined) await save($, { ...mine, sessionId: id, endedAt: undefined, keptBecause: undefined })
    }
    if (!interactive || !isUsers || e.command || e.isMeta || e.turnId !== undefined) return next(e)
    const note = left
    left = undefined
    return next(note === undefined ? e : { ...e, context: [...(e.context ?? []), note] })
  })

  // The model begins a task: the worktree is made now, named for the task, with the files read.
  on('tool.call', { tool: START_PATTERN }, ($, e) => {
    // The tool is the mod's own, so the engine's types do not know its input.
    const task = (e as { name?: unknown }).name
    // A call the model makes on purpose tries again after a failure.
    blocked = false
    const attempt = begin($, typeof task === 'string' ? task : '', interactive).then(found => {
      // Settled before anyone waiting on this wakes, so a change beside it sees the answer.
      if (found.outcome === 'entered') settled = found.path
      else if (found.outcome === 'stays') settled = found.cwd
      else if (found.outcome === 'failed') blocked = true
      return found
    })
    // Set at once, not after the first await: a change called beside this one must find it.
    starting = attempt
    return attempt
      .then(found => ({ result: found.text }))
      .finally(() => {
        if (starting === attempt) starting = undefined
      })
  })

  // A change before `start` is refused once; the model reads why, calls `start`, and repeats it.
  on('tool.check', async ($, e, next) => {
    if (!interactive || blocked || !needsWorktree(e)) return next(e)
    if (starting !== undefined) await starting
    if (blocked || !(await isOn($))) return next(e)
    const cwd = await $.session.cwd()
    if (cwd === settled) return next(e)
    const repo = await repoOf(runner($), cwd)
    if (repo === undefined || repo.isLinked) {
      settled = cwd
      return next(e)
    }
    return { decision: 'deny', reason: REFUSAL }
  }).catch((_, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // The main loop's turns only; a subagent finishing says nothing about the task.
    if (interactive && e.agentId === undefined && e.reason === 'answer') {
      try {
        const note = await leaveIfMerged($)
        if (note !== undefined) {
          left = note
          // The next task begins with a `start` of its own.
          settled = undefined
        }
      } catch {
        // Stepping out is a courtesy; session end and the next start clean up all the same.
      }
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear or a resume goes on in the same directory, and no session.start follows.
    if (e.reason !== 'clear' && e.reason !== 'resume') {
      try {
        // By id, not by directory: the engine has taken the session back out of the worktree by now.
        const entry = (await entries($)).find(entry => entry.sessionId === e.sessionId)
        if (entry !== undefined) {
          // Marked ended first: if the time runs out, the next session's sweep finishes it.
          const ended = { ...entry, endedAt: await $.clock.now() }
          await save($, ended)
          await settle($, ended)
        }
      } catch {
        // The sweep at the next start finishes what this could not.
      }
    }
    return next(e)
  })

  on('command.run', { command: 'worktrees' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const cwd = await $.session.cwd()
    const here = (await entries($)).find(entry => isInside(cwd, entry.path))

    if (verb === 'on' || (verb === '' && !(await isOn($)))) {
      await $.store.set(ENABLED, true)
      blocked = false
      if (interactive) await $.tool.register(START_SPEC)
      return {
        text: here
          ? `Worktrees on. This session is already in ${label(here)}; each new task gets its own.`
          : 'Worktrees on. When Claude first has a change to make, it moves this session into a worktree named for the task, cut from main.',
      }
    }
    if (verb === 'off' || verb === '') {
      await $.store.set(ENABLED, false)
      return {
        text: here
          ? `Worktrees off. This session stays in ${label(here)} and is cleaned up when it ends.`
          : 'Worktrees off. Sessions start in the checkout they were opened in.',
      }
    }
    if (verb === 'status') {
      const now = await $.clock.now()
      const all = await entries($)
      const lines = [`Worktrees ${(await isOn($)) ? 'on' : 'off'}.`]
      if (here) lines.push(`This session: ${here.branch} in ${here.path}, cut from ${here.base}.`)
      const rest = all.filter(entry => entry !== here && entry.path !== here?.path)
      for (const entry of rest) {
        const state = entry.keptBecause ?? (entry.endedAt === undefined ? 'in use' : 'ended, not yet cleaned')
        lines.push(`${label(entry)}  ${state}  ${ago(entry.createdAt, now)} old  ${entry.path}`)
      }
      if (rest.length === 0) lines.push('No other worktrees are being tracked.')
      return { text: lines.join('\n') }
    }
    if (verb === 'clean') {
      const done = await sweep($)
      if (done.length === 0) return { text: 'Nothing to clean: no ended session has a worktree waiting.' }
      const gone = done.filter(o => o.removed)
      const left = done.filter((o): o is Outcome & { removed: false } => !o.removed)
      return {
        text: [
          `Removed ${gone.length}${gone.length > 0 ? `: ${gone.map(o => label(o.entry)).join(', ')}` : ''}.`,
          ...(left.length > 0 ? [`Left ${left.length}: ${left.map(describe).join(', ')}.`] : []),
        ].join('\n'),
      }
    }
    if (verb === 'discard') {
      const needle = rest.join(' ')
      const now = await $.clock.now()
      const hits = (await entries($)).filter(
        entry => needle !== '' && entry.path.includes(needle) && isSweepable(entry, now, cwd),
      )
      if (hits.length !== 1) {
        return {
          text:
            hits.length === 0
              ? 'No ended worktree matches. /worktrees status lists them; a session that is still running is not discarded.'
              : `More than one matches: ${hits.map(label).join(', ')}. Name one.`,
        }
      }
      const entry = hits[0]!
      const failed = await removeWorktree(runner($), entry, { force: true, deleteBranch: true })
      if (failed !== undefined) return { text: `Could not remove ${label(entry)}: ${failed}` }
      await drop($, entry)
      return { text: `Discarded ${label(entry)}, its changes and its branch.` }
    }
    return { text: 'Usage: /worktrees [on|off|status|clean|discard NAME]. With no word it toggles.' }
  })
}
