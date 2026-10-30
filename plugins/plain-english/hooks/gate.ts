// The prose a tool call publishes. A file Claude writes and a pull request opened through a tool
// carry their text as given, so they are checked before the call runs. A shell command's prose is
// read back once the command has run (the commit's message, the pull request's title and body), so
// no guess about what the shell will do is needed.

// A piece of prose a call carries: what it is, for the refusal, and its text, or `file`, an absolute
// path the text is read from (`gh pr create --body-file`). `before` is the text a write replaces,
// whose Claudisms are not the write's to answer for; `beforeFile` names a file that holds it. `edit`
// is an Edit's change, applied to that file's text where it can be read.
export type Piece = {
  what: string
  text?: string
  file?: string
  before?: string
  beforeFile?: string
  edit?: { old: string; new: string; all: boolean }
}

// Files of prose: Markdown and its kin, and the usual capitalised docs, bare or as .txt. Test
// folders within the project are left alone, since their texts may hold Claudisms on purpose.
const PROSE_FILE = /\.(?:md|mdx|markdown|rst|adoc)$|(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|NOTES|HISTORY)(?:\.txt)?$/i
const TEST_FOLDER = /(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__|testdata|snapshots?|__snapshots__)\//i

export const isProseFile = (path: string) => PROSE_FILE.test(path)

// Whether a file sits in a test folder of its project. Only the part of the path below the
// project's root is looked at, so a project that itself sits under a folder named tests is still
// checked.
export function isTestPath(path: string, root: string) {
  const top = root.replace(/\/$/, '')
  return TEST_FOLDER.test(path.startsWith(`${top}/`) ? path.slice(top.length + 1) : path)
}

// An absolute path: `~` is the home folder, a relative path is under `dir`, and `.` and `..` are
// resolved.
export function resolvePath(dir: string, path: string, home?: string) {
  const full = path === '~' || path.startsWith('~/') ? `${home ?? '~'}${path.slice(1)}` : path.startsWith('/') ? path : `${dir}/${path}`
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

// The prose of a `gh pr` or `gh issue` create, edit or comment, from its arguments as given: its
// title, body and body file. `argv` starts at `gh`.
export function gh(argv: readonly string[], dir: string, stdin?: string): Piece[] {
  if (!['pr', 'issue'].includes(argv[1] ?? '') || !['create', 'edit', 'comment'].includes(argv[2] ?? '')) return []
  const kind = argv[1] === 'issue' ? 'issue' : 'pull request'
  const body = `the ${kind} ${argv[2] === 'comment' ? 'comment' : 'body'}`
  const pieces: Piece[] = []
  for (let i = 3; i < argv.length; i++) {
    const w = argv[i]!
    // `--title x`, `--title=x`, `-t x` and `-tx`.
    const long = /^(--[\w-]+)(?:=([\s\S]*))?$/.exec(w)
    const short = /^(-[a-zA-Z])([\s\S]*)$/.exec(w)
    const name = long?.[1] ?? short?.[1]
    if (name === undefined) continue
    // A short flag's value may follow it directly or after `=`, as gh's flag parser takes it.
    const attached = long !== null ? long[2] : short![2] === '' ? undefined : short![2]!.replace(/^=/, '')
    const value = () => attached ?? argv[++i]
    if (name === '-t' || name === '--title') {
      const text = value()
      if (text !== undefined) pieces.push({ what: `the ${kind} title`, text })
    } else if (name === '-b' || name === '--body') {
      const text = value()
      if (text !== undefined) pieces.push({ what: body, text })
    } else if (name === '-F' || name === '--body-file') {
      const file = value()
      if (file === '-') {
        if (stdin !== undefined) pieces.push({ what: body, text: stdin })
      } else if (file !== undefined) pieces.push({ what: body, file: resolvePath(dir, file) })
    }
  }
  return pieces.filter(p => p.file !== undefined || (p.text ?? '').trim() !== '')
}

// The prose a call carries before it runs, by tool. An MCP tool that opens a pull request or issue
// is matched by its `title` and `body` fields. A shell command carries none: what it published is
// read back after it runs (`published`).
export function pieces(tool: string, input: Record<string, unknown>, cwd: string, home?: string): Piece[] {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  if (tool === 'Write' || tool === 'Edit') {
    const path = resolvePath(cwd, str('file_path') ?? '', home)
    if (!isProseFile(path)) return []
    if (tool === 'Write') return [{ what: path, text: str('content') ?? '', beforeFile: path }]
    const old = str('old_string') ?? ''
    const text = str('new_string') ?? ''
    return [{ what: path, text, before: old, beforeFile: path, edit: { old, new: text, all: input.replace_all === true } }]
  }
  if (tool.startsWith('mcp__') && /pull_?request|_pr\b|issue/i.test(tool)) {
    const kind = /issue/i.test(tool) ? 'issue' : 'pull request'
    const out: Piece[] = []
    const title = str('title')
    const body = str('body')
    if (title !== undefined && title.trim() !== '') out.push({ what: `the ${kind} title`, text: title })
    if (body !== undefined && body.trim() !== '') out.push({ what: `the ${kind} body`, text: body })
    return out
  }
  return []
}

// Something a shell command published, found in its output: a commit, by its hash, or a pull
// request, issue or comment, by its URL on whatever host gh uses.
export type Published =
  | { kind: 'commit'; sha: string }
  | { kind: 'pr' | 'issue'; url: string }
  | { kind: 'comment'; url: string; host: string; repo: string; id: string }

// git prints `[branch abc1234] subject` for each commit it makes, unless told to be quiet; the
// session's own repository is compared before and after as well (`commitsBetween`). gh prints the
// URL of what it made as its last line, and only what `create` or `comment` made is Claude's own
// text: an `edit` may touch someone else's pull request. The command is only looked at for the
// words that say it can publish, never parsed.
export function published(command: string, output: string): Published[] {
  const found: Published[] = []
  if (/\bgit\b/.test(command) && /\bcommit\b/.test(command))
    for (const m of output.matchAll(/^\[[^\]\n]*? ([0-9a-f]{7,40})\] /gm)) found.push({ kind: 'commit', sha: m[1]! })
  if (/\bgh\b/.test(command) && /\b(?:pr|issue)\b/.test(command) && /\b(?:create|comment)\b/.test(command)) {
    const last = output.trimEnd().split('\n').at(-1)?.trim() ?? ''
    const m = /^https:\/\/([\w.-]+)\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/\d+(?:#issuecomment-(\d+))?$/.exec(last)
    if (m !== null)
      found.push(m[4] !== undefined ? { kind: 'comment', url: m[0], host: m[1]!, repo: m[2]!, id: m[4] } : { kind: m[3] === 'pull' ? 'pr' : 'issue', url: m[0] })
  }
  return found
}

// The directories a command may have made its commit in, after the session's own: each `cd` taken
// from the one before it, and each `git -C`. A quoted path may hold spaces.
export function directories(command: string, cwd: string, home?: string): string[] {
  const dirs = [cwd]
  let here = cwd
  for (const m of command.matchAll(/\b(cd|git\s+-C)\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/g)) {
    const dir = resolvePath(here, m[2] ?? m[3] ?? m[4]!, home)
    if (m[1] === 'cd') here = dir
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

// The refspec's source of a `git push`: what it sends, `HEAD` when none is named.
export function pushedRef(argv: readonly string[]): string {
  const args = argv.slice(argv.indexOf('push') + 1).filter(a => !a.startsWith('-'))
  const spec = args[1]
  if (spec === undefined) return 'HEAD'
  const source = spec.replace(/^\+/, '').split(':')[0]!
  return source === '' ? 'HEAD' : source
}
