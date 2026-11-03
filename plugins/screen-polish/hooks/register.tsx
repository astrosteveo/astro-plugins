import type { EngineInterface, PluginOptions, Register, RenderElement, RenderInput } from 'claude-code'

import { reply } from './reply'

type Call = {
  tool: string
  input: unknown
  isRunning: boolean
  isErrored: boolean
  isInterrupted: boolean
  output?: unknown
}

type Status = 'done' | 'failed' | 'running' | 'interrupted' | 'pending'

type Hunk = { oldStart: number; newStart: number; lines: string[] }

// A folded run of 20 reads would otherwise grow 20 rows; ctrl+o shows them all.
const GROUP_ROWS = 6
const BODY_LINES = 30
const ERROR_LINES = 8
// Wide enough for most names; a longer one widens it, for every row of a group.
const TOOL_COLUMN = 9

const GLYPHS: Record<Status, { glyph: string; color: string }> = {
  done: { glyph: '✓', color: 'success' },
  failed: { glyph: '✗', color: 'error' },
  running: { glyph: '◐', color: 'claude' },
  interrupted: { glyph: '⊘', color: 'warning' },
  pending: { glyph: '◌', color: 'inactive' },
}

const LABELS: Record<string, string> = {
  WebFetch: 'Fetch',
  WebSearch: 'Search',
  Task: 'Agent',
  TodoWrite: 'Todos',
  NotebookEdit: 'Notebook',
  ToolSearch: 'Tools',
}

const DOING: Record<string, string> = {
  requesting: 'Waiting',
  responding: 'Writing',
  // The engine already says `thinking` beside the word in this mode.
  thinking: 'Working',
  'tool-input': 'Preparing',
  'tool-use': 'Running',
}

// Set at session.start, which a reload runs again, so a module variable holds.
let cwd = ''

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

function text(value: unknown, key: string): string | undefined {
  const found = field(value, key)
  return typeof found === 'string' ? found : undefined
}

function count(value: unknown, key: string): number | undefined {
  const found = field(value, key)
  return typeof found === 'number' ? found : undefined
}

function lines(value: string): string[] {
  return value
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
}

function relative(path: string): string {
  return cwd !== '' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function label(tool: string): string {
  return LABELS[tool] ?? /^mcp__.+?__(.+)$/.exec(tool)?.[1] ?? tool
}

function status(call: Call): Status {
  if (call.isInterrupted) {
    return 'interrupted'
  }
  if (call.isErrored) {
    return 'failed'
  }

  if (call.isRunning) {
    return 'running'
  }

  // No result and not running: its input is still streaming, or it waits
  // its turn or a permission answer.
  return call.output === undefined ? 'pending' : 'done'
}

// What the model read for a failed call, less the engine's wrapping.
function errorLines(output: unknown): string[] {
  const said = typeof output === 'string' ? output : (text(output, 'error') ?? '')
  const all = lines(said.replace(/<\/?tool_use_error>/g, ''))

  return all.map((line, n) => (n === 0 ? line.replace(/^Error:\s*/, '') : line))
}

function target({ tool, input }: Call): string {
  const path = text(input, 'file_path') ?? text(input, 'notebook_path')
  if (path !== undefined) {
    return relative(path)
  }
  switch (tool) {
    case 'Bash':
      return text(input, 'description') ?? lines(text(input, 'command') ?? '')[0] ?? ''
    case 'Grep': {
      const where = text(input, 'path')
      return `"${text(input, 'pattern') ?? ''}"${where === undefined ? '' : ` in ${relative(where)}`}`
    }
    case 'WebFetch':
      return (text(input, 'url') ?? '').replace(/^https?:\/\//, '')
    case 'WebSearch':
    case 'ToolSearch':
      return `"${text(input, 'query') ?? ''}"`
    case 'Agent':
    case 'Task':
      return text(input, 'description') ?? ''
    case 'TodoWrite':
      return ''
  }
  const first = Object.values(typeof input === 'object' && input !== null ? input : {}).find(
    value => typeof value === 'string',
  )

  return typeof first === 'string' ? (lines(first)[0] ?? '') : ''
}

function changed(output: unknown): string {
  const patch = field(output, 'structuredPatch')
  if (text(output, 'type') === 'create') {
    return `new · ${(text(output, 'content') ?? '').split('\n').length} lines`
  }
  if (!Array.isArray(patch)) {
    return 'done'
  }
  const all = patch.flatMap(hunk => (Array.isArray(field(hunk, 'lines')) ? (field(hunk, 'lines') as string[]) : []))

  return `+${all.filter(line => line.startsWith('+')).length} −${all.filter(line => line.startsWith('-')).length}`
}

function read(output: unknown): string {
  const file = field(output, 'file')
  switch (text(output, 'type')) {
    case 'text': {
      const shown = count(file, 'numLines') ?? 0
      const total = count(file, 'totalLines') ?? shown
      const start = count(file, 'startLine') ?? 1
      return shown < total ? `lines ${start}–${start + shown - 1} of ${total}` : `${total} lines`
    }
    case 'image':
      return 'image'
    case 'pdf':
      return 'PDF'
    case 'notebook': {
      const cells = field(file, 'cells')
      return `${Array.isArray(cells) ? cells.length : 0} cells`
    }
    case 'parts':
      return `${count(file, 'count') ?? 0} pages`
    case 'file_unchanged':
      return 'unchanged'
  }

  return 'done'
}

function ran(output: unknown): string {
  if (text(output, 'backgroundTaskId') !== undefined) {
    return 'in background'
  }
  const stdout = lines(text(output, 'stdout') ?? '')
  const shown = stdout.length > 0 ? stdout : lines(text(output, 'stderr') ?? '')
  if (shown.length === 0) {
    return 'no output'
  }

  return shown.length === 1 ? (shown[0] ?? '') : `${shown.length} lines`
}

function summary(call: Call): string {
  const { tool, output } = call
  switch (status(call)) {
    case 'running':
      return 'running…'
    case 'pending':
      return ''
    case 'interrupted':
      return 'interrupted'
    case 'failed':
      // The error itself wraps under the row, where it has the full width.
      return 'failed'
    case 'done':
      break
  }
  switch (tool) {
    case 'Bash':
      return ran(output)
    case 'Read':
      return read(output)
    case 'Edit':
    case 'Write':
      return changed(output)
    case 'WebFetch':
      return `${count(output, 'code') ?? ''} ${text(output, 'codeText') ?? ''}`.trim()
    case 'WebSearch': {
      const results = field(output, 'results')
      const found = Array.isArray(results)
        ? results.reduce<number>((sum, entry) => {
            const content = field(entry, 'content')
            return sum + (Array.isArray(content) ? content.length : 0)
          }, 0)
        : 0
      return `${found} results`
    }
    case 'Agent':
    case 'Task':
      return field(output, 'status') === 'completed'
        ? `${count(output, 'totalToolUseCount') ?? 0} tool uses · ${duration(count(output, 'totalDurationMs') ?? 0)}`
        : 'in background'
    case 'TodoWrite': {
      const todos = field(output, 'newTodos')
      const all = Array.isArray(todos) ? todos : []
      return `${all.filter(todo => field(todo, 'status') === 'completed').length}/${all.length} done`
    }
  }

  return 'done'
}

// Hunks cut to the budget, each header recounted so the cut still parses.
function patchSource(patch: Hunk[], budget: number): { source: string; more: number } {
  const out: string[] = []
  let left = budget
  let more = 0
  for (const hunk of patch) {
    const body = hunk.lines.filter(line => !line.startsWith('\\'))
    const taken = body.slice(0, Math.max(0, left))
    more += body.length - taken.length
    left -= taken.length
    if (taken.length === 0) {
      continue
    }
    const before = taken.filter(line => !line.startsWith('+')).length
    const after = taken.filter(line => !line.startsWith('-')).length
    out.push(`@@ -${hunk.oldStart},${before} +${hunk.newStart},${after} @@`, ...taken)
  }

  return { source: out.join('\n'), more }
}

// A plugin beneath (inline-thinking, say) may wrap the engine's drawing in one
// of its own; the polished tree takes the engine's place inside it, so both
// show whichever order the plugins load in. A plugin beneath that drew no
// engine node at all keeps its own drawing.
function inPlaceOf(drawn: RenderElement, polished: RenderElement): RenderElement {
  if (drawn.type === 'engine') {
    return polished
  }
  const children = (drawn as { children?: unknown }).children
  if (!Array.isArray(children)) {
    return drawn
  }

  return {
    ...drawn,
    children: children.map(child =>
      typeof child === 'object' && child !== null ? inPlaceOf(child as RenderElement, polished) : child,
    ),
  } as RenderElement
}

function toolWidth(calls: Call[]): number {
  return Math.max(TOOL_COLUMN, ...calls.map(call => label(call.tool).length + 1))
}

// In the replies' two-column gutter, the glyph under a reply's text. What the
// call did shrinks before what came of it.
function row($: EngineInterface, e: RenderInput, call: Call, key: string, width: number): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const state = status(call)

  return (
    <Box key={key} flexDirection="row" paddingLeft={2}>
      <Box width={2} flexShrink={0}>
        <Text color={GLYPHS[state].color}>{GLYPHS[state].glyph}</Text>
      </Box>
      <Box width={width} flexShrink={0}>
        <Text weight="semibold">{label(call.tool)}</Text>
      </Box>
      <Box flexShrink={3} marginRight={2}>
        <Text wrap="truncate-end">{target(call)}</Text>
      </Box>
      <Box flexShrink={1}>
        {state === 'failed' ? (
          <Text color="error" wrap="truncate-end">
            {summary(call)}
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            {summary(call)}
          </Text>
        )}
      </Box>
    </Box>
  )
}

function errorDetail($: EngineInterface, e: RenderInput, output: unknown): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const all = errorLines(output)
  const more = all.length - ERROR_LINES

  return (
    <Box flexDirection="column" paddingLeft={4}>
      {all.slice(0, ERROR_LINES).map(line => (
        <Text color="error">{line}</Text>
      ))}
      {more > 0 && <Text dimColor>{`… ${more} more lines · ctrl+o`}</Text>}
    </Box>
  )
}

function result($: EngineInterface, e: RenderInput<'ToolResult'>): RenderElement {
  const { Box, Text, Code } = $.ui.resolve(e)
  const { tool, output } = e.props
  if (e.props.isErrored) {
    return errorDetail($, e, output)
  }
  const path = text(output, 'filePath')
  if ((tool === 'Edit' || tool === 'Write') && path !== undefined) {
    const created = text(output, 'type') === 'create'
    const all = (text(output, 'content') ?? '').split('\n')
    const patch = field(output, 'structuredPatch')
    const { source, more } = created
      ? { source: all.slice(0, BODY_LINES).join('\n'), more: Math.max(0, all.length - BODY_LINES) }
      : patchSource(Array.isArray(patch) ? (patch as Hunk[]) : [], BODY_LINES)
    if (source !== '') {
      return (
        <Box flexDirection="column" paddingLeft={4}>
          {created ? <Code source={source} path={path} startLine={1} /> : <Code source={source} path={path} format="diff" />}
          {more > 0 && <Text dimColor>{`… ${more} more lines · ctrl+o`}</Text>}
        </Box>
      )
    }
  }

  return <Box />
}

function group($: EngineInterface, e: RenderInput<'ToolGroup'>): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const { calls } = e.props
  const hidden = Math.max(0, calls.length - GROUP_ROWS)
  const width = toolWidth(calls.slice(hidden))

  return (
    <Box flexDirection="column" marginTop={1}>
      {hidden > 0 && (
        <Box paddingLeft={4}>
          <Text dimColor>{`⋯ ${hidden} earlier ${hidden === 1 ? 'call' : 'calls'} · ctrl+o`}</Text>
        </Box>
      )}
      {calls.slice(hidden).map((call, n) => (
        <Box key={call.tool_use_id ?? `call-${hidden + n}`} flexDirection="column">
          {row($, e, call, 'row', width)}
          {status(call) === 'failed' && errorDetail($, e, call.output)}
        </Box>
      ))}
    </Box>
  )
}

// Each redraw has a setting of its own (plugin.json's userConfig), shown in /config.
const isOn = (options: PluginOptions, key: string) => options[key] === true

export const register: Register = (on, options) => {
  on('session.start', async (_, e, next) => {
    cwd = e.cwd

    return next(e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!isOn(options, 'toolRows') || e.surface !== 'terminal' || e.props.isExpanded === true) {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)

    return inPlaceOf(await next(e), <Box marginTop={1}>{row($, e, e.props, e.requestId, toolWidth([e.props]))}</Box>)
  })

  // The row says what came of the call; under it only an error's detail and
  // an edit's diff, the parts worth reading.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!isOn(options, 'toolRows') || e.surface !== 'terminal' || e.props.isExpanded === true) {
      return next(e)
    }

    return inPlaceOf(await next(e), result($, e))
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const { calls, isExpanded, isCallsOnly } = e.props
    const hasTrouble = calls.some(call => call.isErrored || call.isInterrupted)
    // A group can hold rows that are not calls (a recalled memory, a hook's
    // timing); only the engine's own line shows those.
    if (!isOn(options, 'toolRows') || e.surface !== 'terminal' || isExpanded || (isCallsOnly === false && !hasTrouble)) {
      return next(e)
    }

    return inPlaceOf(await next(e), group($, e))
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!isOn(options, 'promptMarker') || e.surface !== 'terminal' || e.props.origin.kind !== 'composer' || e.props.isExpanded) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)

    return inPlaceOf(
      await next(e),
      <Box flexDirection="row" marginTop={1}>
        <Box width={2} flexShrink={0}>
          <Text color="claude" weight="bold">
            ❯
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text>{e.props.text}</Text>
        </Box>
      </Box>,
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // A summary row carries the terminal's own mark, which a tree of ours would drop.
    if (e.surface !== 'terminal' || e.props.isSummary === true) {
      return next(e)
    }
    const features = {
      code: isOn(options, 'inlineCode'),
      headings: isOn(options, 'headings'),
      rules: isOn(options, 'rules'),
      tasks: isOn(options, 'taskLists'),
      quotes: isOn(options, 'quotes'),
    }
    if (!Object.values(features).some(Boolean)) {
      return next(e)
    }

    return inPlaceOf(await next(e), reply($, e, features))
  })

  // Rewrites the word alone, so the engine still draws the elapsed time and
  // tokens it keeps beside it.
  on('ui.render', { component: 'Spinner' }, (_, e, next) => {
    if (!isOn(options, 'spinnerWords') || e.surface !== 'terminal') {
      return next(e)
    }

    return next({ ...e, props: { ...e.props, word: DOING[e.props.mode] ?? e.props.word } })
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!isOn(options, 'modeLabels') || e.surface !== 'terminal' || e.props.modes.length === 0) {
      return next(e)
    }
    const { Text } = $.ui.resolve(e)

    return inPlaceOf(await next(e), <Text dimColor>{e.props.modes.join(' · ')}</Text>)
  })
}
