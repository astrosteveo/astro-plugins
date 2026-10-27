// The decisions the worktrees mod makes, as plain functions of plain values.

// One worktree the mod made, kept in the store under `wt:<id>` until it is removed.
export type Entry = {
  // The session that entered it; a /clear leaves this stale, so a session is also found by its directory.
  sessionId: string
  // The main working tree's root, where git is run to remove it.
  repo: string
  path: string
  branch: string
  // The ref the branch was cut from, for the status text.
  base: string
  // The commit the branch was cut at: a HEAD that has moved past it means the session committed work.
  baseSha?: string
  createdAt: number
  // Set first when the session ends, before any removal is tried.
  endedAt?: number
  // Why the last sweep left it on disk.
  keptBecause?: string
}

// A session that never marked its end (a crash, a kill) is taken for dead after this long.
export const STALE_MS = 7 * 24 * 60 * 60 * 1000

export const PREFIX = 'wt:'
export const entryKey = (path: string) => PREFIX + path

// The first words of the prompt as a branch-safe slug; `task` when it has none.
export function slug(text: string, max = 28): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // Cut on a word: a name ending mid-word reads as a typo.
  const atWord = words.length > max && words[max] !== '-' && words.slice(0, max).includes('-')
  const cut = (atWord ? words.slice(0, words.slice(0, max).lastIndexOf('-')) : words.slice(0, max)).replace(/-+$/g, '')
  return cut === '' ? 'task' : cut
}

// `fix-the-login-bug-3f9a`: the slug and a short id that keeps two sessions apart.
export const worktreeName = (text: string, id: string) => `${slug(text)}-${id}`

export const isDirty = (porcelain: string) => porcelain.split('\n').some(line => line.trim() !== '')

export type Verdict = { remove: true } | { remove: false; reason: string }

export type Assessment = {
  // Whether the directory is still a worktree git knows.
  exists: boolean
  dirty: boolean
  // The refs holding commits that no default branch has.
  unmerged: readonly string[]
}

// A worktree goes only when nothing in it would be lost: no change on disk, no commit the default branch lacks.
export function judge(a: Assessment): Verdict {
  if (!a.exists) return { remove: true }
  if (a.dirty) return { remove: false, reason: 'uncommitted changes' }
  if (a.unmerged.length > 0) return { remove: false, reason: `commits not in main (${a.unmerged.join(', ')})` }
  return { remove: true }
}

// Whether the session has committed since it entered. A fresh worktree is as merged as `main` itself,
// so "merged" means something only once there is work to merge.
export const hasWork = (head: string, baseSha: string | undefined) =>
  baseSha !== undefined && head !== '' && head !== baseSha

// The built-in tools that change a file whatever their input.
export const FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit'])

// Whether a tool call is the session's first change, so that it waits for a worktree. The engine's own word
// that a command only reads decides Bash; a subagent's command is let through, since an explorer pipes and
// chains and has no business naming a task. Only a real call counts, not another plugin's query.
export function needsWorktree(call: { tool: string; isReadOnly?: boolean; agentId?: string; tool_use_id?: string }) {
  if (call.tool_use_id === undefined) return false
  if (FILE_TOOLS.has(call.tool)) return true
  return call.tool === 'Bash' && call.agentId === undefined && call.isReadOnly !== true
}

// How the main checkout differs from the tree the session now works in. The model read the checkout before the
// move, so each difference is a reason to read a file again before editing it.
export function differences(i: {
  branch: string
  sha: string
  hasChanges: boolean
  base: string
  baseSha: string | undefined
}): string[] {
  const found: string[] = []
  if (i.baseSha !== undefined && i.sha !== '' && i.sha !== i.baseSha) {
    found.push(`The main checkout is on ${i.branch === '' ? 'a detached HEAD' : i.branch}, a different commit from ${i.base}, where the worktree was cut.`)
  }
  if (i.hasChanges) found.push('The main checkout has uncommitted changes, which the worktree does not have.')
  return found
}

// The path is inside `dir`, or is it.
export const isInside = (path: string, dir: string) => path === dir || path.startsWith(dir + '/')

// Whether a sweep may look at this entry: its session ended, or it is old enough to have crashed.
// The directory the session is in now is never swept.
export function isSweepable(entry: Entry, now: number, cwd: string): boolean {
  if (isInside(cwd, entry.path)) return false
  return entry.endedAt !== undefined || now - entry.createdAt > STALE_MS
}

// The base to cut from: origin's default branch when it is ahead of (or the only copy of) the local one;
// the local one when it holds commits origin lacks; `HEAD` when the repository has neither.
export function pickBase(i: {
  defaultBranch: string | undefined
  hasLocal: boolean
  hasRemote: boolean
  localIsBehindRemote: boolean
}): string {
  const d = i.defaultBranch
  if (d === undefined) return 'HEAD'
  if (i.hasRemote && (!i.hasLocal || i.localIsBehindRemote)) return `origin/${d}`
  return i.hasLocal ? d : 'HEAD'
}

// `a/b/` or `a/b` as the one form; git prints neither with a trailing slash, a user may type one.
export const trimSlash = (path: string) => path.replace(/\/+$/, '')

export const EXCLUDE_LINE = '/.claude/worktrees/'

// The text of .git/info/exclude with the worktrees folder added; unchanged when it is there.
export function withExclude(text: string): string {
  if (text.split('\n').some(line => line.trim() === EXCLUDE_LINE)) return text
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${EXCLUDE_LINE}\n`
}

export const ago = (from: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - from) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}
