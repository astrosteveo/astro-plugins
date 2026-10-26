import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput, RenderNode, SessionAppendInput } from 'claude-code'

const pending = atom({ plugin: 'inline-thinking', key: 'pending' } as const, [], { shape: 'pending-1' })
const thoughts = atom({ plugin: 'inline-thinking', key: 'thoughts' } as const, [])
const isVerbose = atom({ plugin: 'inline-thinking', key: 'isVerbose' } as const, false)

// Each thinking block waits for the next thing the model does, a reply or a
// tool call, and is filed under that row's id: the row draws it above itself.
async function file($: EngineInterface, e: SessionAppendInput) {
  const said = e.message.content.flatMap(block =>
    block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim() !== ''
      ? [block.thinking.trim()]
      : [],
  )
  if (said.length > 0) {
    await update($, pending, list => [...list, ...said])
  }
  const done = e.message.content.find(block => block.type === 'text' || block.type === 'tool_use')
  if (done === undefined) {
    return
  }
  const held = await read($, pending)
  if (held.length === 0) {
    return
  }
  const id = done.type === 'tool_use' && typeof done.id === 'string' ? done.id : e.uuid
  await update($, memberOf(thoughts, { requestId: id }), () => held)
  await update($, pending, () => [])
}

// The summary's own markup, bold headings mostly, would show as stars.
function paragraphs(thought: string) {
  return thought
    .split(/\n\s*\n/)
    .map(part => part.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim())
    .filter(part => part !== '')
}

// Drawn as the engine draws a thinking block under --verbose: a dim italic ∴
// in the two-column gutter, the text beside it.
function drawn($: EngineInterface, e: RenderInput, said: string[], row: RenderNode) {
  const { Box, Text } = $.ui.resolve(e)

  return (
    <Box flexDirection="column">
      {said.map((thought, n) => (
        <Box key={`thought-${n}`} flexDirection="row" marginTop={1} width="100%">
          <Box minWidth={2}>
            <Text dimColor italic>
              ∴
            </Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} gap={1}>
            {paragraphs(thought).map((part, m) => (
              <Text key={`part-${m}`} dimColor italic>
                {part}
              </Text>
            ))}
          </Box>
        </Box>
      ))}
      {row}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const rows = await $.config.list()
    const verbose = rows.find(row => row.key === 'verbose')?.value === true
    await update($, isVerbose, () => verbose)

    return started
  })

  on('config.set', { key: 'verbose' }, async ($, e, next) => {
    const set = await next(e)
    if (set.deny === undefined) {
      await update($, isVerbose, () => set.value === true)
    }

    return set
  })

  // A subagent's rows draw in its own transcript, not here.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      await file($, e)
    }

    return next(e)
  })

  // Thinking that nothing followed (an Esc mid-thought) ends with the turn.
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    await update($, pending, () => [])

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const said = await read($, memberOf(thoughts, e))
    if (e.surface !== 'terminal' || said.length === 0 || (await read($, isVerbose))) {
      return next(e)
    }

    return drawn($, e, said, await next(e))
  })

  // The ctrl+o transcript and --verbose draw thinking themselves.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const said = await read($, memberOf(thoughts, e))
    if (e.surface !== 'terminal' || said.length === 0 || e.props.isExpanded === true) {
      return next(e)
    }

    return drawn($, e, said, await next(e))
  })

  // A folded run of calls draws the thinking before each of them above its
  // one line ("Thought for 15s, read 3 files").
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded) {
      return next(e)
    }
    const said: string[] = []
    for (const call of e.props.calls) {
      if (call.tool_use_id !== undefined) {
        said.push(...(await read($, memberOf(thoughts, { requestId: call.tool_use_id }))))
      }
    }
    if (said.length === 0) {
      return next(e)
    }

    return drawn($, e, said, await next(e))
  })
}
