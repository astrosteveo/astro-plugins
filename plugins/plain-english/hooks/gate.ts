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
// checked. A file outside any project has no test folders, so it is always checked.
export function isTestPath(path: string, root?: string) {
  const top = root?.replace(/\/$/, '')
  return top !== undefined && path.startsWith(`${top}/`) && TEST_FOLDER.test(path.slice(top.length + 1))
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

// git and its global options, before a subcommand: `git -C dir -c k=v --no-pager`.
const GIT = String.raw`\bgit((?:\s+(?:-[cC]\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)|--?[\w-]+(?:=[^\s;&|]+)?))*)\s+`

// Whether a command runs `git commit`, the subcommand, not the word.
export const commits = (command: string) => new RegExp(`${GIT}commit\\b`).test(command)

// Whether a command's commit takes its message from an existing one, which is not Claude's text:
// an option of `git commit` itself, not of git before it.
export const reusesMessage = (command: string) =>
  [...command.matchAll(new RegExp(`${GIT}commit\\b([^;&|\\n]*)`, 'g'))].some(m =>
    /(?:^|\s)(?:--no-edit|-[cC]|--reuse-message|--reedit-message)(?=[\s=]|$)/.test(m[2]!),
  )

// git prints `[branch abc1234] subject` for each commit it makes, unless told to be quiet; the
// session's repository is compared before and after as well. gh prints the URL of what it made on
// a line of its own, and only what `create` or `comment` made is Claude's own text: an `edit` may
// touch someone else's pull request. The command is only looked at for the words that say it can
// publish, never parsed.
export function published(command: string, output: string): Published[] {
  const found: Published[] = []
  if (commits(command) && !reusesMessage(command))
    for (const m of output.matchAll(/^\[[^\]\n]*? ([0-9a-f]{7,40})\] /gm)) found.push({ kind: 'commit', sha: m[1]! })
  if (/\bgh\b/.test(command) && /\b(?:pr|issue)\b/.test(command) && /\b(?:create|comment)\b/.test(command)) {
    const urls = [...output.matchAll(/^\s*https:\/\/([\w.-]+)\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/\d+(?:#issuecomment-(\d+))?\s*$/gm)]
    const m = urls.at(-1)
    if (m !== undefined) {
      const url = m[0].trim()
      found.push(m[4] !== undefined ? { kind: 'comment', url, host: m[1]!, repo: m[2]!, id: m[4] } : { kind: m[3] === 'pull' ? 'pr' : 'issue', url })
    }
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

// git push's options that take their value as the next word.
const PUSH_VALUED = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])

// The refspec's source of a `git push`: what it sends, `HEAD` when none is named, or undefined for
// a push that sends no commits (a delete, or tags alone).
export function pushedRef(argv: readonly string[]): string | undefined {
  const words = argv.slice(argv.indexOf('push') + 1)
  const args: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (['--delete', '-d', '--tags', '--prune'].includes(w)) return undefined
    if (PUSH_VALUED.has(w)) i++
    else if (!w.startsWith('-')) args.push(w)
  }
  const spec = args[1]
  if (spec === undefined) return 'HEAD'
  if (spec.startsWith(':')) return undefined
  const source = spec.replace(/^\+/, '').split(':')[0]!
  return source === '' ? 'HEAD' : source
}

const unquote = (w: string) => w.replace(/^(["'])(.*)\1$/, '$2')

// Each `git push` in a shell line: the directory it runs in (its `-C`, else the last `cd` before
// it) and what it sends (undefined when it sends no commits). `push` counts only as git's
// subcommand, so `git stash push` and a message that says push are not pushes.
export function pushes(command: string, cwd: string, home?: string): { dir: string; ref?: string }[] {
  const found: { dir: string; ref?: string }[] = []
  for (const m of command.matchAll(new RegExp(`${GIT}push\\b([^;&|\\n]*)`, 'g'))) {
    let dir = cwd
    for (const c of command.slice(0, m.index).matchAll(/\bcd\s+("[^"]*"|'[^']*'|[^\s;&|]+)/g)) dir = resolvePath(dir, unquote(c[1]!), home)
    for (const c of m[1]!.matchAll(/-C\s+("[^"]*"|'[^']*'|[^\s;&|]+)/g)) dir = resolvePath(dir, unquote(c[1]!), home)
    const args = (m[2]!.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote)
    found.push({ dir, ref: pushedRef(['git', 'push', ...args]) })
  }
  return found
}
