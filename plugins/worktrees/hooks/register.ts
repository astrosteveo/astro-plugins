import type { EngineInterface, Register } from 'claude-code'
import { addWorktree, assess, chooseBase, removeWorktree, repoOf } from './git'
import type { Run } from './git'
import {
  PREFIX,
  EXCLUDE_LINE,
  ago,
  entryKey,
  isInside,
  isSweepable,
  judge,
  withExclude,
  worktreeName,
} from './worktrees'
import type { Entry } from './worktrees'

const ENABLED = 'enabled'

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

// Moves the session into a worktree of its own. Resolves to the note the model reads with the prompt,
// or undefined when the session stays where it is.
async function enter($: EngineInterface, text: string): Promise<string | undefined> {
  const run = runner($)
  const cwd = await $.session.cwd()
  const repo = await repoOf(run, cwd)
  if (repo === undefined || repo.isLinked) return undefined

  const id = (await $.session.id()).replace(/-/g, '').slice(0, 4)
  const name = worktreeName(text, id)
  const path = `${repo.root}/.claude/worktrees/${name}`
  const branch = `wt/${name}`
  const base = await chooseBase(run, repo.root)
  const entry: Entry = { sessionId: await $.session.id(), repo: repo.root, path, branch, base, createdAt: await $.clock.now() }

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
    $.ui.toast(`worktrees: could not make a worktree, working in the main checkout. ${failed.split('\n')[0]}`)
    return undefined
  }

  const moved = await $.tool.call({ tool: 'EnterWorktree', path })
  if (moved.deny !== undefined || moved.isError === true) {
    await removeWorktree(run, entry, { deleteBranch: true })
    await drop($, entry)
    $.ui.toast('worktrees: could not move into the worktree, working in the main checkout.')
    return undefined
  }
  $.ui.toast(`worktrees: working in ${branch}, cut from ${base}`)
  // The model's first look at the directory was taken before the move; without this it writes to the old path.
  return `The worktrees plugin has just moved this session into a git worktree. The working directory is now ${path}, on branch ${branch}. Use paths under it. The main checkout at ${repo.root} refuses writes.`
}

export const register: Register = on => {
  // Whether a person is at the prompt: a headless run is never moved into a worktree.
  let interactive = false
  // The prompt that turned the toggle on or the first after it tries once; a failure is not retried each prompt.
  let tried = false

  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive
    await $.command.register({
      name: 'worktrees',
      description: 'Work in a git worktree of its own: on, off, status, clean, discard NAME.',
      argumentHint: '[on|off|status|clean|discard NAME]',
    })
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
    if (!interactive || !isUsers || e.command || e.isMeta || e.turnId !== undefined || tried) return next(e)
    if (!(await isOn($))) return next(e)
    tried = true
    const note = await enter($, e.text)
    return next(note === undefined ? e : { ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => {
    // A broken worktree step never costs the person their prompt.
    $.ui.toast('worktrees: it failed, so this prompt runs in the main checkout.')
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
      tried = false
      return {
        text: here
          ? `Worktrees on. This session is already in ${label(here)}; each new session gets its own.`
          : 'Worktrees on. Your next prompt moves this session into a worktree of its own, cut from main.',
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
