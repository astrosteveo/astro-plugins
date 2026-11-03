import type { On, RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// Nothing sits beneath the plugin: these hooks stand for the engine, whose own
// drawing is the `engine` node.
function engine(on: On) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
}

async function start($: Engine) {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
}

// The redraws screen-polish shipped with before its settings, all on.
const ALL = {
  options: { toolRows: true, promptMarker: true, spinnerWords: true, modeLabels: true },
}

const VIEWPORT = { columns: 100, rows: 40, isFullscreen: true }

const CALL = {
  tool_use_id: 'toolu_1',
  tool: 'Read',
  input: { file_path: '/proj/src/app.ts' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: { type: 'text', file: { filePath: '/proj/src/app.ts', content: '', numLines: 6, startLine: 1, totalLines: 6 } },
}

function site<C extends keyof RenderPropsOf>(component: C, props: RenderPropsOf[C], surface: 'terminal' | 'desktop' = 'terminal') {
  return { plugin: 'screen-polish', component, props, surface, requestId: 'r1', viewport: VIEWPORT } as const
}

async function texts($: Engine, target: ReturnType<typeof site>) {
  const ui = await $.ui.mount(target as never)
  const found = (await ui.findAll({ type: 'Text' })).map(text => text.text)
  await ui.unmount()

  return found
}

test('a finished call is one row: glyph, tool, path in the project, what came of it', ALL, async ($, on) => {
  engine(on)
  await start($)

  expect(await texts($, site('ToolUse', CALL))).toEqual(['✓', 'Read', 'src/app.ts', '6 lines'])
})

test("a shell row says what the call is for, and falls back to the command", ALL, async ($, on) => {
  engine(on)
  await start($)
  const bash = { ...CALL, tool: 'Bash', output: { stdout: Array(19).fill('x').join('\n'), stderr: '' } }

  expect(
    await texts($, site('ToolUse', { ...bash, input: { command: 'grep PATH ~/.zshrc', description: 'Check if $PATH exists in ~/.zshrc' } })),
  ).toEqual(['✓', 'Bash', 'Check if $PATH exists in ~/.zshrc', '19 lines'])
  expect((await texts($, site('ToolUse', { ...bash, input: { command: 'grep PATH ~/.zshrc' } })))[2]).toBe('grep PATH ~/.zshrc')
})

// The engine keeps its gutter out of a selection; a plugin can't, so rows
// start at the left edge.
test('a row is flush left, its tool named in full, its result right after what it did', ALL, async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount(site('ToolUse', { ...CALL, tool: 'AskUserQuestion', input: { questions: [] }, output: {} }) as never)
  const boxes = await ui.findAll({ type: 'Box' })

  expect(boxes.some(b => (b.props.paddingLeft ?? 0) !== 0)).toBe(false)
  expect(boxes.some(b => typeof b.props.width === 'number' && b.props.width < 'AskUserQuestion'.length + 1 && b.props.width !== 2)).toBe(false)
  expect(boxes.filter(b => typeof b.props.width === 'number' && b.props.width > 16)).toEqual([])
  await ui.unmount()
})

test('a running call says so, and a failed one says why', ALL, async ($, on) => {
  engine(on)
  await start($)
  const bash = { ...CALL, tool: 'Bash', input: { command: 'npm test\nnpm run lint' }, output: undefined }

  expect(await texts($, site('ToolUse', { ...bash, isRunning: true }))).toEqual(['◐', 'Bash', 'npm test', 'running…'])
  expect(await texts($, site('ToolUse', { ...bash, isErrored: true, output: 'Error: Exit code 1\nboom' }))).toEqual([
    '✗',
    'Bash',
    'npm test',
    'failed',
  ])
})

test('a call still being written, or waiting to run, is pending, not done', ALL, async ($, on) => {
  engine(on)
  await start($)

  expect(await texts($, site('ToolUse', { ...CALL, tool: 'Bash', input: {}, output: undefined }))).toEqual(['◌', 'Bash', '', ''])
})

test('each tool sums up its own result', ALL, async ($, on) => {
  engine(on)
  await start($)
  const cases: [string, unknown, unknown, string][] = [
    ['Bash', { command: 'echo hi' }, { stdout: 'hi\n', stderr: '' }, 'hi'],
    ['Bash', { command: 'ls' }, { stdout: 'a\nb\nc', stderr: '' }, '3 lines'],
    ['Bash', { command: 'true' }, { stdout: '', stderr: '' }, 'no output'],
    ['Bash', { command: 'serve' }, { stdout: '', stderr: '', backgroundTaskId: 'b1' }, 'in background'],
    ['Read', { file_path: '/proj/a.ts' }, { type: 'text', file: { numLines: 10, startLine: 21, totalLines: 90 } }, 'lines 21–30 of 90'],
    ['Edit', { file_path: '/proj/a.ts' }, { structuredPatch: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+c', '+d'] }] }, '+2 −1'],
    ['Write', { file_path: '/proj/new.ts' }, { type: 'create', content: 'a\nb' }, 'new · 2 lines'],
    ['WebFetch', { url: 'https://example.com/x' }, { code: 200, codeText: 'OK' }, '200 OK'],
    ['TodoWrite', { todos: [] }, { newTodos: [{ status: 'completed' }, { status: 'pending' }] }, '1/2 done'],
  ]
  for (const [tool, input, output, said] of cases) {
    const found = await texts($, site('ToolUse', { ...CALL, tool, input, output }))
    expect(found.at(-1)).toBe(said)
  }
})

test("an edit's result is its diff, cut at 30 lines with headers that still add up", ALL, async ($, on) => {
  engine(on)
  await start($)
  const lines = Array.from({ length: 40 }, (_, n) => (n % 2 === 0 ? `-old ${n}` : `+new ${n}`))
  const ui = await $.ui.mount(
    site('ToolResult', {
      tool_use_id: 'toolu_1',
      tool: 'Edit',
      isErrored: false,
      output: { filePath: '/proj/a.ts', structuredPatch: [{ oldStart: 3, oldLines: 20, newStart: 3, newLines: 20, lines }] },
    }) as never,
  )

  const code = await ui.find({ type: 'Code' })
  expect(code?.props.format).toBe('diff')
  expect(String(code?.props.source).split('\n')[0]).toBe('@@ -3,15 +3,15 @@')
  expect(String(code?.props.source).split('\n')).toHaveLength(31)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('… 10 more lines · ctrl+o')
  await ui.unmount()
})

test("a shell result draws nothing under its row; a failure draws the detail its row left out", ALL, async ($, on) => {
  engine(on)
  await start($)
  const result = { tool_use_id: 'toolu_1', tool: 'Bash', isErrored: false, output: { stdout: 'lots\nof\noutput', stderr: '' } }

  expect(await texts($, site('ToolResult', result))).toEqual([])
  expect(
    await texts($, site('ToolResult', { ...result, isErrored: true, output: 'Error: Exit code 2\nfirst\nsecond\nthird\nfourth' })),
  ).toEqual(['Exit code 2', 'first', 'second', 'third', 'fourth'])
})

// A one-line error can be longer than the row; cut there, it said nothing.
test('a failure shows its whole error, wrapped, up to 8 lines', ALL, async ($, on) => {
  engine(on)
  await start($)
  const long = `This session is isolated in the worktree ${'/deep/path'.repeat(20)}`
  const ui = await $.ui.mount(site('ToolResult', { tool_use_id: 'toolu_1', tool: 'Bash', isErrored: true, output: long }) as never)
  const shown = await ui.findAll({ type: 'Text' })

  expect(shown.map(t => t.text)).toEqual([long])
  expect(shown[0]?.props.wrap).not.toBe('truncate-end')
  await ui.unmount()

  const many = Array.from({ length: 12 }, (_, n) => `line ${n}`).join('\n')
  expect(
    await texts($, site('ToolResult', { tool_use_id: 'toolu_1', tool: 'Bash', isErrored: true, output: many })),
  ).toEqual([...Array.from({ length: 8 }, (_, n) => `line ${n}`), '… 4 more lines · ctrl+o'])
})

test('a folded run draws a row per call, the last six of a long one', ALL, async ($, on) => {
  engine(on)
  await start($)
  const calls = Array.from({ length: 8 }, (_, n) => ({ ...CALL, tool_use_id: `toolu_${n}` }))
  const found = await texts($, site('ToolGroup', { calls, isActive: false, isExpanded: false, isCallsOnly: true }))

  expect(found[0]).toBe('⋯ 2 earlier calls · ctrl+o')
  expect(found.filter(text => text === '✓')).toHaveLength(6)
})

test("a run that holds more than calls keeps the engine's line, unless a call failed", ALL, async ($, on) => {
  engine(on)
  await start($)
  const group = { calls: [CALL], isActive: false, isExpanded: false, isCallsOnly: false }

  expect(await texts($, site('ToolGroup', group))).toEqual([])
  expect(await texts($, site('ToolGroup', { ...group, calls: [{ ...CALL, isErrored: true, output: 'Error: gone' }] }))).toEqual([
    '✗',
    'Read',
    'src/app.ts',
    'failed',
    'gone',
  ])
})

test("the person's prompt gets an accent marker; other user rows are the engine's", ALL, async ($, on) => {
  engine(on)
  await start($)
  const prompt = { text: 'fix the login bug', origin: { kind: 'composer' }, isExpanded: false } as never

  expect(await texts($, site('UserMessage', prompt))).toEqual(['❯', 'fix the login bug'])
  expect(
    await texts($, site('UserMessage', { text: 'done', origin: { kind: 'task-notification' }, isExpanded: false } as never)),
  ).toEqual([])
})

test('a reply draws as markdown', ALL, async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount(site('AssistantMessage', { text: 'Fixed **it**.', isFirstOfReply: true }) as never)

  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('Fixed **it**.')
  await ui.unmount()
})

test('the spinner says what the turn is doing, and the engine draws the rest', ALL, async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.word}</Text>
  })
  await start($)
  const spinner = { word: 'Hyperspacing', message: null, suffix: '…' }

  expect(await texts($, site('Spinner', { ...spinner, mode: 'tool-use' }))).toEqual(['Running'])
  expect(await texts($, site('Spinner', { ...spinner, mode: 'thinking' }))).toEqual(['Working'])
})

test('the end of a turn keeps the engine\'s own line', ALL, async ($, on) => {
  engine(on)
  await start($)

  expect(await texts($, site('TurnDuration', { word: 'Baked', durationMs: 64_000, isExpanded: false }))).toEqual([])
})

test('mode labels are joined by a dot; none leaves the engine its own', ALL, async ($, on) => {
  engine(on)
  await start($)

  expect(await texts($, site('SessionMode', { modes: ['focus', 'memory paused'] }))).toEqual(['focus · memory paused'])
  expect(await texts($, site('SessionMode', { modes: [] }))).toEqual([])
})

test('a plugin beneath that wraps the row, as inline-thinking does, keeps its part', ALL, async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>thought</Text>
        {{ type: 'engine', ref: 0 } as never}
      </Box>
    )
  })
  await start($)

  expect(await texts($, site('ToolUse', CALL))).toEqual(['thought', '✓', 'Read', 'src/app.ts', '6 lines'])
})

test("ctrl+o, --verbose and other surfaces get the engine's drawing", ALL, async ($, on) => {
  engine(on)
  await start($)

  expect(await texts($, site('ToolUse', { ...CALL, isExpanded: true }))).toEqual([])
  expect(await texts($, site('ToolUse', CALL, 'desktop'))).toEqual([])
})
