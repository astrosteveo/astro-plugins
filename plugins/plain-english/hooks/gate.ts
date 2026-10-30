// The prose a tool call would publish: a commit message, a pull request's or issue's title and
// body, or a prose file Claude writes. Each is checked before the call runs.

// A piece of prose a call carries: what it is, for the refusal, and its text, or `file`, an absolute
// path the text is read from (`git commit -F`, `gh pr create --body-file`). `before` is the text a
// write replaces, whose Claudisms are not the write's to answer for; `beforeFile` names a file that
// holds it. `edit` is an Edit's change, applied to that file's text where it can be read.
export type Piece = {
  what: string
  text?: string
  file?: string
  before?: string
  beforeFile?: string
  edit?: { old: string; new: string; all: boolean }
}

// Files of prose: Markdown and its kin, and the usual capitalised docs, bare or as .txt. Test
// folders are left alone, since their texts may hold Claudisms on purpose.
const PROSE_FILE = /\.(?:md|mdx|markdown|rst|adoc)$|(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|NOTES|HISTORY)(?:\.txt)?$/i
const TEST_FOLDER = /(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__|testdata|snapshots?|__snapshots__)\//i

export const isProseFile = (path: string) => PROSE_FILE.test(path) && !TEST_FOLDER.test(path)

// One simple command of a shell line: its words, quotes removed; the here-document or here-string
// it reads on stdin; the file a `>` sends its output to; and the command piped into it.
type Command = { words: string[]; stdin?: string; out?: string; from?: Command }

const join = (dir: string, path: string) => (path.startsWith('/') ? path : `${dir.replace(/\/$/, '')}/${path}`)

// A quoted argument that is `$(cat <<'EOF' ... EOF)` is the here-document's body.
const SUBSTITUTED = /^\$\(\s*cat\s*<<-?\s*(['"]?)([\w.-]+)\1[ \t]*\n([\s\S]*?)\n[ \t]*\2\s*\)\s*$/

// The simple commands of a shell line, as far as a hook can tell without running it. A newline,
// `;`, `&`, `|` and parentheses end a command; a here-document's body is read from the lines after
// the one that names it and given to the command that named it.
export function parse(line: string): Command[] {
  const commands: Command[] = []
  let current: Command = { words: [] }
  let word: string | undefined
  let quoted = false
  // What the next word is: an argument, a `>` target, or a here-string.
  let pending: 'out' | 'herestring' | 'in' | undefined
  const heredocs: { command: Command; delim: string; strip: boolean }[] = []
  const endWord = () => {
    if (word === undefined) return
    if (pending === 'out') current.out = word
    else if (pending === 'herestring') current.stdin = word
    else if (pending !== 'in') {
      const sub = quoted ? SUBSTITUTED.exec(word) : null
      current.words.push(sub === null ? word : sub[3]!)
    }
    pending = undefined
    word = undefined
    quoted = false
  }
  const endCommand = (piped: boolean) => {
    endWord()
    const done = current
    if (done.words.length > 0 || done.stdin !== undefined) commands.push(done)
    current = { words: [] }
    if (piped && done.words.length > 0) current.from = done
  }
  const add = (s: string) => (word = (word ?? '') + s)
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      add(line.slice(i + 1, end === -1 ? undefined : end))
      quoted = true
      i = end === -1 ? line.length : end
    } else if (c === '"') {
      let s = ''
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === '\\' && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1]!)) i++
        s += line[i]
      }
      add(s)
      quoted = true
    } else if (c === '\\') {
      if (line[i + 1] === '\n') i++
      else if (i + 1 < line.length) add(line[++i]!)
    } else if (c === '#' && word === undefined) {
      while (i + 1 < line.length && line[i + 1] !== '\n') i++
    } else if (c === '<' && line.startsWith('<<<', i)) {
      endWord()
      pending = 'herestring'
      i += 2
    } else if (c === '<' && line[i + 1] === '<') {
      endWord()
      const m = /^<<(-?)[ \t]*(['"]?)([\w.-]+)\2/.exec(line.slice(i))
      if (m === null) {
        i++
        continue
      }
      heredocs.push({ command: current, delim: m[3]!, strip: m[1] === '-' })
      i += m[0].length - 1
    } else if (c === '<') {
      endWord()
      pending = 'in'
    } else if (c === '>') {
      // `2>`, `>&2` and `2>&1` move a stream and name no file.
      if (word !== undefined && /^\d+$/.test(word) && !quoted) word = undefined
      else endWord()
      if (line[i + 1] === '>') i++
      if (line[i + 1] === '&') {
        i++
        while (i + 1 < line.length && /[\d-]/.test(line[i + 1]!)) i++
      } else pending = 'out'
    } else if (c === '\n') {
      endCommand(false)
      // The bodies of the here-documents this line named, in order.
      for (const h of heredocs.splice(0)) {
        const body: string[] = []
        let at = i + 1
        while (at <= line.length) {
          const end = line.indexOf('\n', at)
          const text = line.slice(at, end === -1 ? undefined : end)
          at = end === -1 ? line.length + 1 : end + 1
          if ((h.strip ? text.replace(/^\t+/, '') : text).trim() === h.delim) break
          body.push(h.strip ? text.replace(/^\t+/, '') : text)
        }
        h.command.stdin = body.join('\n')
        i = at - 1
      }
    } else if (c === ' ' || c === '\t') endWord()
    else if (c === ';' || c === '&' || c === '(' || c === ')') endCommand(false)
    else if (c === '|') {
      if (line[i + 1] === '|') {
        i++
        endCommand(false)
      } else endCommand(true)
    } else add(c)
  }
  endCommand(false)
  return commands
}

// What a command reads on stdin: its own here-document or here-string, else what `cat <<EOF`,
// `echo` or `printf` piped into it. Undefined when that cannot be known.
function stdinOf(c: Command): string | undefined {
  if (c.stdin !== undefined) return c.stdin
  const from = c.from
  if (from === undefined) return undefined
  if (from.words[0] === 'cat' && from.words.length === 1) return from.stdin
  if (from.words[0] === 'echo') return from.words.slice(1).filter(w => !/^-[neE]+$/.test(w)).join(' ')
  if (from.words[0] === 'printf' && from.words.length === 2) return from.words[1]
  return undefined
}

// Git's short options that take a value, attached or as the next word.
const GIT_VALUED = 'mFCct'

// The prose of one `git commit`: its `-m` paragraphs joined as git joins them, or what `-F` names.
// A message file another command of the line writes is that command's here-document; an amend with
// no new message carries none.
function gitCommit(ws: string[], c: Command, dir: string, written: Map<string, string>): Piece[] {
  const what = 'the commit message'
  const paragraphs: string[] = []
  let file: string | undefined
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!
    let flag: string | undefined
    let value: string | undefined
    if (w === '--message' || w === '--file') [flag, value] = [w === '--message' ? 'm' : 'F', ws[++i]]
    else if (w.startsWith('--message=')) [flag, value] = ['m', w.slice(10)]
    else if (w.startsWith('--file=')) [flag, value] = ['F', w.slice(7)]
    else if (/^-[a-zA-Z]/.test(w)) {
      // Combined short flags: `-am`, `-sm "msg"`, `-mmsg`. The first that takes a value ends them.
      for (let k = 1; k < w.length; k++) {
        if (!GIT_VALUED.includes(w[k]!)) continue
        flag = w[k]
        value = k + 1 < w.length ? w.slice(k + 1) : ws[++i]
        break
      }
    }
    if (value === undefined) continue
    if (flag === 'm') paragraphs.push(value)
    else if (flag === 'F') file = value
  }
  const pieces: Piece[] = []
  if (paragraphs.length > 0) pieces.push({ what, text: paragraphs.join('\n\n') })
  if (file === '-') {
    const text = stdinOf(c)
    if (text !== undefined) pieces.push({ what, text })
  } else if (file !== undefined) {
    const path = join(dir, file)
    pieces.push(written.has(path) ? { what, text: written.get(path)! } : { what, file: path })
  }
  return pieces
}

// The prose of a `gh pr` or `gh issue` create, edit or comment: its title, body and body file.
// `ws` starts at `gh`.
export function gh(ws: readonly string[], dir: string, stdin?: string, written = new Map<string, string>()): Piece[] {
  if (!['pr', 'issue'].includes(ws[1] ?? '') || !['create', 'edit', 'comment'].includes(ws[2] ?? '')) return []
  const kind = ws[1] === 'issue' ? 'issue' : 'pull request'
  const body = `the ${kind} ${ws[2] === 'comment' ? 'comment' : 'body'}`
  const pieces: Piece[] = []
  for (let i = 3; i < ws.length; i++) {
    const w = ws[i]!
    const eq = w.indexOf('=')
    const name = w.startsWith('--') && eq !== -1 ? w.slice(0, eq) : w
    const value = () => (w.startsWith('--') && eq !== -1 ? w.slice(eq + 1) : ws[++i])
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
      } else if (file !== undefined) {
        const path = join(dir, file)
        pieces.push(written.has(path) ? { what: body, text: written.get(path)! } : { what: body, file: path })
      }
    }
  }
  return pieces
}

// The prose a shell line publishes. `cwd` is the shell's directory; a `cd` in the line moves it,
// and `git -C dir` sets it for one command. A file a command writes from its here-document is
// remembered, so a commit that reads it later in the line reads what the line wrote.
export function shellPieces(line: string, cwd: string): Piece[] {
  const pieces: Piece[] = []
  const written = new Map<string, string>()
  let dir = cwd
  for (const c of parse(line)) {
    const ws = c.words
    if (ws[0] === 'cd' && ws[1] !== undefined) dir = join(dir, ws[1])
    if (c.out !== undefined) {
      const text = ws[0] === 'cat' && ws.length === 1 ? c.stdin : ws[0] === 'echo' || ws[0] === 'printf' ? ws.slice(1).join(' ') : undefined
      if (text !== undefined) written.set(join(dir, c.out), text)
    }
    const at = ws.findIndex(w => w === 'git' || w === 'gh')
    if (at === -1) continue
    const cmd = ws.slice(at)
    if (cmd[0] === 'gh') {
      pieces.push(...gh(cmd, dir, stdinOf(c), written))
      continue
    }
    // `git -C dir` and `git -c k=v` take a value; other global options do not.
    let here = dir
    let i = 1
    while (i < cmd.length && cmd[i]!.startsWith('-')) {
      if (cmd[i] === '-C' && cmd[i + 1] !== undefined) here = join(here, cmd[i + 1]!)
      i += cmd[i] === '-C' || cmd[i] === '-c' ? 2 : 1
    }
    if (cmd[i] === 'commit') pieces.push(...gitCommit(cmd.slice(i + 1), c, here, written))
  }
  return pieces.filter(p => p.file !== undefined || (p.text ?? '').trim() !== '')
}

// The prose a call carries, by tool. An MCP tool that opens a pull request or issue is matched by
// its `title` and `body` fields.
export function pieces(tool: string, input: Record<string, unknown>, cwd: string): Piece[] {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  if (tool === 'Bash') return shellPieces(str('command') ?? '', cwd)
  if (tool === 'Write') {
    const path = join(cwd, str('file_path') ?? '')
    return isProseFile(path) ? [{ what: path, text: str('content') ?? '', beforeFile: path }] : []
  }
  if (tool === 'Edit') {
    const path = join(cwd, str('file_path') ?? '')
    const old = str('old_string') ?? ''
    const text = str('new_string') ?? ''
    return isProseFile(path) ? [{ what: path, text, before: old, beforeFile: path, edit: { old, new: text, all: input.replace_all === true } }] : []
  }
  if (tool.startsWith('mcp__') && /pull_?request|_pr\b|issue/i.test(tool)) {
    const out: Piece[] = []
    const title = str('title')
    const body = str('body')
    if (title !== undefined && title.trim() !== '') out.push({ what: 'the title', text: title })
    if (body !== undefined && body.trim() !== '') out.push({ what: 'the body', text: body })
    return out
  }
  return []
}
