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
