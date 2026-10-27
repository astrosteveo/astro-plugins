// How a viewer's rows map to its lines: the pure part of the Client module
// that turns a mouse drag into a range of lines.

// The characters a line takes on screen.
const width = (line: string) => [...line].length

// The digits a gutter spends on its numbers, and a space after.
export function gutterWidth(last: number, isDiff = false) {
  return String(Math.max(1, last)).length + 1 + (isDiff ? 1 : 0)
}

// The rows each line takes in `columns`: one when long lines are cut, as many
// as its length asks when they wrap.
export function lineRows(lines: string[], columns: number, isWrapped: boolean) {
  const room = Math.max(1, columns)

  return lines.map(line => (isWrapped ? Math.max(1, Math.ceil(width(line) / room)) : 1))
}

// The index of the line a row belongs to, held to the first and last line.
export function lineAtRow(rows: number[], y: number) {
  let top = 0
  for (const [index, count] of rows.entries()) {
    top += count
    if (y < top) {
      return index
    }
  }

  return Math.max(0, rows.length - 1)
}

// The first row of a line, and how many rows a run of lines takes.
export function rowOf(rows: number[], index: number) {
  return rows.slice(0, Math.max(0, index)).reduce((sum, count) => sum + count, 0)
}

export function rowsIn(rows: number[], from: number, to: number) {
  return rows.slice(from, to + 1).reduce((sum, count) => sum + count, 0)
}

// The lines a diff draws: its hunk headers are read, not drawn.
export const shownRows = (lines: string[]) => lines.filter(line => !line.startsWith('@@'))
