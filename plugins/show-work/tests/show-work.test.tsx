import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'show-work',
  component: 'Pane',
  requestId: 'show-work',
  props: {
    title: 'Show work',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

// Nothing sits beneath the plugin: each hook here stands for the engine.
function engine(on: On) {
  const filled: string[] = []
  on('tool.register', (_, e) => ({ value: { tool: `mcp__show-work__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'work' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('tool.call', (_, e) =>
    e.tool === 'Bash' && String(e.command).startsWith('false')
      ? { isError: true, result: 'exit 1', text: 'exit 1' }
      : { result: {} },
  )

  return filled
}

test('an empty pane says what will show there', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Nothing yet/ }))?.text).toMatch(
      /plan, decisions and questions/,
    )
    await ui.unmount()
  }
})

test('the plan tool draws the goal and steps', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({
    tool: 'mcp__show-work__plan',
    goal: 'Add a pause menu',
    steps: [
      { text: 'Read the scene', status: 'done' },
      { text: 'Build the menu', status: 'doing' },
      { text: 'Playtest it', status: 'todo' },
      { text: '', status: 'todo' },
    ],
  })
  expect(ran.result).toBe('Plan shown: 1/3 steps done.')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Plan/ }))?.text).toBe('Plan 1/3')
    expect(await ui.find({ type: 'Text', text: 'Add a pause menu' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Build the menu/ }))?.text).toBe(
      '▸ Build the menu',
    )
    await ui.unmount()
  }
})

test('pressing a note quotes it into the prompt and marks it replied', async ($, on) => {
  const filled = engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__show-work__note',
    kind: 'decision',
    text: 'Use a CanvasLayer for the menu',
    why: 'It draws above the game camera',
  })
  await $.tool.call({
    tool: 'mcp__show-work__note',
    kind: 'question',
    text: 'Should Esc also close the menu?',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /why: It draws above/ })).toBeDefined()
    const ask = await ui.find({ type: 'Button', text: /Esc also close/ })
    expect(ask?.text).toBe('ask Should Esc also close the menu?')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const ask = await ui.find({ type: 'Button', text: /Esc also close/ })
  await ui.press({ key: ask?.key ?? '' })
  expect(filled).toEqual(['About your question "Should Esc also close the menu?": '])
  expect((await ui.find({ type: 'Button', text: /Esc also close/ }))?.text).toMatch(/↩$/)
  await ui.unmount()
})

test('a note without text is refused', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'mcp__show-work__note', kind: 'risk', text: ' ' })
  expect(ran.deny).toBe('A note needs text.')
})

test('activity logs reads, edits and failed commands', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/proj/scenes/main.tscn' })
  await $.tool.call({
    tool: 'Edit',
    file_path: '/proj/scripts/pause.gd',
    old_string: 'a',
    new_string: 'b',
  })
  await $.tool.call({ tool: 'Bash', command: 'false && echo', description: 'Run the tests' })
  await $.tool.call({ tool: 'ToolSearch', query: 'x', max_results: 1 })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Activity/ }))?.text).toBe(
      'Activity 3 calls, 1 files changed, 1 failed',
    )
    expect((await ui.find({ type: 'Text', text: /main\.tscn/ }))?.text).toBe(
      '✓ read   scenes/main.tscn',
    )
    expect((await ui.find({ type: 'Text', text: /Run the tests/ }))?.text).toBe(
      '✗ run    Run the tests',
    )
    expect((await ui.find({ type: 'Text', text: /\$ false/ }))?.text).toBe(
      '         $ false && echo',
    )
    await ui.unmount()
  }
})

test('the guide joins the system prompt last', async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({
    sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }],
  }))
  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  expect(sections.map(section => section.id)).toEqual(['intro', 'show-work:guide'])
  expect(sections[1]?.text).toMatch(/mcp__show-work__plan/)
})

test('/work clear empties the pane', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/proj/a.gd' })
  const ran = await $.command.run({
    command: 'work',
    args: 'clear',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(ran).toMatchObject({ text: 'Show work cleared.' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Nothing yet/ })).toBeDefined()
  await ui.unmount()
})

test('a TodoWrite list shows as the plan', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Write the shader', status: 'completed', activeForm: 'Writing' },
      { content: 'Tune the glow', status: 'in_progress', activeForm: 'Tuning' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Plan/ }))?.text).toBe('Plan 1/2')
  expect((await ui.find({ type: 'Text', text: /Tune the glow/ }))?.text).toBe('▸ Tune the glow')
  await ui.unmount()
})
