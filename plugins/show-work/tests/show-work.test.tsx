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
  let now = 0
  on('clock.now', () => ({ value: (now += 1000) }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__show-work__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'work' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
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
    expect((await ui.find({ type: 'Text', text: /^Add a pause menu/ }))?.text).toBe(
      'Add a pause menu 1/3',
    )
    expect((await ui.find({ type: 'Text', text: /Build the menu/ }))?.text).toBe(
      '▸ Build the menu',
    )
    await ui.unmount()
  }
})

test('pressing a note quotes it into the prompt; sending a reply marks it', async ($, on) => {
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
    // Now holds the open question and no decision.
    const ask = await ui.find({ type: 'Button', text: /Esc also close/ })
    expect(ask?.text).toBe('I ask Should Esc also close the menu? · answer me')
    expect(await ui.find({ type: 'Button', text: /CanvasLayer/ })).toBeUndefined()
    await ui.press({ key: 'tab-notes' })
    expect(await ui.find({ type: 'Text', text: /Press a question to answer/ })).toBeDefined()
    expect((await ui.find({ type: 'Button', text: /CanvasLayer/ }))?.text).toBe(
      'I chose Use a CanvasLayer for the menu · veto? ▸',
    )
    await ui.press({ key: 'tab-now' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const ask = await ui.find({ type: 'Button', text: /Esc also close/ })
  await ui.press({ key: ask?.key ?? '' })
  expect(filled).toEqual(['About your question "Should Esc also close the menu?": '])
  // Pressing alone, or sending the quote with nothing after it, is no reply.
  expect(await ui.find({ type: 'Button', text: /Esc also close/ })).toBeDefined()
  await $.prompt.submit({ text: filled[0] ?? '' })
  expect(await ui.find({ type: 'Button', text: /Esc also close/ })).toBeDefined()
  await $.prompt.submit({ text: `${filled[0]}Yes, and Start too.` })
  expect(await ui.find({ type: 'Button', text: /Esc also close/ })).toBeUndefined()
  await ui.press({ key: 'tab-notes' })
  expect((await ui.find({ type: 'Button', text: /Esc also close/ }))?.text).toMatch(/↩ replied$/)
  await ui.unmount()
})

test('pressing another note opens it to its why, detail and actions', async ($, on) => {
  const filled = engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__show-work__note',
    kind: 'decision',
    text: 'Use a CanvasLayer for the menu',
    why: 'It draws above the game camera',
    detail: 'A Control under the camera would scroll with the level.',
  })
  await $.tool.call({
    tool: 'mcp__show-work__note',
    kind: 'finding',
    text: 'The save system already writes to user://',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-notes' })
  expect(await ui.find({ type: 'Text', text: /why: It draws above/ })).toBeUndefined()

  const decision = await ui.find({ type: 'Button', text: /CanvasLayer/ })
  await ui.press({ key: decision?.key ?? '' })
  expect((await ui.find({ type: 'Button', text: /CanvasLayer/ }))?.text).toMatch(/veto\? ▾$/)
  expect(await ui.find({ type: 'Text', text: /why: It draws above/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /would scroll with the level/ })).toBeDefined()
  expect(filled).toEqual([])

  // Veto starts a reply and closes the note; sending it marks it replied.
  await ui.press({ key: `reply-${decision?.key}` })
  expect(filled).toEqual([`About your decision "Use a CanvasLayer for the menu": I'd rather `])
  expect(await ui.find({ type: 'Text', text: /why: It draws above/ })).toBeUndefined()
  await $.prompt.submit({ text: `${filled[0]}use a Control.` })
  expect((await ui.find({ type: 'Button', text: /CanvasLayer/ }))?.text).toMatch(/↩ replied$/)

  // Got it marks the finding read without a reply.
  const finding = await ui.find({ type: 'Button', text: /user:\/\// })
  await ui.press({ key: finding?.key ?? '' })
  await ui.press({ key: `ok-${finding?.key}` })
  expect((await ui.find({ type: 'Button', text: /user:\/\// }))?.text).toMatch(/✓ ok$/)
  expect(filled).toHaveLength(1)
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
    expect(await ui.find({ type: 'Text', text: /main\.tscn/ })).toBeDefined()
    await ui.press({ key: 'tab-activity' })
    expect((await ui.find({ type: 'Text', text: /calls,/ }))?.text).toBe(
      '3 calls, 1 files changed, 1 failed',
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
    await ui.press({ key: 'tab-now' })
    await ui.unmount()
  }
})

test('repeated edits of a file fold into one row with a count', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const edit = { tool: 'Edit', file_path: '/proj/scripts/pause.gd', old_string: 'a', new_string: 'b' }
  await $.tool.call(edit)
  await $.tool.call({ tool: 'Read', file_path: '/proj/scenes/main.tscn' })
  await $.tool.call(edit)
  await $.tool.call(edit)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-activity' })
  expect((await ui.find({ type: 'Text', text: /calls,/ }))?.text).toBe(
    '4 calls, 1 files changed',
  )
  const rows = await ui.findAll({ type: 'Text', text: /^✓ (read|edit)/ })
  expect(rows.map(row => row.text)).toEqual([
    '✓ read   scenes/main.tscn',
    '✓ edit   ×3 scripts/pause.gd',
  ])
  await ui.unmount()
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

// The host beneath freeze: a cache under HOME, files that exist, and the
// image tools answering as they would for a 1600x900 picture.
function host(on: On) {
  const ran: string[][] = []
  const written: string[] = []
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: !String(e.path).includes('missing') }))
  on('fs.write', (_, e) => {
    written.push(e.path)

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const stdout = e.argv[1] === 'identify' ? '1600 900' : ''

    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })

  return { ran, written }
}

const RESULT = (tool_use_id: string) =>
  ({
    plugin: 'show-work',
    component: 'ToolResult',
    requestId: tool_use_id,
    props: { tool_use_id, tool: 'mcp__show-work__show', output: '', isErrored: false },
  }) as const

test('a shown SVG is converted and drawn in the chat', async ($, on) => {
  engine(on)
  const { ran, written } = host(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const shown = await $.tool.call({
    tool: 'mcp__show-work__show',
    tool_use_id: 'toolu_a',
    caption: 'Pause menu layout',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"/>',
  })
  expect(shown.result).toBe('Shown in the chat and the pane: Pause menu layout (1600x900).')
  expect(written).toEqual(['/home/u/.cache/show-work/toolu_a.svg'])
  expect(ran).toContainEqual([
    'rsvg-convert',
    '-o',
    '/home/u/.cache/show-work/toolu_a.png',
    '/home/u/.cache/show-work/toolu_a.svg',
  ])

  const chat = await $.ui.mount({ ...RESULT('toolu_a'), surface: 'terminal' })
  const image = await chat.find({ type: 'Image' })
  expect(image?.props).toMatchObject({
    source: { file: '/home/u/.cache/show-work/toolu_a.png', format: 'png' },
    alt: 'Pause menu layout',
  })
  await chat.unmount()

  const desk = await $.ui.mount({ ...RESULT('toolu_a'), surface: 'desktop' })
  expect((await desk.find({ type: 'Text' }))?.text).toBe(
    'Pause menu layout: /home/u/.cache/show-work/toolu_a.png',
  )
  await desk.unmount()
})

test('show refuses a missing image and an empty call', async ($, on) => {
  engine(on)
  host(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const missing = await $.tool.call({
    tool: 'mcp__show-work__show',
    caption: 'x',
    path: 'missing.png',
  })
  expect(missing.deny).toBe('No image at /proj/missing.png.')
  const empty = await $.tool.call({ tool: 'mcp__show-work__show', caption: 'x' })
  expect(empty.deny).toBe('Give the path of an image or SVG source.')
})

test('a screenshot Claude reads lands in the pane, and the list picks one', async ($, on) => {
  engine(on)
  const { ran } = host(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r1', file_path: '/proj/shots/menu.png' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r2', file_path: '/proj/shots/hud.jpg' })
  expect(ran).toContainEqual(['cp', '/proj/shots/menu.png', '/home/u/.cache/show-work/toolu_r1.png'])
  expect(ran).toContainEqual([
    'magick',
    '/proj/shots/hud.jpg[0]',
    '/home/u/.cache/show-work/toolu_r2.png',
  ])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'tab-pictures' }))?.text).toBe('Pictures 2')
  await ui.press({ key: 'tab-pictures' })
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({
    source: { file: '/home/u/.cache/show-work/toolu_r2.png' },
    columns: 60,
    rows: 17,
  })
  await ui.press({ key: 'pic-toolu_r1' })
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({
    source: { file: '/home/u/.cache/show-work/toolu_r1.png' },
  })
  await ui.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ type: 'Text', text: '/home/u/.cache/show-work/toolu_r1.png' })).toBeDefined()
  await desk.unmount()
})

test('reading a picture already in the cache adds no copy', async ($, on) => {
  engine(on)
  const { ran } = host(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/home/u/.cache/show-work/toolu_a.png' })
  expect(ran.some(argv => argv[0] === 'cp')).toBe(false)
})

test('a new goal starts a new task and hides the old notes', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__show-work__plan', goal: 'First', steps: [] })
  await $.tool.call({ tool: 'mcp__show-work__note', kind: 'finding', text: 'Old news' })
  await $.tool.call({ tool: 'mcp__show-work__plan', goal: 'First', steps: [] })
  await $.tool.call({ tool: 'mcp__show-work__note', kind: 'finding', text: 'Same task' })
  await $.tool.call({ tool: 'mcp__show-work__plan', goal: 'Second', steps: [] })
  await $.tool.call({ tool: 'mcp__show-work__note', kind: 'risk', text: 'Fresh' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'tab-notes' }))?.text).toBe('Notes 1')
  await ui.press({ key: 'tab-notes' })
  expect(await ui.find({ type: 'Button', text: /Old news/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'earlier' }))?.text).toBe(
    'Show 2 from earlier tasks',
  )
  await ui.press({ key: 'earlier' })
  expect(await ui.find({ type: 'Button', text: /Old news/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Same task/ })).toBeDefined()
  await ui.unmount()
})

const DIFF = `diff --git a/src/menu.gd b/src/menu.gd
--- a/src/menu.gd
+++ b/src/menu.gd
@@ -1,2 +1,2 @@
 extends Control
-var open = false
+var is_open := false
`

test('pressing a changed file shows its diff, colored, and close returns', async ($, on) => {
  engine(on)
  const asked: string[][] = []
  on('process.run', (_, e) => {
    asked.push([...e.argv])
    const stdout = e.argv.includes('HEAD') ? DIFF : ''

    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/menu.gd', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-activity' })
  await ui.press({ key: 'file-src/menu.gd' })
  expect(asked.at(-1)).toEqual(['git', '-C', '/proj/src', 'diff', '--no-color', 'HEAD', '--', '/proj/src/menu.gd'])
  expect((await ui.find({ type: 'Text', text: /^\+var/ }))?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: /^-var/ }))?.props.color).toBe('error')
  expect(await ui.find({ type: 'Text', text: /^\+\+\+/ })).toBeUndefined()
  await ui.press({ key: 'diff-close' })
  expect(await ui.find({ type: 'Text', text: /^\+var/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /menu\.gd/ })).toBeDefined()
  await ui.unmount()
})

test('a new file diffs against nothing', async ($, on) => {
  engine(on)
  on('process.run', (_, e) => ({
    value: {
      exitCode: 1,
      stdout: e.argv.includes('--no-index') ? '@@ -0,0 +1 @@\n+hello\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: '/proj/new.txt', content: 'hello' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-activity' })
  await ui.press({ key: 'file-new.txt' })
  expect((await ui.find({ type: 'Text', text: '+hello' }))?.props.color).toBe('success')
  await ui.unmount()
})

test('a subagent gets a lane with its latest call, done when it stops', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'ag1' }))
  on('classic.SubagentStop', () => ({}))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({
    tool_use_id: 'toolu_a1',
    prompt: 'Find the menu scene',
    description: 'Find menu scene',
    subagentType: 'Explore',
  } as never)
  await $.tool.call({ tool: 'Read', file_path: '/proj/menu.tscn', agentId: 'ag1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Agents/ }))?.text).toBe('Agents 1 running')
  expect((await ui.find({ type: 'Text', text: /Find menu scene/ }))?.text).toBe(
    '… Find menu scene Explore · 1 call',
  )
  expect((await ui.find({ type: 'Text', text: /↳ read/ }))?.text).toBe('  ↳ read menu.tscn')
  // The Agent call returns while the subagent still runs.
  await $.tool.call({ tool: 'Agent', description: 'Find menu scene', prompt: 'x', tool_use_id: 'toolu_a1' } as never)
  expect((await ui.find({ type: 'Text', text: /^Agents/ }))?.text).toBe('Agents 1 running')
  await $.classic.SubagentStop({ agent_id: 'ag1', agent_type: 'Explore' } as never)
  expect((await ui.find({ type: 'Text', text: /^Agents/ }))?.text).toBe('Agents 0 running')
  expect((await ui.find({ type: 'Text', text: /Find menu scene/ }))?.text).toMatch(/^✓/)
  await ui.unmount()
})
