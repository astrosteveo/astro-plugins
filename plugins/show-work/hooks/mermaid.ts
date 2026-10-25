// Mermaid blocks in a reply: finding them in its markdown, and sizing the
// picture each one renders to.

export type Part = { kind: 'markdown'; text: string } | { kind: 'mermaid'; source: string; fence: string }

const OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/

// Splits markdown into its text and its closed ```mermaid blocks, in order.
// A block still open (a reply streaming in) and a fence inside another fence
// stay text.
export function splitMermaid(text: string): Part[] {
  const lines = text.split('\n')
  const parts: Part[] = []
  let prose: string[] = []
  let i = 0
  while (i < lines.length) {
    const open = OPEN.exec(lines[i] ?? '')
    if (open === null) {
      prose.push(lines[i] ?? '')
      i += 1
      continue
    }
    const marks = open[1] ?? '```'
    const close = new RegExp(`^ {0,3}${marks[0] === '`' ? '`' : '~'}{${marks.length},}\\s*$`)
    let end = i + 1
    while (end < lines.length && !close.test(lines[end] ?? '')) {
      end += 1
    }
    const block = lines.slice(i, end + 1)
    if (end < lines.length && open[2]?.toLowerCase() === 'mermaid') {
      if (prose.length > 0) {
        parts.push({ kind: 'markdown', text: prose.join('\n') })
      }
      prose = []
      parts.push({ kind: 'mermaid', source: block.slice(1, -1).join('\n'), fence: block.join('\n') })
    } else {
      prose.push(...block)
    }
    i = end + 1
  }
  if (prose.join('').trim() !== '') {
    parts.push({ kind: 'markdown', text: prose.join('\n') })
  }

  return parts
}

// A short stable name for a diagram's source: FNV-1a, in hex.
export function hashOf(text: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

// Columns a diagram takes: its natural size at about 8 pixels a cell, the
// renderer drawing at `scale`, but never wider than the room.
export function diagramColumns(width: number, scale: number, room: number) {
  return Math.max(1, Math.min(room, 255, Math.ceil(width / scale / 8)))
}
