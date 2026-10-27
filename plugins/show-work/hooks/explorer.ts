// The Explorer tab's tree, built from a flat list of the project's files.

export type Row = {
  path: string
  name: string
  depth: number
  isDir: boolean
  isOpen: boolean
}

type Node = { dirs: Map<string, Node>; files: string[] }

function build(paths: readonly string[]) {
  const root: Node = { dirs: new Map(), files: [] }
  for (const path of paths) {
    const parts = path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part)
      if (next === undefined) {
        next = { dirs: new Map(), files: [] }
        node.dirs.set(part, next)
      }
      node = next
    }
    node.files.push(parts.at(-1)!)
  }

  return root
}

// The rows the tree shows: folders first, then files, each sorted, a
// folder's contents only while it is open.
export function treeRows(paths: readonly string[], open: ReadonlySet<string>): Row[] {
  const rows: Row[] = []
  const walk = (node: Node, prefix: string, depth: number) => {
    for (const name of [...node.dirs.keys()].sort()) {
      const path = prefix + name
      const isOpen = open.has(path)
      rows.push({ path, name, depth, isDir: true, isOpen })
      if (isOpen) {
        walk(node.dirs.get(name)!, `${path}/`, depth + 1)
      }
    }
    for (const name of [...node.files].sort()) {
      rows.push({ path: prefix + name, name, depth, isDir: false, isOpen: false })
    }
  }
  walk(build(paths), '', 0)

  return rows
}

// How well a path matches a filter typed in pieces: every character in
// order, scored higher for a run of them and for a hit in the file's name.
export function score(path: string, filter: string) {
  const hay = path.toLowerCase()
  const needle = filter.toLowerCase().replace(/\s+/g, '')
  if (needle === '') {
    return 0
  }
  const nameAt = hay.lastIndexOf('/') + 1
  let at = -1
  let total = 0
  let run = 0
  for (const ch of needle) {
    const found = hay.indexOf(ch, at + 1)
    if (found < 0) {
      return undefined
    }
    run = found === at + 1 ? run + 1 : 0
    total += 1 + run * 2 + (found >= nameAt ? 2 : 0)
    at = found
  }

  return total - path.length / 100
}

// The files a filter finds, best first.
export function matches(paths: readonly string[], filter: string, most: number) {
  return paths
    .flatMap(path => {
      const found = score(path, filter)

      return found === undefined ? [] : [{ path, found }]
    })
    .sort((a, b) => b.found - a.found)
    .slice(0, most)
    .map(one => one.path)
}

// `git status --porcelain` read into each path's two-letter code.
export function parseStatus(stdout: string) {
  const codes: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    if (line.length > 3) {
      const path = line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '')
      codes[path] = line.slice(0, 2).trim() || line.slice(0, 2)
    }
  }

  return codes
}

// `git status --porcelain=v1 --branch`: the branch, how far it is ahead of
// and behind its upstream, and each file's two columns.
export function parseGit(stdout: string) {
  const lines = stdout.split('\n').filter(line => line !== '')
  const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : ''
  // `work...origin/work [ahead 1]`, or `work [ahead 1]` with no upstream.
  const branch = head.replace(/^No commits yet on /, '').split(/\.\.\.| /)[0] ?? ''
  const ahead = Number(head.match(/ahead (\d+)/)?.[1] ?? 0)
  const behind = Number(head.match(/behind (\d+)/)?.[1] ?? 0)
  const files = lines.map(line => ({
    path: line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''),
    index: line[0] ?? ' ',
    worktree: line[1] ?? ' ',
  }))

  return { branch, ahead, behind, files }
}

// `rg --line-number --no-heading` (or `git grep -n`) output read into hits.
export function parseHits(stdout: string, most: number) {
  const hits: { file: string; line: number; text: string }[] = []
  for (const row of stdout.split('\n')) {
    const m = row.match(/^(.+?):(\d+):(.*)$/)
    if (m !== null) {
      hits.push({ file: m[1]!, line: Number(m[2]), text: m[3]!.trim().slice(0, 300) })
    }
  }

  return { hits: hits.slice(0, most), isCut: hits.length > most }
}

// Terminal colour codes and carriage-return rewrites out of a line of output.
export function plain(line: string) {
  return (line.split('\r').at(-1) ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '')
}

// Where a selection lies in the file it was taken from: its 1-based lines,
// quoted whole as the file has them. The screen's text may carry the gutter's
// line numbers or the markdown's rendering, so the exact text is tried first,
// then the text without a gutter, then its first and last lines alone.
export function locateSelection(source: string, text: string) {
  const lines = source.split('\n')
  const whole = (from: number, to: number) => ({ from, to, text: lines.slice(from - 1, to).join('\n') })
  const picked = text.replace(/\s+$/, '')
  if (picked.trim() === '') {
    return undefined
  }
  const lineOf = (at: number) => source.slice(0, at).split('\n').length
  const at = source.indexOf(picked)
  if (at >= 0) {
    return whole(lineOf(at), lineOf(at) + picked.split('\n').length - 1)
  }
  const bare = picked.split('\n').map(line => line.replace(/^\s*\d+(?: |\t)/, ''))
  const bareAt = source.indexOf(bare.join('\n'))
  if (bareAt >= 0) {
    return whole(lineOf(bareAt), lineOf(bareAt) + bare.length - 1)
  }
  const kept = bare.map(line => line.trim()).filter(line => line !== '')
  const first = lines.findIndex(line => line.includes(kept[0] ?? '\u0000'))
  const last = lines.findLastIndex(line => line.includes(kept.at(-1) ?? '\u0000'))
  if (first >= 0 && last >= first) {
    return whole(first + 1, last + 1)
  }

  return { from: undefined, to: undefined, text: picked }
}

// Markdown cut into prose and fenced code, in order, so the fences can be
// drawn as highlighted code and the prose as markdown.
export function splitFences(text: string) {
  const parts: ({ text: string } | { code: string; lang: string })[] = []
  const fence = /^(`{3,})[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm
  let at = 0
  for (const match of text.matchAll(fence)) {
    parts.push({ text: text.slice(at, match.index) }, { code: (match[3] ?? '').replace(/\n$/, ''), lang: match[2] ?? '' })
    at = (match.index ?? 0) + match[0].length
  }
  parts.push({ text: text.slice(at) })

  return parts.filter(part => !('text' in part) || part.text.trim() !== '')
}

// The diff rows a selection covers, whole and with their + or -. The drawn
// diff keeps its gutter and markers out of a selection, so the picked text is
// matched against each row's text: the first picked line may be the tail of its
// row, the last the head of its own.
export function locateDiffRows(rows: string[], text: string) {
  const picked = text.replace(/\s+$/, '').split('\n').map(line => line.trim())
  if (picked.every(line => line === '')) {
    return undefined
  }
  const body = rows.map(row => row.slice(1))
  for (let at = 0; at + picked.length <= rows.length; at += 1) {
    if (picked.every((line, k) => (body[at + k] ?? '').includes(line))) {
      return rows.slice(at, at + picked.length).join('\n')
    }
  }

  return undefined
}

// The rows of a search's result list: each file, then its first hits.
export type HitItem =
  | { kind: 'file'; file: string; count: number }
  | { kind: 'hit'; file: string; line: number; text: string }

export function hitItems(hits: readonly { file: string; line: number; text: string }[]) {
  const byFile = new Map<string, { line: number; text: string }[]>()
  for (const hit of hits) {
    byFile.set(hit.file, [...(byFile.get(hit.file) ?? []), hit])
  }

  return [...byFile].slice(0, 40).flatMap(([file, list]): HitItem[] => [
    { kind: 'file', file, count: list.length },
    ...list.slice(0, 8).map((hit): HitItem => ({ kind: 'hit', file, line: hit.line, text: hit.text })),
  ])
}

// What a row of the result list shows, as one line of text.
export const hitRowText = (item: HitItem) =>
  item.kind === 'file' ? `${item.file} ${item.count}` : `${String(item.line).padStart(5)} ${item.text}`

// The hits a drag over the list picked, as a prompt: where each is and what it says.
export function hitsQuote(query: string, items: HitItem[], from: number, to: number) {
  const picked = items.slice(from, to + 1).filter((item): item is Extract<HitItem, { kind: 'hit' }> => item.kind === 'hit')
  if (picked.length === 0) {
    return undefined
  }
  const rows = picked.map(hit => `${hit.file}:${hit.line}: ${hit.text.trim()}`).join('\n')
  const word = picked.length === 1 ? 'hit' : 'hits'

  return {
    marker: `[search "${query}" ${picked.length} ${word}]`,
    text: `About ${picked.length === 1 ? 'this search hit' : 'these search hits'} for \`${query}\`:\n\`\`\`\n${rows}\n\`\`\`\n`,
  }
}

// A markdown file cut into the blocks the viewer draws one by one: prose
// (a paragraph, heading, list or table), fenced code, and the local pictures
// it names, each with the source lines it came from, 0-based and inclusive.
export type MdBlock =
  | { kind: 'md'; text: string; from: number; to: number }
  | { kind: 'code'; text: string; lang: string; from: number; to: number }
  | { kind: 'image'; ref: string; alt: string; from: number; to: number }

const IMAGE_MD = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g

export function mdBlocks(source: string, pictures: readonly string[] = []) {
  const lines = source.split('\n')
  const blocks: MdBlock[] = []
  let para: { text: string[]; from: number } | undefined
  const flush = (to: number) => {
    if (para === undefined) {
      return
    }
    const text = para.text.join('\n')
    const base = para.from
    let at = 0
    const lineAt = (offset: number) => base + text.slice(0, offset).split('\n').length - 1
    const prose = (end: number) => {
      const piece = text.slice(at, end)
      if (piece.trim() !== '') {
        blocks.push({ kind: 'md', text: piece.trim(), from: lineAt(at + (piece.length - piece.trimStart().length)), to: lineAt(end) })
      }
    }
    for (const match of text.matchAll(IMAGE_MD)) {
      if (!pictures.includes(match[2] ?? '')) {
        continue
      }
      prose(match.index ?? 0)
      const line = lineAt(match.index ?? 0)
      blocks.push({ kind: 'image', ref: match[2] ?? '', alt: match[1] ?? '', from: line, to: line })
      at = (match.index ?? 0) + match[0].length
    }
    prose(text.length)
    para = undefined
    void to
  }
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n] ?? ''
    const open = line.match(/^(`{3,})[ \t]*([\w+#.-]*)/)
    if (open !== null) {
      flush(n - 1)
      const mark = open[1] ?? '```'
      const body: string[] = []
      let end = n + 1
      while (end < lines.length && !new RegExp(`^${mark}[ \\t]*$`).test(lines[end] ?? '')) {
        body.push(lines[end] ?? '')
        end += 1
      }
      blocks.push({ kind: 'code', text: body.join('\n'), lang: open[2] ?? '', from: n, to: Math.min(end, lines.length - 1) })
      n = end
    } else if (line.trim() === '') {
      flush(n - 1)
    } else if (para === undefined) {
      para = { text: [line], from: n }
    } else {
      para.text.push(line)
    }
  }
  flush(lines.length - 1)

  return blocks
}

// The block a row of a stack of blocks falls in, where `y` counts rows from the
// top of block `start` (negative above it) and a row of gap lies between blocks.
export function blockAt(heights: number[], start: number, y: number) {
  let at = Math.max(0, Math.min(start, heights.length - 1))
  let off = y
  while (off < 0 && at > 0) {
    at -= 1
    off += (heights[at] ?? 1) + 1
  }
  while (at < heights.length - 1 && off >= (heights[at] ?? 1)) {
    off -= (heights[at] ?? 1) + 1
    at += 1
  }

  return at
}
