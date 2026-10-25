// What the pane draws in Raster cells, and the parsing behind it: pure
// functions of plain data, so the tests can read the cells back.

import type { CommitRow, TestRun } from '../types'

export const DEFAULT = 0x01000000
const GRID = 0x3a3a3a
const DIM = 0x8a8a8a
const BRIGHT = 0xd0d0d0
const LABEL = 14
const PULSE = 0xffe0b0
// Half-cell glyphs: a bar's ends land on half a column.
const LEFT = 0x258c
const RIGHT = 0x2590
const FULL = 0x2588
const SHADE = 0x2591
const HATCH = 0x2592
// Eighth blocks, from one eighth up to seven: a column's top lands on an eighth.
const EIGHTHS = [0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587]

export const GREEN = 0x6cc070
export const ORANGE = 0xe0a040
export const RED = 0xe06c75
export const BLUE = 0x5fa8d3
// The breakdown's categories take these in turn.
export const PALETTE = [0x7aa2f7, 0xbb9af7, 0x9ece6a, 0xe0af68, 0xf7768e, 0x2ac3de, 0x73daca, 0xff9e64]

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Padded base64; the module has neither btoa nor Buffer.
export function base64(bytes: Uint8Array) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }

  return out
}

// The few marks beyond ASCII the charts write, each one cell wide.
const MARKS = new Set([...'↳−✓✗·…'].map(ch => ch.codePointAt(0)))

// A Raster takes one printable, single-width BMP character per cell: plain
// ASCII and the marks pass, anything else (emoji, CJK, controls) draws as ?.
export function glyphs(text: string) {
  return [...text].map(ch => {
    const code = ch.codePointAt(0) ?? 0x3f

    return (code >= 0x20 && code < 0x7f) || MARKS.has(code) ? code : 0x3f
  })
}

// A blank grid of cells to draw into; writes past its edges are dropped.
export function grid(columns: number, rows: number) {
  const words = new Uint32Array(columns * rows * 3)
  for (let at = 0; at < words.length; at += 3) {
    words[at] = 0x20
    words[at + 1] = DEFAULT
    words[at + 2] = DEFAULT
  }
  const put = (row: number, col: number, glyph: number, fg: number, bg = DEFAULT) => {
    if (row < 0 || row >= rows || col < 0 || col >= columns) {
      return
    }
    const at = (row * columns + col) * 3
    words[at] = glyph
    words[at + 1] = fg
    words[at + 2] = bg
  }
  const text = (row: number, col: number, value: string, fg: number, bg = DEFAULT) =>
    glyphs(value).forEach((code, i) => put(row, col + i, code, fg, bg))

  return {
    put,
    text,
    done: () => ({ columns, rows, cells: base64(new Uint8Array(words.buffer)) }),
  }
}

export function tokens(n: number) {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`
  }

  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n)
}

export type Bar = {
  label: string
  start: number
  end?: number
  color: number
  isSub: boolean
}

// A Gantt chart: one row per bar, labels on the left, time running left to
// right from the earliest start to now, with a faint grid. A running bar's
// leading cell pulses brighter on odd frames.
export function gantt(bars: Bar[], now: number, wanted: number, frame = 0) {
  const columns = Math.max(LABEL + 5, wanted)
  const width = columns - LABEL - 1
  const from = Math.min(now - 1000, ...bars.map(bar => bar.start))
  const span = Math.max(1, now - from)
  const g = grid(columns, bars.length)

  bars.forEach((bar, row) => {
    g.text(row, 0, (bar.isSub ? '↳ ' + bar.label : bar.label).slice(0, LABEL), bar.isSub ? DIM : BRIGHT)
    for (let col = 0; col < width; col += 6) {
      g.put(row, LABEL + 1 + col, 0x00b7, GRID)
    }

    // Half columns: a bar covers [a, b) and never less than one half.
    const halves = width * 2
    const a = Math.floor(((bar.start - from) / span) * halves)
    const b = Math.max(a + 1, Math.ceil((((bar.end ?? now) - from) / span) * halves))
    const head = Math.floor((Math.min(halves, b) - 1) / 2)
    for (let half = Math.max(0, a); half < Math.min(halves, b); half += 1) {
      const col = Math.floor(half / 2)
      const hasLeft = col * 2 >= a && col * 2 < b
      const hasRight = col * 2 + 1 >= a && col * 2 + 1 < b
      const isPulse = bar.end === undefined && col === head && frame % 2 === 1
      g.put(
        row,
        LABEL + 1 + col,
        hasLeft && hasRight ? FULL : hasLeft ? LEFT : RIGHT,
        isPulse ? PULSE : bar.color,
      )
    }
  })

  return { ...g.done(), from }
}

// One row of swatches and names, in the very colors the chart draws.
export function legend(entries: [number, string][]) {
  const columns = entries.reduce((sum, [, name], i) => sum + (i === 0 ? 0 : 2) + 2 + [...name].length, 0)
  const g = grid(Math.max(1, columns), 1)
  let col = 0
  entries.forEach(([color, name], i) => {
    col += i === 0 ? 0 : 2
    g.put(0, col, FULL, color)
    g.text(0, col + 1, ` ${name}`, DIM)
    col += 2 + [...name].length
  })

  return g.done()
}

export type Beat = { at: number; kind: string; status: string }

// Tool calls over the last stretch of time, one column per bucket, newest on
// the right: the height is how many calls, the color what they were.
export function pulse(beats: Beat[], now: number, columns: number, bucket: number) {
  const g = grid(columns, 1)
  const counts = Array.from({ length: columns }, () => ({ n: 0, edits: 0, failed: 0 }))
  for (const beat of beats) {
    const col = columns - 1 - Math.floor((now - beat.at) / bucket)
    const slot = counts[col]
    if (slot !== undefined) {
      slot.n += 1
      slot.edits += beat.kind === 'edit' ? 1 : 0
      slot.failed += beat.status === 'failed' ? 1 : 0
    }
  }
  const most = Math.max(4, ...counts.map(slot => slot.n))
  counts.forEach((slot, col) => {
    if (slot.n === 0) {
      g.put(0, col, EIGHTHS[0]!, GRID)

      return
    }
    const level = Math.max(1, Math.round((slot.n / most) * 8))
    const color = slot.failed > 0 ? RED : slot.edits > 0 ? ORANGE : BLUE
    g.put(0, col, level >= 8 ? FULL : EIGHTHS[level - 1]!, color)
  })

  return g.done()
}

// A meter of how full the window is, with a mark where compaction comes.
export function gauge(fraction: number, columns: number, mark?: number) {
  const g = grid(columns, 1)
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * columns)
  const color = fraction < 0.5 ? GREEN : fraction < 0.8 ? ORANGE : RED
  for (let col = 0; col < columns; col++) {
    g.put(0, col, col < filled ? FULL : SHADE, col < filled ? color : GRID)
  }
  if (mark !== undefined && mark > 0 && mark < 1) {
    g.put(0, Math.min(columns - 1, Math.round(mark * columns)), 0x2503, 0xf0f0f0)
  }

  return g.done()
}

// The window split by what fills it, each part in its palette color, the
// free space shaded and the compaction buffer hatched at the end.
export function stacked(parts: { tokens: number; color: number }[], window: number, buffer: number, columns: number) {
  const g = grid(columns, 1)
  const scale = columns / Math.max(1, window)
  let col = 0
  for (const part of parts) {
    const width = Math.max(1, Math.round(part.tokens * scale))
    for (let i = 0; i < width && col < columns; i++, col++) {
      g.put(0, col, FULL, part.color)
    }
  }
  const bufferFrom = columns - Math.round(buffer * scale)
  for (; col < columns; col++) {
    g.put(0, col, col >= bufferFrom ? HATCH : SHADE, col >= bufferFrom ? RED : GRID)
  }

  return g.done()
}

// An area chart of fractions of the window, one group of columns per value,
// with a faint line at the compaction mark.
export function area(values: number[], columns: number, rows: number, mark?: number) {
  const g = grid(columns, rows)
  const each = Math.max(1, Math.min(4, Math.floor(columns / Math.max(1, values.length))))
  const shown = values.slice(-Math.floor(columns / each))
  const markRow = mark === undefined ? undefined : rows - 1 - Math.floor(mark * rows)
  if (markRow !== undefined && markRow >= 0) {
    for (let col = 0; col < columns; col++) {
      g.put(markRow, col, 0x2500, 0x5a3030)
    }
  }
  shown.forEach((value, i) => {
    const eighths = Math.round(Math.min(1, Math.max(0, value)) * rows * 8)
    const color = value < 0.5 ? GREEN : value < 0.8 ? ORANGE : RED
    for (let col = i * each; col < (i + 1) * each - (each > 1 ? 1 : 0); col++) {
      for (let row = rows - 1, left = eighths; row >= 0 && left > 0; row--, left -= 8) {
        g.put(row, col, left >= 8 ? FULL : EIGHTHS[left - 1]!, color)
      }
    }
  })

  return g.done()
}

export type Tile = { label: string; weight: number; color: number }

type Rect = { x: number; y: number; w: number; h: number }

// The squarified treemap: rows of tiles laid along the short side, each row
// closed when one more tile would make its tiles less square.
function squarify(weights: number[], box: Rect): Rect[] {
  const total = weights.reduce((sum, w) => sum + w, 0) || 1
  const areas = weights.map(w => (w / total) * box.w * box.h)
  const rects: Rect[] = []
  let free = { ...box }
  let row: number[] = []
  const worst = (list: number[], side: number) => {
    const sum = list.reduce((a, b) => a + b, 0)

    return Math.max(...list.map(a => Math.max((side * side * a) / (sum * sum), (sum * sum) / (side * side * a))))
  }
  const place = (list: number[]) => {
    const sum = list.reduce((a, b) => a + b, 0)
    if (free.w >= free.h) {
      const w = sum / free.h
      let y = free.y
      for (const a of list) {
        rects.push({ x: free.x, y, w, h: a / w })
        y += a / w
      }
      free = { x: free.x + w, y: free.y, w: free.w - w, h: free.h }
    } else {
      const h = sum / free.w
      let x = free.x
      for (const a of list) {
        rects.push({ x, y: free.y, w: a / h, h })
        x += a / h
      }
      free = { x: free.x, y: free.y + h, w: free.w, h: free.h - h }
    }
  }
  for (const a of areas) {
    const side = Math.min(free.w, free.h)
    if (row.length === 0 || worst([...row, a], side) <= worst(row, side)) {
      row.push(a)
    } else {
      place(row)
      row = [a]
    }
  }
  if (row.length > 0) {
    place(row)
  }

  return rects
}

// Tiles sized by weight, each a block of its color with its label inside
// where it fits. A cell is about twice as tall as wide, so the layout runs
// in half rows to keep tiles square on screen.
export function treemap(tiles: Tile[], columns: number, rows: number) {
  const g = grid(columns, rows)
  const sorted = [...tiles].sort((a, b) => b.weight - a.weight)
  const rects = squarify(sorted.map(tile => tile.weight), { x: 0, y: 0, w: columns, h: rows * 2 })
  const placed: { tile: Tile; col: number; row: number; width: number; height: number }[] = []
  rects.forEach((rect, i) => {
    const tile = sorted[i]!
    const col = Math.round(rect.x)
    const row = Math.round(rect.y / 2)
    const width = Math.round(rect.x + rect.w) - col
    const height = Math.round((rect.y + rect.h) / 2) - row
    if (width <= 0 || height <= 0) {
      return
    }
    // A gap on the right and the bottom keeps neighbours apart.
    const fillW = width > 2 ? width - 1 : width
    const fillH = height > 1 ? height - 1 : height
    for (let r = row; r < row + fillH; r++) {
      for (let c = col; c < col + fillW; c++) {
        g.put(r, c, 0x20, DEFAULT, tile.color)
      }
    }
    if (fillW >= 3) {
      g.text(row, col, tile.label.slice(0, fillW), 0xf4f4f4, tile.color)
    }
    placed.push({ tile, col, row, width, height })
  })

  return { ...g.done(), placed }
}

// A color between reads (blue) and edits (orange) by how much was edited.
export function touchColor(reads: number, edits: number) {
  const t = edits / Math.max(1, reads + edits)
  const mix = (from: number, to: number, shift: number) =>
    Math.round(((from >> shift) & 0xff) * (1 - t) + ((to >> shift) & 0xff) * t) << shift

  return mix(0x2f5f80, 0xb4532f, 16) | mix(0x2f5f80, 0xb4532f, 8) | mix(0x2f5f80, 0xb4532f, 0)
}

const NAMED = [
  // bun, claude plugin test: (pass) name [12ms]
  { re: /^\s*\((pass|fail)\)\s+(.+?)(?:\s+\[[^\]]*\])?\s*$/, ok: (m: RegExpMatchArray) => m[1] === 'pass', name: 2 },
  // jest, vitest, mocha: ✓ name (5 ms)
  { re: /^\s*([✓✔√✕✗✘×])\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/, ok: (m: RegExpMatchArray) => '✓✔√'.includes(m[1]!), name: 2 },
  // pytest -v: tests/x.py::test_a PASSED
  { re: /^(\S+::\S+)\s+(PASSED|FAILED|ERROR)\b/, ok: (m: RegExpMatchArray) => m[2] === 'PASSED', name: 1 },
  // cargo: test a::b ... ok
  { re: /^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED)/, ok: (m: RegExpMatchArray) => m[2] === 'ok', name: 1 },
  // go test -v: --- PASS: TestX
  { re: /^\s*--- (PASS|FAIL): (\S+)/, ok: (m: RegExpMatchArray) => m[1] === 'PASS', name: 2 },
]

const lastCount = (text: string, re: RegExp) => {
  const all = [...text.matchAll(re)]

  return all.length === 0 ? undefined : Number(all.at(-1)![1])
}

// Pass and fail counts and the tests named, from a test runner's output;
// nothing when the output looks like no test run.
export function parseTests(text: string) {
  const names: { name: string; ok: boolean }[] = []
  for (const line of text.split('\n')) {
    for (const { re, ok, name } of NAMED) {
      const m = line.match(re)
      if (m !== null) {
        names.push({ name: m[name]!.trim(), ok: ok(m) })
        break
      }
    }
  }
  const passed = lastCount(text, /(\d+)\s+pass(?:ed|ing|es)?\b/gi)
  const failed = lastCount(text, /(\d+)\s+fail(?:ed|ing|ures?|s)?\b/gi)
  if (passed === undefined && failed === undefined && names.length === 0) {
    return undefined
  }

  return {
    passed: passed ?? names.filter(one => one.ok).length,
    failed: failed ?? names.filter(one => !one.ok).length,
    names: names.slice(0, 200),
  }
}

// Tests that both passed and failed across the runs, flipping at least twice.
export function flaky(runs: TestRun[]) {
  const seen = new Map<string, boolean[]>()
  for (const run of runs) {
    for (const { name, ok } of run.names) {
      seen.set(name, [...(seen.get(name) ?? []), ok])
    }
  }

  return new Set(
    [...seen].filter(([, oks]) => oks.slice(1).filter((ok, i) => ok !== oks[i]).length >= 2).map(([name]) => name),
  )
}

// Runs across, tests down: the top row says how each run went, each row
// below how one test did in each run, a dot where the run did not name it.
export function scoreboard(runs: TestRun[], wanted: number, most: number) {
  const width = Math.max(1, Math.floor((wanted - LABEL - 1) / 2))
  const shown = runs.slice(-width)
  const last = shown.at(-1)
  const order = new Map<string, number>()
  shown.forEach((run, i) => run.names.forEach(({ name }) => order.set(name, i)))
  const failingNow = new Set(last?.names.filter(one => !one.ok).map(one => one.name) ?? [])
  const shaky = flaky(shown)
  const names = [...order]
    .sort(([a, i], [b, j]) => Number(failingNow.has(b)) - Number(failingNow.has(a)) || j - i)
    .map(([name]) => name)
    .slice(0, most)
  const columns = LABEL + 1 + shown.length * 2
  const g = grid(Math.max(LABEL + 2, columns), names.length + 1)

  g.text(0, 0, 'runs', BRIGHT)
  shown.forEach((run, i) => {
    g.put(0, LABEL + 1 + i * 2, FULL, run.failed > 0 || run.isError ? RED : GREEN)
  })
  names.forEach((name, row) => {
    g.text(row + 1, 0, name.slice(0, LABEL), shaky.has(name) ? ORANGE : DIM)
    shown.forEach((run, i) => {
      const result = run.names.find(one => one.name === name)
      g.put(
        row + 1,
        LABEL + 1 + i * 2,
        result === undefined ? 0x00b7 : 0x2586,
        result === undefined ? GRID : result.ok ? GREEN : RED,
      )
    })
  })

  return { ...g.done(), names, shaky }
}

// `git log --graph` written with %x1e before a commit's fields and %x1f
// between them, and --shortstat: commits with their stats, and the graph's
// joins and forks between them.
export function parseLog(stdout: string): CommitRow[] {
  const rows: CommitRow[] = []
  for (const line of stdout.split('\n')) {
    if (line.includes('\x1e')) {
      const [graph = '', fields = ''] = line.split('\x1e')
      const [sha, subject, when, refs] = fields.split('\x1f')
      rows.push({
        graph: graph.trimEnd(),
        ...(sha === undefined ? {} : { sha }),
        ...(subject === undefined ? {} : { subject }),
        ...(when === undefined ? {} : { when }),
        ...(refs === undefined || refs === '' ? {} : { refs }),
      })
      continue
    }
    const stat = line.match(/\d+ files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/)
    const commit = rows.findLast(row => row.sha !== undefined)
    if (stat !== null && commit !== undefined) {
      commit.added = Number(stat[1] ?? 0)
      commit.removed = Number(stat[2] ?? 0)
      continue
    }
    // The vertical runs between commits say nothing; forks and joins do.
    const graph = line.trimEnd()
    if (/[/\\]/.test(graph)) {
      rows.push({ graph })
    }
  }

  return rows
}

// A share bar under a transcript row: a count in words, then a bar whose
// parts are in proportion, at most `most` cells long.
export function shareBar(parts: { n: number; color: number; word: string }[], most: number) {
  const words = parts.map(part => `${part.word}`).join(' ')
  const total = parts.reduce((sum, part) => sum + part.n, 0)
  const width = Math.min(most, Math.max(1, total))
  const cells = parts.map(part => (total === 0 ? 0 : Math.round((part.n / total) * width)))
  // Every part that has any shows at least one cell, taken from the largest.
  parts.forEach((part, i) => {
    if (part.n > 0 && cells[i] === 0) {
      cells[i] = 1
    }
  })
  while (cells.reduce((a, b) => a + b, 0) > width) {
    const most = cells.indexOf(Math.max(...cells))
    cells[most] = cells[most]! - 1
  }
  const g = grid([...words].length + 1 + cells.reduce((a, b) => a + b, 0), 1)
  let col = 0
  parts.forEach((part, i) => {
    g.text(0, col, part.word, part.color)
    col += [...part.word].length + (i < parts.length - 1 ? 1 : 0)
  })
  col += 1
  parts.forEach((part, i) => {
    for (let n = 0; n < cells[i]!; n++, col++) {
      g.put(0, col, FULL, part.color)
    }
  })

  return g.done()
}

// Lines added and removed by an Edit or Write, from the tool's own record.
export function patchCounts(output: unknown) {
  const record = (output ?? {}) as {
    type?: string
    content?: string
    structuredPatch?: { lines?: string[] }[]
  }
  const lines = (record.structuredPatch ?? []).flatMap(hunk => hunk.lines ?? [])
  if (lines.length === 0 && record.type === 'create' && typeof record.content === 'string') {
    return { added: record.content.split('\n').length, removed: 0 }
  }

  return {
    added: lines.filter(line => line.startsWith('+')).length,
    removed: lines.filter(line => line.startsWith('-')).length,
  }
}
