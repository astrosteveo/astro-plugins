import type { ClientModule } from 'claude-code'

import { gutterWidth, lineAtRow, lineRows, shownRows } from './lines'

// A code or diff viewer the pointer can drag over: the lines it passes get a
// background, and letting go posts them, 0-based, for the hooks to offer.
export type ViewerProps = {
  id: string
  source: string
  path: string
  startLine: number
  format: 'source' | 'diff'
  isWrapped: boolean
  sel: { from: number; to: number } | null
}

type Live = {
  rows: number[]
  id: string
  sel: { from: number; to: number } | null
  // What was just picked, drawn until the hooks hand back the same as `sel`: no flicker back to the old pick.
  hold: { from: number; to: number } | null | undefined
  drag: { a: number; b: number } | null
  from: string
  moved: boolean
}
type State = { live: Live }

const Viewer: ClientModule<ViewerProps, State> = (props, surface) => {
  const { Box, Code, Text } = surface.elements
  const isDiff = props.format === 'diff'
  const all = props.source.split('\n')
  const lines = isDiff ? shownRows(all) : all
  const last = isDiff ? 0 : props.startLine + lines.length - 1
  const rows = lineRows(lines, surface.columns - 1 - gutterWidth(isDiff ? lines.length : last, isDiff), props.isWrapped)

  // The listener is set once, on the first draw; `live` holds what it reads.
  const live = surface.state?.live ?? { rows, id: props.id, sel: props.sel, hold: undefined as { from: number; to: number } | null | undefined, drag: null as { a: number; b: number } | null, from: '', moved: false }
  live.rows = rows
  live.id = props.id
  live.sel = props.sel
  const same = (a: { from: number; to: number } | null, b: { from: number; to: number } | null) =>
    a === b || (a !== null && b !== null && a.from === b.from && a.to === b.to)
  if (live.hold !== undefined && same(live.hold, props.sel)) {
    live.hold = undefined
  }
  const drag = live.drag
  const range = drag !== null ? { from: Math.min(drag.a, drag.b), to: Math.max(drag.a, drag.b) } : live.hold !== undefined ? live.hold : props.sel

  if (surface.state === undefined) {
    surface.onPointer(event => {
      if (event.button !== undefined && event.button !== 'left') {
        return
      }
      const at = lineAtRow(live.rows, event.y)
      const here = `${event.x},${event.y}`
      if (event.type === 'down') {
        live.drag = { a: at, b: at }
        live.from = here
        live.moved = false
      } else if (event.type === 'move' && live.drag !== null) {
        live.drag = { a: live.drag.a, b: at }
        live.moved = live.moved || here !== live.from
      } else if (event.type === 'up' && live.drag !== null) {
        const { a } = live.drag
        live.drag = null
        const pick = (from: number, to: number) => {
          live.hold = { from, to }
          surface.post({ id: live.id, from, to })
        }
        if (live.moved) {
          pick(Math.min(a, at), Math.max(a, at))
        } else if (live.sel !== null && live.sel.from === at && live.sel.to === at) {
          // A click on the one line picked puts it back.
          live.hold = null
          surface.post({ id: live.id, clear: true })
        } else if ((event.shift === true || event.alt === true) && live.sel !== null) {
          // Alt-click (shift-click, where the terminal passes it on) stretches the pick from where it began to this line.
          pick(Math.min(live.sel.from, at), Math.max(live.sel.from, at))
        } else {
          pick(at, at)
        }
      }
      surface.setState({ live })
    })
    surface.setState({ live })
  }

  // A bar beside the lines picked, one mark for each row they take.
  const bar = rows
    .flatMap((count, index) => Array.from({ length: count }, () => (range !== null && index >= range.from && index <= range.to ? '▌' : ' ')))
    .join('\n')

  return (
    <Box flexDirection="row">
      <Text color="claude">{bar}</Text>
      <Box flexGrow={1} flexDirection="column">
        <Code
          source={props.source === '' ? ' ' : props.source}
          path={props.path}
          {...(isDiff ? { format: 'diff' as const } : { startLine: props.startLine })}
          wrap={props.isWrapped ? 'wrap' : 'truncate-end'}
        />
      </Box>
    </Box>
  )
}

export default Viewer
