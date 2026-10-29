import type { EngineInterface } from 'claude-code'

export type Ran = { ok: boolean; out: string; err: string }
export type Git = (args: readonly string[]) => Promise<Ran>

const why = (error: unknown) => (error instanceof Error ? error.message : String(error))

// git in one folder. A git that cannot start reads as a failed run, so callers handle one shape.
export function gitIn($: EngineInterface, cwd: string): Git {
  return async args => {
    try {
      const ran = await $.process.run(['git', '-c', 'core.quotePath=false', ...args], { cwd, timeoutMs: 60_000 })
      return { ok: ran.exitCode === 0, out: ran.stdout, err: ran.stderr.trim() }
    } catch (error) {
      return { ok: false, out: '', err: why(error) }
    }
  }
}

export const short = (sha: string) => sha.slice(0, 7)

// What a read gives, or a throw saying what git could not do: an empty answer from a failed run
// would read as nothing to review.
function must(ran: Ran, what: string) {
  if (!ran.ok) throw new Error(`git could not ${what}: ${ran.err || 'it failed'}`)
  return ran.out
}

/** Where a repository stands: what a review compares and where its record is kept. */
export type Place = {
  root: string
  git: Git
  /** The folder the branches' review records live in, inside the repository's git folder. */
  store: string
  /** The checked-out branch; empty when HEAD is detached. */
  branch: string
  head: string
  /** The default branch's name, such as main; empty when there is none. */
  main: string
  /** What the branch is compared against: origin's copy of the default branch, else the local one. */
  mainRef: string
  /** The commit the branch forked from the default branch at; empty when there is none. */
  base: string
  /** Commits on the branch past its base. */
  ahead: number
}

// The default branch: the one origin's HEAD names where the clone knows it, else the first of the
// usual names that exists here or on origin.
async function defaultBranch(git: Git) {
  const remote = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (remote.ok && remote.out.trim().startsWith('origin/')) return remote.out.trim().slice('origin/'.length)
  for (const name of ['main', 'master', 'trunk']) {
    const [local, onOrigin] = await Promise.all([
      git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]),
      git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]),
    ])
    if (local.ok || onOrigin.ok) return name
  }
  return ''
}

// What a pull request compares against: origin's copy of the default branch where there is one,
// since that is what the pull request merges into, else the local one.
async function mainRef(git: Git, main: string) {
  if (main === '') return ''
  if ((await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${main}`])).ok) return `origin/${main}`
  return (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${main}`])).ok ? main : ''
}

/** The repository `cwd` is in, or why there is none to review. */
export async function locate($: EngineInterface, cwd: string): Promise<Place | string> {
  const top = await gitIn($, cwd)(['rev-parse', '--show-toplevel'])
  if (!top.ok) return `${cwd} is not in a git repository.`
  const root = top.out.trim()
  const git = gitIn($, root)
  const [common, head, branch] = await Promise.all([
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    git(['rev-parse', '--verify', '--quiet', 'HEAD']),
    git(['symbolic-ref', '--quiet', '--short', 'HEAD']),
  ])
  if (!head.ok) return `${root} has no commits yet.`
  if (!common.ok) return `git could not say where ${root} keeps its data: ${common.err}`
  const main = await defaultBranch(git)
  const ref = await mainRef(git, main)
  const fork = ref === '' ? undefined : await git(['merge-base', 'HEAD', ref])
  const base = fork?.ok === true ? fork.out.trim() : ''
  const count = base === '' ? undefined : await git(['rev-list', '--count', `${base}..HEAD`])
  return {
    root,
    git,
    store: `${common.out.trim()}/review-gate`,
    branch: branch.ok ? branch.out.trim() : '',
    head: head.out.trim(),
    main,
    mainRef: ref,
    base,
    ahead: count?.ok === true ? Number(count.out.trim()) || 0 : 0,
  }
}

/** Tracked files with changes no commit holds yet. */
export async function uncommitted(git: Git) {
  const out = must(await git(['status', '--porcelain', '--untracked-files=no', '-z']), 'read the working tree')
  return out
    .split('\0')
    .filter(entry => entry.length > 3)
    .map(entry => entry.slice(3))
}

/** The files a diff from `from` to `to` touches, deleted ones included. */
export async function changedFiles(git: Git, from: string, to: string) {
  const out = must(await git(['diff', '--name-only', '--no-renames', '--no-ext-diff', '-z', from, to]), 'list the changed files')
  return out.split('\0').filter(path => path !== '')
}

/**
 * The lines of each file at `to` that the diff from `from` added or changed, as ranges: a hunk's
 * `+c,d` is lines c to c+d-1.
 */
export async function changedLines(git: Git, from: string, to: string) {
  const out = must(await git(['diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', from, to]), 'read the changed lines')
  const lines = new Map<string, [number, number][]>()
  let file = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? '' : line.slice(4).replace(/\t$/, '').replace(/^b\//, '')
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk === null || file === '') continue
    const start = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    if (count > 0) lines.set(file, [...(lines.get(file) ?? []), [start, start + count - 1]])
  }
  return lines
}

export const inRanges = (ranges: readonly [number, number][] | undefined, line: number) =>
  ranges?.some(([first, last]) => line >= first && line <= last) === true

/**
 * The diff from `from` to `to`, as a stat and as patches with some context, leaving out what the
 * pathspecs `excludes` name. No file is named on the command line, so no change is too big for it.
 */
export async function diffOf(git: Git, from: string, to: string, excludes: readonly string[]) {
  const paths = excludes.length === 0 ? [] : ['--', '.', ...excludes]
  const [stat, body] = await Promise.all([
    git(['diff', '--stat=160', '--no-renames', '--no-ext-diff', from, to, ...paths]),
    git(['diff', '--no-renames', '--no-color', '--no-ext-diff', '--unified=5', from, to, ...paths]),
  ])
  return { stat: must(stat, 'read the diff').trimEnd(), body: must(body, 'read the diff') }
}

/** The branch's commits, oldest first: each one's short id, subject and body. */
export async function commitLog(git: Git, from: string, to: string) {
  const out = must(await git(['log', '--reverse', '--no-merges', '--format=%h %s%n%b%x00', `${from}..${to}`]), 'read the commits')
  return out
    .split('\0')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
    .join('\n\n')
}

export async function isAncestor(git: Git, older: string, newer: string) {
  return (await git(['merge-base', '--is-ancestor', older, newer])).ok
}

/**
 * The REVIEW.md files that speak for the files given: the root's, and one in any folder above a
 * changed file, as they are at `at`. A round reads them at the branch's base, so a branch cannot
 * loosen its own review.
 */
export async function guideFiles(git: Git, at: string, files: readonly string[]) {
  const folders = new Set([''])
  for (const file of files) {
    const parts = file.split('/').slice(0, -1)
    for (let depth = 1; depth <= parts.length; depth++) folders.add(parts.slice(0, depth).join('/'))
  }
  // One listing of the tree, filtered here: no folder goes on the command line, however many change.
  const listed = must(await git(['ls-tree', '-r', '--name-only', '-z', at]), 'list the REVIEW.md files')
  const found = listed.split('\0').filter(path => {
    const slash = path.lastIndexOf('/')
    return path.slice(slash + 1) === 'REVIEW.md' && folders.has(slash < 0 ? '' : path.slice(0, slash))
  })
  const read = await Promise.all(found.map(async path => ({ path, text: must(await git(['show', `${at}:${path}`]), `read ${path}`) })))
  return read.filter(file => file.text.trim() !== '')
}

/**
 * Who began a branch, and when: the author and date of its first commit past `from`. A rebase or
 * an amend keeps them, and another branch under the same name has its own.
 */
export async function firstCommit(git: Git, from: string, to: string) {
  const out = must(await git(['log', '--reverse', '--format=%aI %ae', `${from}..${to}`]), 'read the branch\'s first commit')
  return out.split('\n')[0]?.trim() ?? ''
}

/** The repository's local branches, by name. */
export async function branches(git: Git) {
  const out = must(await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']), 'list the branches')
  return new Set(out.split('\n').filter(name => name !== ''))
}
