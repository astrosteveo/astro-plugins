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
