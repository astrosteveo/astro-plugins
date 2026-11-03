import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { segments, type Features, type Line, type Span } from './markdown'

/**
 * A reply block as this plugin draws it, or null to leave it to the engine.
 * `hasBullet` keeps Claude Code's `●` before a reply; without it the reply is
 * only indented.
 */
export function reply(
  $: EngineInterface,
  e: RenderInput<'AssistantMessage'>,
  features: Features,
  hasBullet: boolean,
): RenderElement | null {
  const parts = segments(e.props.text, features)
  if (parts === null && hasBullet) return null

  const { Box, Text, Link, Markdown } = $.ui.resolve(e)
  const columns = e.viewport?.columns ?? 80

  const runs = (spans: Span[]) =>
    spans.map(s => {
      if (s.code) {
        // A cell of the fill on each side, so the code reads as a chip.
        return (
          <Text color="permission" backgroundColor="userMessageBackground">
            {` ${s.text} `}
          </Text>
        )
      }
      if (s.href) return <Link href={s.href} label={s.text} />
      return (
        <Text weight={s.bold ? 'bold' : undefined} italic={s.italic} strikethrough={s.strike}>
          {s.text}
        </Text>
      )
    })

  const line = (l: Line) => {
    switch (l.kind) {
      case 'heading':
        // Claude Code draws every level below the first as plain bold; these step down.
        return (
          <Text
            weight="bold"
            color={l.depth <= 2 ? 'claude' : undefined}
            underline={l.depth === 1}
            italic={l.depth >= 4}
          >
            {runs(l.spans)}
          </Text>
        )
      case 'rule':
        return <Text color="subtle">{'─'.repeat(Math.max(3, columns - 4))}</Text>
      case 'quote':
        return (
          <Box flexDirection="row">
            <Box flexShrink={0} width={2}>
              <Text color="subtle">▎</Text>
            </Box>
            <Text italic>{runs(l.spans)}</Text>
          </Box>
        )
      case 'item': {
        const mark =
          l.task === 'done' ? (
            <Text color="success">✓ </Text>
          ) : l.task === 'open' ? (
            <Text color="subtle">○ </Text>
          ) : (
            <Text>{`${l.marker} `}</Text>
          )
        return (
          <Box flexDirection="row" paddingLeft={l.indent}>
            <Box flexShrink={0}>{mark}</Box>
            {l.task === 'done' ? <Text dimColor>{runs(l.spans)}</Text> : <Text>{runs(l.spans)}</Text>}
          </Box>
        )
      }
      case 'text':
        return (
          <Box paddingLeft={l.indent}>
            <Text>{runs(l.spans)}</Text>
          </Box>
        )
    }
  }

  const body =
    parts === null ? (
      <Markdown text={e.props.text} />
    ) : (
      parts.map((p, i) => (
        <Box flexDirection="column" marginTop={i === 0 ? 0 : 1}>
          {p.kind === 'markdown' ? <Markdown text={p.text} /> : p.lines.map(line)}
        </Box>
      ))
    )

  // The engine's own row: a blank row above, and a two-column gutter that holds
  // the reply's bullet on its first block.
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box flexShrink={0} width={2}>
        <Text color="text">{hasBullet && e.props.isFirstOfReply ? '●' : ' '}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {body}
      </Box>
    </Box>
  )
}
