import type { ClientModule } from 'claude-code'

import { blockAt } from './explorer'

// One block of a rendered markdown file: prose or fenced code, drawn as the
// engine draws it. It reports its own height so every block knows where the
// others lie, and a drag that starts here may end in any block.
export type MdProps = {
  file: string
  index: number
  kind: 'md' | 'code'
  text: string
  lang: string
  // The rows each block takes, pictures included, in order.
  heights: number[]
  sel: { from: number; to: number } | null
}

type Live = { props: MdProps; reported: number; drag: boolean; moved: boolean; from: string; end: number }
type State = { live: Live }

const Block: ClientModule<MdProps, State> = (props, surface) => {
  const { Box, Code, Markdown, Text } = surface.elements
  const live = surface.state?.live ?? { props, reported: 0, drag: false, moved: false, from: '', end: -1 }
  live.props = props

  if (surface.state === undefined) {
    surface.onPointer(event => {
      if (event.button !== undefined && event.button !== 'left') {
        return
      }
      const here = `${event.x},${event.y}`
      if (event.type === 'down') {
        live.drag = true
        live.moved = false
        live.from = here
        live.end = -1
      } else if (event.type === 'move' && live.drag) {
        live.moved = live.moved || here !== live.from
        // The blocks passed over light up as the pointer goes, told to the hooks as each new one is reached.
        const end = blockAt(live.props.heights, live.props.index, event.y)
        if (live.moved && end !== live.end) {
          live.end = end
          const at = live.props.index
          surface.post({ id: `${live.props.file}#md`, from: Math.min(at, end), to: Math.max(at, end), drag: true })
        }
      } else if (event.type === 'up' && live.drag) {
        live.drag = false
        const id = `${live.props.file}#md`
        const sel = live.props.sel
        const at = live.props.index
        if (live.moved) {
          const end = blockAt(live.props.heights, at, event.y)
          surface.post({ id, from: Math.min(at, end), to: Math.max(at, end) })
        } else if (sel !== null && sel.from === at && sel.to === at) {
          // A click on the one block picked puts it back.
          surface.post({ id, clear: true })
        } else if ((event.shift === true || event.alt === true) && sel !== null) {
          surface.post({ id, from: Math.min(sel.from, at), to: Math.max(sel.from, at) })
        } else {
          surface.post({ id, from: at, to: at })
        }
      }
    })
    surface.setState({ live })
  }
  // The height this block drew at, told once and again only when it changes.
  if (surface.rows > 0 && surface.rows !== live.reported) {
    live.reported = surface.rows
    surface.post({ file: props.file, index: props.index, rows: surface.rows })
  }

  const isPicked = props.sel !== null && props.index >= props.sel.from && props.index <= props.sel.to
  const bar = Array.from({ length: Math.max(1, surface.rows) }, () => (isPicked ? '▌' : ' ')).join('\n')

  return (
    <Box flexDirection="row">
      <Text color="claude">{bar}</Text>
      <Box flexGrow={1} flexDirection="column">
        {props.kind === 'code' ? (
          <Code source={props.text === '' ? ' ' : props.text} {...(props.lang === '' ? {} : { language: props.lang })} />
        ) : (
          <Markdown key="md" text={props.text} />
        )}
      </Box>
    </Box>
  )
}

export default Block
