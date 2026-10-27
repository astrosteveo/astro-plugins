import type { ClientModule } from 'claude-code'

import { hitRowText } from './explorer'
import type { HitItem } from './explorer'
import { lineAtRow, lineRows } from './lines'

// The search results as a list the pointer can drag over: a click opens a hit,
// a drag picks hits and posts the range of rows, 0-based, for the hooks.
export type HitsProps = { items: HitItem[]; sel: { from: number; to: number } | null }

type Live = {
  rows: number[]
  items: HitItem[]
  drag: { a: number; b: number } | null
  from: string
  moved: boolean
}
type State = { live: Live }

const Hits: ClientModule<HitsProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const rows = lineRows(props.items.map(hitRowText), surface.columns - 1, true)
  const live = surface.state?.live ?? { rows, items: props.items, drag: null as { a: number; b: number } | null, from: '', moved: false }
  live.rows = rows
  live.items = props.items
  const drag = live.drag
  const range = drag === null ? props.sel : { from: Math.min(drag.a, drag.b), to: Math.max(drag.a, drag.b) }

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
        const item = live.items[at]
        if (live.moved && (a !== at || here !== live.from)) {
          surface.post({ id: 'hits', from: Math.min(a, at), to: Math.max(a, at) })
        } else if (item !== undefined) {
          surface.post(item.kind === 'file' ? { open: item.file } : { open: item.file, line: item.line })
        }
      }
      surface.setState({ live })
    })
    surface.setState({ live })
  }

  const bar = rows
    .flatMap((count, index) => Array.from({ length: count }, () => (range !== null && index >= range.from && index <= range.to ? '▌' : ' ')))
    .join('\n')

  return (
    <Box flexDirection="row">
      <Text color="claude">{bar}</Text>
      <Box flexGrow={1} flexDirection="column">
        {props.items.map((item, index) =>
          item.kind === 'file' ? (
            <Text key={`h-${index}`} wrap="wrap">
              <Text color="suggestion" weight="bold">
                {item.file}
              </Text>{' '}
              <Text dimColor>{item.count}</Text>
            </Text>
          ) : (
            <Text key={`h-${index}`} wrap="wrap" dimColor>
              <Text color="warning">{String(item.line).padStart(5)}</Text> {item.text}
            </Text>
          ),
        )}
      </Box>
    </Box>
  )
}

export default Hits
