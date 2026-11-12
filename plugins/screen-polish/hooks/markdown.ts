// Splits a reply into the parts Claude Code's own Markdown keeps drawing and the
// blocks this plugin draws itself, since Markdown has no way to style inline
// code, heading levels, rules, task lists or quotes.

export type Span = {
  text: string
  code?: true
  bold?: true
  italic?: true
  strike?: true
  href?: string
}

export type Line =
  | { kind: 'heading'; depth: number; spans: Span[] }
  | { kind: 'item'; indent: number; marker: string; task?: 'open' | 'done'; spans: Span[] }
  | { kind: 'text'; indent: number; spans: Span[] }
  | { kind: 'quote'; spans: Span[] }
  | { kind: 'rule' }

export type Segment = { kind: 'markdown'; text: string } | { kind: 'rich'; lines: Line[] }

/** Which parts of a reply this plugin draws; the rest stays Claude Code's. */
export type Features = {
  code: boolean
  headings: boolean
  rules: boolean
  tasks: boolean
  quotes: boolean
}

type Style = Omit<Span, 'text'>

// At any indent, since a fence inside a list item sits at the item's content column.
const FENCE = /^\s*(`{3,}|~{3,})/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/
const TASK = /^\[([ xX])\]\s+(.*)$/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const RULE = /^ {0,3}([-*_])( *\1){2,} *$/
const QUOTE = /^ {0,3}>/

/**
 * The reply cut into parts, or null when it holds nothing this plugin draws,
 * so the engine can draw the whole reply as before.
 */
export function segments(text: string, features: Features): Segment[] | null {
  const lines = text.split('\n')
  // Each block with the lines this plugin draws for it, or null for the engine's.
  const blocks: { start: number; end: number; drawn: Line[] | null }[] = []
  // Kept from block to block, since a blank line inside a list doesn't end it.
  const stack: Open[] = []
  let start = -1
  let fence: string | null = null
  let hasFence = false

  const close = (end: number) => {
    if (start < 0) return
    const block = lines.slice(start, end)
    const canParse = !hasFence && canDraw(block)
    // A block this plugin doesn't parse may end a list, so the next one starts afresh.
    if (!canParse) stack.length = 0
    blocks.push({ start, end, drawn: canParse ? drawn(block, features, stack) : null })
    start = -1
    hasFence = false
  }

  lines.forEach((line, i) => {
    if (fence !== null) {
      const closer = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
      if (closer.test(line)) fence = null
      return
    }
    const open = FENCE.exec(line)
    if (open) {
      if (start < 0) start = i
      fence = open[1]!
      hasFence = true
      return
    }
    if (line.trim() === '') return close(i)
    if (start < 0) start = i
  })
  close(lines.length)

  if (blocks.every(b => b.drawn === null)) return null

  const out: Segment[] = []
  for (let i = 0; i < blocks.length; ) {
    const block = blocks[i]!
    if (block.drawn !== null) {
      out.push({ kind: 'rich', lines: block.drawn })
      i++
      continue
    }
    let j = i
    while (j + 1 < blocks.length && blocks[j + 1]!.drawn === null) j++
    // From the first line to the last of the run, so blank lines inside stay as written.
    out.push({ kind: 'markdown', text: lines.slice(block.start, blocks[j]!.end).join('\n') })
    i = j + 1
  }
  return out
}

/** The block's lines as this plugin draws them, or null when the engine draws it. */
function drawn(block: string[], f: Features, stack: Open[]): Line[] | null {
  const out = richLines(block, stack)

  // A block that holds a part whose setting is off stays with the engine whole,
  // so that part looks just as Claude Code draws it.
  const holds: Record<keyof Features, boolean> = {
    code: out.some(l => l.kind !== 'rule' && l.spans.some(s => s.code)),
    headings: out.some(l => l.kind === 'heading'),
    rules: out.some(l => l.kind === 'rule'),
    tasks: out.some(l => l.kind === 'item' && l.task !== undefined),
    quotes: out.some(l => l.kind === 'quote'),
  }
  const parts = (Object.keys(holds) as (keyof Features)[]).filter(k => holds[k])
  return parts.length > 0 && parts.every(k => f[k]) ? out : null
}

function canDraw(block: string[]): boolean {
  const first = block[0]!
  // A quote is drawn as one paragraph, so a fence or a list inside it stays with the engine.
  if (QUOTE.test(first)) return !block.some(l => FENCE.test(unquoted(l)) || ITEM.test(unquoted(l)))
  // Tables, HTML, indented code and setext headings (a rule under text) stay with the engine.
  if (block.some(l => /^\s*\|/.test(l) || /^\s*</.test(l) || QUOTE.test(l))) return false
  if (block.slice(1).some(l => RULE.test(l) || /^ {0,3}=+\s*$/.test(l))) return false
  if (/^( {4,}|\t)/.test(first) && !ITEM.test(first)) return false
  return true
}

/** A quote's line less its `>` marks. */
function unquoted(line: string): string {
  return line.replace(/^ {0,3}(> ?)+/, '')
}

type Building =
  | { kind: 'heading'; depth: number; raw: string }
  | { kind: 'item'; indent: number; marker: string; task?: 'open' | 'done'; raw: string }
  | { kind: 'text'; indent: number; raw: string }
  | { kind: 'quote'; raw: string }
  | { kind: 'rule' }

// An open list item: the column its content starts at as written, and where
// its marker and its content are drawn.
type Open = { written: number; drawnAt: number; contentAt: number }

function richLines(block: string[], stack: Open[]): Line[] {
  const out: Building[] = []
  // After a blank line, only the items the block's first line is indented into stay open.
  const first = block[0]!
  while (stack.length > 0 && first.length - first.trimStart().length < stack.at(-1)!.written) stack.pop()

  for (const line of block) {
    const indent = line.length - line.trimStart().length
    const last = out.at(-1)

    if (QUOTE.test(line) || (last?.kind === 'quote' && !RULE.test(line))) {
      const body = unquoted(line).trim()
      if (last?.kind === 'quote' && body !== '') last.raw += ` ${body}`
      else out.push({ kind: 'quote', raw: body })
      continue
    }
    if (RULE.test(line)) {
      stack.length = 0
      out.push({ kind: 'rule' })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      stack.length = 0
      out.push({ kind: 'heading', depth: heading[1]!.length, raw: heading[2]! })
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      while (stack.length > 0 && indent < stack.at(-1)!.written) stack.pop()
      const marker = /\d/.test(item[2]!) ? item[2]!.replace(')', '.') : '-'
      const drawnAt = stack.at(-1)?.contentAt ?? 0
      stack.push({ written: indent + item[2]!.length + item[3]!.length, drawnAt, contentAt: drawnAt + marker.length + 1 })
      const task = TASK.exec(item[4]!)
      out.push(
        task
          ? { kind: 'item', indent: drawnAt, marker, task: task[1] === ' ' ? 'open' : 'done', raw: task[2]! }
          : { kind: 'item', indent: drawnAt, marker, raw: item[4]! },
      )
      continue
    }
    // A soft line break: the line goes on the paragraph or item above, as markdown joins them.
    if (last?.kind === 'item' || last?.kind === 'text') {
      last.raw += ` ${line.trim()}`
      continue
    }
    out.push({ kind: 'text', indent: 0, raw: line.trim() })
  }

  return out.map(l => {
    if (l.kind === 'rule') return l
    const { raw, ...rest } = l
    return { ...rest, spans: inline(raw) } as Line
  })
}

/** Inline markdown as styled runs: code, bold, italic, strikethrough and links. */
export function inline(s: string, style: Style = {}): Span[] {
  const out: Span[] = []
  let text = ''
  const flush = () => {
    if (text) out.push({ ...style, text })
    text = ''
  }

  for (let i = 0; i < s.length; ) {
    const c = s[i]!

    if (c === '\\' && i + 1 < s.length && /[!-/:-@[-`{-~]/.test(s[i + 1]!)) {
      text += s[i + 1]
      i += 2
      continue
    }

    if (c === '`') {
      const run = runOf(s, i, '`')
      const end = findRun(s, i + run, run)
      if (end < 0) {
        text += '`'.repeat(run)
        i += run
        continue
      }
      let code = s.slice(i + run, end)
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1)
      flush()
      out.push({ ...style, text: code, code: true })
      i = end + run
      continue
    }

    if ((c === '*' || c === '_' || c === '~') && s[i + 1] === c && opens(s, i, 2, c)) {
      const end = closing(s, i + 2, c + c)
      if (end > i + 2) {
        flush()
        out.push(...inline(s.slice(i + 2, end), c === '~' ? { ...style, strike: true } : { ...style, bold: true }))
        i = end + 2
        continue
      }
    }

    if ((c === '*' || c === '_') && s[i + 1] !== c && opens(s, i, 1, c)) {
      const end = closing(s, i + 1, c)
      if (end > i + 1) {
        flush()
        out.push(...inline(s.slice(i + 1, end), { ...style, italic: true }))
        i = end + 1
        continue
      }
    }

    if (c === '[') {
      const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(s.slice(i))
      if (link) {
        flush()
        out.push(...inline(link[1]!, { ...style, href: link[2]! }))
        i += link[0].length
        continue
      }
    }

    text += c
    i++
  }
  flush()
  return out
}

function runOf(s: string, i: number, c: string): number {
  let n = 0
  while (s[i + n] === c) n++
  return n
}

/** Where the next backtick run of exactly `n` starts, or -1. */
function findRun(s: string, from: number, n: number): number {
  for (let i = from; i < s.length; ) {
    if (s[i] !== '`') {
      i++
      continue
    }
    const run = runOf(s, i, '`')
    if (run === n) return i
    i += run
  }
  return -1
}

/** A delimiter opens emphasis when text follows it, and `_` only at a word's start. */
function opens(s: string, i: number, n: number, c: string): boolean {
  const after = s[i + n]
  if (after === undefined || /\s/.test(after)) return false
  return c !== '_' || i === 0 || !/[\p{L}\p{N}]/u.test(s[i - 1]!)
}

/** Where `delim` closes emphasis after `from`, skipping code spans and escapes, or -1. */
function closing(s: string, from: number, delim: string): number {
  const c0 = delim[0]!
  for (let i = from; i < s.length; ) {
    const c = s[i]!
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '`') {
      const run = runOf(s, i, '`')
      const end = findRun(s, i + run, run)
      i = end < 0 ? i + run : end + run
      continue
    }
    if (c === c0) {
      const run = runOf(s, i, c0)
      const after = s[i + run]
      const isWordAfter = after !== undefined && /[\p{L}\p{N}]/u.test(after)
      if (run === delim.length && !/\s/.test(s[i - 1]!) && (c0 !== '_' || !isWordAfter)) return i
      i += run
      continue
    }
    i++
  }
  return -1
}
