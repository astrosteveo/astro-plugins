// The prose a tool call would publish: a commit message, a pull request's or issue's title and
// body, or a prose file Claude writes. Each is checked before the call runs.

// A piece of prose a call carries: what it is, for the refusal; its text; and, for an edit, the text
// it replaces, whose Claudisms are not the edit's to answer for. `file` is a file the text is read
// from (`git commit -F`, `gh pr create --body-file`).
export type Piece = { what: string; text?: string; file?: string; before?: string; beforeFile?: string }

// Files of prose: Markdown and plain text, and the usual capitalised docs with no extension.
const PROSE_FILE = /\.(?:md|mdx|markdown|txt|rst|adoc)$|(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|NOTES|LICENSE)$/i

export const isProseFile = (path: string) => PROSE_FILE.test(path)

// A here-document's body, by its delimiter: `<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`.
const HEREDOC = /<<-?[ \t]*(['"]?)([\w.-]+)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$|\))/g

// The words of a shell command, quotes removed, as far as a hook can tell without running it. A
// here-document is replaced by a marker word so its body comes back whole, and `$(cat <<...)` in a
// quoted argument is the body. Operators (`&&`, `;`, `|`) are words of their own.
export function words(command: string): string[] {
  const bodies: string[] = []
  const text = command.replace(HEREDOC, (_m, _q, _d, body: string) => {
    bodies.push(body)
    return `<<\u0000${bodies.length - 1}\u0000`
  })
  const out: string[] = []
  let word: string | undefined
  const push = () => {
    if (word !== undefined) out.push(word)
    word = undefined
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '\u0000') {
      const end = text.indexOf('\u0000', i + 1)
      word = (word ?? '') + `\u0000${text.slice(i + 1, end)}\u0000`
      i = end
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1)
      word = (word ?? '') + text.slice(i + 1, end === -1 ? undefined : end)
      i = end === -1 ? text.length : end
    } else if (c === '"') {
      let s = ''
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1]!)) i++
        s += text[i]
      }
      word = (word ?? '') + s
    } else if (c === '\\' && i + 1 < text.length) {
      word = (word ?? '') + text[++i]
    } else if (/\s/.test(c)) push()
    else if (/[;&|()]/.test(c)) {
      push()
      out.push(c)
    } else word = (word ?? '') + c
  }
  push()
  // A marker stands for its body: `-F -` with `<<EOF`, or `-m "$(cat <<'EOF' ... )"`.
  return out.map(w => w.replace(/(?:\$\(\s*cat\s*)?<<\u0000(\d+)\u0000(?:\s*\))?/g, (_m, n: string) => bodies[Number(n)]!))
}

// Each command in a line of shell, split at `;`, `&&`, `||`, `|` and parentheses.
function commands(ws: string[]): string[][] {
  const out: string[][] = [[]]
  for (const w of ws) {
    if (/^[;&|()]$/.test(w)) out.push([])
    else out[out.length - 1]!.push(w)
  }
  return out.filter(c => c.length > 0)
}

// A here-document's body that a command reads on stdin, for `-F -` and `--body-file -`.
const stdinBody = (command: string) => [...command.matchAll(HEREDOC)].map(m => m[3]!).join('\n')

// The value of an option at word i: `-m x`, `-mx`, `--message x` or `--message=x`.
function option(ws: string[], i: number, short: string[], long: string[]): { value: string; next: number } | undefined {
  const w = ws[i]!
  for (const s of short) {
    if (w === s) return ws[i + 1] === undefined ? undefined : { value: ws[i + 1]!, next: i + 2 }
    if (w.startsWith(s) && !w.startsWith('--')) return { value: w.slice(s.length), next: i + 1 }
  }
  for (const l of long) {
    if (w === l) return ws[i + 1] === undefined ? undefined : { value: ws[i + 1]!, next: i + 2 }
    if (w.startsWith(`${l}=`)) return { value: w.slice(l.length + 1), next: i + 1 }
  }
  return undefined
}

// The prose of one `git commit`: its `-m` paragraphs joined as git joins them, or the file `-F`
// names. An amend with no new message, or `--no-edit`, carries none.
function gitCommit(ws: string[], stdin: string): Piece[] {
  const paragraphs: string[] = []
  let file: string | undefined
  for (let i = 0; i < ws.length; ) {
    const m = option(ws, i, ['-m'], ['--message'])
    if (m !== undefined) {
      paragraphs.push(m.value)
      i = m.next
      continue
    }
    const f = option(ws, i, ['-F'], ['--file'])
    if (f !== undefined) {
      file = f.value
      i = f.next
      continue
    }
    i++
  }
  const pieces: Piece[] = []
  if (paragraphs.length > 0) pieces.push({ what: 'the commit message', text: paragraphs.join('\n\n') })
  if (file === '-') pieces.push({ what: 'the commit message', text: stdin })
  else if (file !== undefined) pieces.push({ what: 'the commit message', file })
  return pieces
}

// The prose of a `gh pr` or `gh issue` create, edit or comment: its title, body and body file.
function gh(ws: string[], stdin: string): Piece[] {
  const pieces: Piece[] = []
  const kind = ws[1] === 'issue' ? 'issue' : 'pull request'
  for (let i = 3; i < ws.length; ) {
    const t = option(ws, i, ['-t'], ['--title'])
    if (t !== undefined) {
      pieces.push({ what: `the ${kind} title`, text: t.value })
      i = t.next
      continue
    }
    const b = option(ws, i, ['-b'], ['--body'])
    if (b !== undefined) {
      pieces.push({ what: `the ${kind} ${ws[2] === 'comment' ? 'comment' : 'body'}`, text: b.value })
      i = b.next
      continue
    }
    const f = option(ws, i, ['-F'], ['--body-file'])
    if (f !== undefined) {
      const what = `the ${kind} ${ws[2] === 'comment' ? 'comment' : 'body'}`
      pieces.push(f.value === '-' ? { what, text: stdin } : { what, file: f.value })
      i = f.next
      continue
    }
    i++
  }
  return pieces
}

// The prose a shell command publishes. Options before the subcommand (`git -C dir commit`) are
// passed over.
export function shellPieces(command: string): Piece[] {
  const stdin = stdinBody(command)
  const pieces: Piece[] = []
  for (const ws of commands(words(command))) {
    const at = ws.findIndex(w => w === 'git' || w === 'gh')
    if (at === -1) continue
    const cmd = ws.slice(at)
    if (cmd[0] === 'git') {
      // `git -C dir` and `git -c k=v` take a value; other global options do not.
      let i = 1
      while (i < cmd.length && cmd[i]!.startsWith('-')) i += cmd[i] === '-C' || cmd[i] === '-c' ? 2 : 1
      if (cmd[i] === 'commit') pieces.push(...gitCommit(cmd.slice(i + 1), stdin))
    } else if ((cmd[1] === 'pr' || cmd[1] === 'issue') && ['create', 'edit', 'comment'].includes(cmd[2] ?? ''))
      pieces.push(...gh(cmd, stdin))
  }
  return pieces.filter(p => p.file !== undefined || (p.text ?? '').trim() !== '')
}

// The prose a call carries, by tool. An MCP tool that opens a pull request or issue is matched by
// its `title` and `body` fields.
export function pieces(tool: string, input: Record<string, unknown>): Piece[] {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  if (tool === 'Bash') return shellPieces(str('command') ?? '')
  if (tool === 'Write') {
    const path = str('file_path') ?? ''
    return isProseFile(path) ? [{ what: path, text: str('content') ?? '', beforeFile: path }] : []
  }
  if (tool === 'Edit') {
    const path = str('file_path') ?? ''
    return isProseFile(path) ? [{ what: path, text: str('new_string') ?? '', before: str('old_string') ?? '' }] : []
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
