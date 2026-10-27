// What the pane draws in Raster cells, and the parsing behind it: pure
// functions of plain data, so the tests can read the cells back.

export const DEFAULT = 0x01000000
const GRID = 0x3a3a3a
const FULL = 0x2588
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

export type Bar = {
  label: string
  start: number
  end?: number
  color: number
  isSub: boolean
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
