import { type Assessment, type Entry, isDirty, pickBase, trimSlash } from './worktrees'

// `$.process.run`, narrowed to what git needs: argv in, an exit status and text out.
export type Run = (argv: string[], cwd?: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>

const out = (r: { stdout: string }) => r.stdout.trim()

export type Repo = {
  // The main working tree's root: where the worktrees folder lives, whichever checkout the session is in.
  root: string
  // Whether the directory is a linked worktree rather than the main checkout.
  isLinked: boolean
}

// Where `cwd` stands in git, or undefined outside a repository (or in a bare one).
export async function repoOf(run: Run, cwd: string): Promise<Repo | undefined> {
  const r = await run(
    ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
    cwd,
  )
  if (r.exitCode !== 0) return undefined
  const [top, gitDir, common] = r.stdout.split('\n').map(trimSlash)
  if (!top || !gitDir || !common) return undefined
  const isLinked = gitDir !== common
  // A linked worktree's toplevel is its own folder; the main tree is the parent of the common git dir.
  const root = isLinked ? trimSlash(common.replace(/\/\.git$/, '')) : top
  return { root, isLinked }
}

const refExists = async (run: Run, root: string, ref: string) =>
  (await run(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root)).exitCode === 0

// `main`, from origin's HEAD when it has one, else `main` or `master` if either exists locally.
export async function defaultBranch(run: Run, root: string): Promise<string | undefined> {
  const head = await run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root)
  if (head.exitCode === 0 && out(head).startsWith('origin/')) return out(head).slice('origin/'.length)
  for (const name of ['main', 'master']) if (await refExists(run, root, `refs/heads/${name}`)) return name
  return undefined
}

// The ref a new worktree is cut from: the default branch, origin's copy when the local one is behind it.
export async function chooseBase(run: Run, root: string): Promise<string> {
  const d = await defaultBranch(run, root)
  if (d === undefined) return 'HEAD'
  const hasLocal = await refExists(run, root, `refs/heads/${d}`)
  const hasRemote = await refExists(run, root, `refs/remotes/origin/${d}`)
  const localIsBehindRemote =
    hasLocal &&
    hasRemote &&
    (await run(['git', 'merge-base', '--is-ancestor', d, `origin/${d}`], root)).exitCode === 0
  return pickBase({ defaultBranch: d, hasLocal, hasRemote, localIsBehindRemote })
}

// Cuts the worktree. Resolves to an error text, or undefined when it was made.
export async function addWorktree(
  run: Run,
  root: string,
  path: string,
  branch: string,
  base: string,
): Promise<string | undefined> {
  const r = await run(['git', 'worktree', 'add', '-b', branch, path, base], root)
  return r.exitCode === 0 ? undefined : r.stderr.trim() || `git worktree add exited ${r.exitCode}`
}

// What would be lost by removing the worktree.
export async function assess(run: Run, entry: Entry): Promise<Assessment> {
  const listed = await run(['git', 'worktree', 'list', '--porcelain'], entry.repo)
  const exists = listed.exitCode === 0 && listed.stdout.split('\n').includes(`worktree ${entry.path}`)

  let dirty = false
  if (exists) {
    const status = await run(['git', 'status', '--porcelain'], entry.path)
    // A status that fails is not a clean tree: keep what cannot be read.
    dirty = status.exitCode !== 0 || isDirty(status.stdout)
  }

  const d = await defaultBranch(run, entry.repo)
  const homes: string[] = []
  if (d !== undefined) {
    for (const ref of [d, `origin/${d}`]) {
      if (await refExists(run, entry.repo, ref)) homes.push(ref)
    }
  }
  // The worktree's HEAD (it may have switched branch) while it exists, and the branch the mod cut.
  const tips: string[] = exists ? ['HEAD'] : []
  if (await refExists(run, entry.repo, `refs/heads/${entry.branch}`)) tips.push(entry.branch)

  const unmerged: string[] = []
  for (const tip of tips) {
    const cwd = tip === 'HEAD' ? entry.path : entry.repo
    let isHome = false
    for (const home of homes) {
      if ((await run(['git', 'merge-base', '--is-ancestor', tip, home], cwd)).exitCode === 0) isHome = true
    }
    if (!isHome) unmerged.push(tip)
  }
  return { exists, dirty, unmerged }
}

// Removes the worktree, and the branch too when `deleteBranch`. Without `force` git itself refuses a tree
// with changes. Resolves to an error text, or undefined when the worktree is gone.
export async function removeWorktree(
  run: Run,
  entry: Entry,
  opts: { force?: boolean; deleteBranch: boolean },
): Promise<string | undefined> {
  const gone = await run(
    ['git', 'worktree', 'remove', ...(opts.force ? ['--force'] : []), entry.path],
    entry.repo,
  )
  if (gone.exitCode !== 0) {
    const listed = await run(['git', 'worktree', 'list', '--porcelain'], entry.repo)
    // Still on git's list: it refused, and the worktree stays. Off the list (the folder was deleted by
    // hand): prune git's record and go on.
    if (listed.stdout.split('\n').includes(`worktree ${entry.path}`)) {
      return gone.stderr.trim() || `git worktree remove exited ${gone.exitCode}`
    }
    await run(['git', 'worktree', 'prune'], entry.repo)
  }
  if (opts.deleteBranch) await run(['git', 'branch', '-D', entry.branch], entry.repo)
  return undefined
}
