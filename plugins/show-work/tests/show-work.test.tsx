import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

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
function engine(
  on: On,
  {
    isTicking = true,
    bash,
  }: { isTicking?: boolean; bash?: (command: string, id: string) => { text: string; isError?: boolean } | undefined } = {},
) {
  const filled: string[] = []
  let now = 0
  if (isTicking) {
    on('clock.now', () => ({ value: (now += 1000) }))
  }
  on('tool.register', (_, e) => ({ value: { tool: `mcp__show-work__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'work' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', (_, e) => {
    const said = e.tool === 'Bash' ? bash?.(String(e.command), e.tool_use_id) : undefined
    if (said !== undefined) {
      return said.isError === true
        ? { isError: true, result: said.text, text: said.text }
        : { result: {}, text: said.text }
    }

    return e.tool === 'Bash' && String(e.command).startsWith('false')
      ? { isError: true, result: 'exit 1', text: 'exit 1' }
      : { result: {} }
  })

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
  expect((await ui.find({ type: 'Button', key: 'tab-notes' }))?.text).toBe('Notes 2')
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
  expect((await ui.find({ type: 'Button', key: 'tab-notes' }))?.text).toBe('Notes 1')

  // Got it marks the finding read without a reply.
  const finding = await ui.find({ type: 'Button', text: /user:\/\// })
  await ui.press({ key: finding?.key ?? '' })
  await ui.press({ key: `ok-${finding?.key}` })
  expect((await ui.find({ type: 'Button', text: /user:\/\// }))?.text).toMatch(/✓ ok$/)
  // Every note is done, so the tab shows no count.
  expect((await ui.find({ type: 'Button', key: 'tab-notes' }))?.text).toBe('Notes')
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
  // The hunks go to Code as a diff, which highlights them; the headers do not.
  const code = await ui.find({ type: 'Code' })
  expect(code?.props).toMatchObject({ format: 'diff', path: 'src/menu.gd' })
  expect(code?.props.source).toBe('@@ -1,2 +1,2 @@\n extends Control\n-var open = false\n+var is_open := false')
  await ui.press({ key: 'diff-close' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
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
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -0,0 +1 @@\n+hello')
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

import { divider, duration } from '../hooks/register'
import {
  area,
  base64,
  patchCounts,
  shareBar,
  flaky,
  gantt,
  gauge,
  glyphs,
  legend,
  parseLog,
  parseTests,
  pulse,
  scoreboard,
  treemap,
} from '../hooks/charts'

const decode = (cells: string, columns: number, rows: number) => {
  const bin = atob(cells)
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  const lines: string[] = []
  for (let row = 0; row < rows; row++) {
    let line = ''
    for (let col = 0; col < columns; col++) {
      line += String.fromCharCode(words[(row * columns + col) * 3] ?? 0)
    }
    lines.push(line)
  }

  return { lines, words }
}

test('base64 matches the standard padded form', () => {
  const enc = (text: string) => base64(Uint8Array.from(text, ch => ch.charCodeAt(0)))
  expect([enc(''), enc('f'), enc('fo'), enc('foo'), enc('foob')]).toEqual(['', 'Zg==', 'Zm8=', 'Zm9v', 'Zm9vYg=='])
})

test('durations and turn dividers read plainly', () => {
  expect([duration(38_000), duration(252_000), duration(60_000)]).toEqual(['38s', '4m12s', '1m00s'])
  const turn = { id: 't', n: 4, start: 0, end: 38_000, calls: 12, failed: 1 }
  expect(divider(turn, 4, 99_000)).toBe('── turn 4 · 38s · 12 calls · 1 failed ──')
  expect(divider({ ...turn, end: undefined, failed: 0 }, 4, 5_000)).toBe('── turn 4 · 5s… · 12 calls ──')
})

test('the gantt lays bars across time with half-cell ends', () => {
  const columns = 35 // a 14-column label, a gap, 20 columns of bars
  const chart = gantt(
    [
      { label: 'turn 1', start: 0, end: 10_000, color: 0xd97757, isSub: false },
      { label: 'Find menu', start: 5_000, end: 7_500, color: 0x5fa8d3, isSub: true },
      { label: 'turn 2', start: 15_000, color: 0xf0a070, isSub: false },
    ],
    20_000,
    columns,
  )
  const { lines, words } = decode(chart.cells, columns, chart.rows)
  // 20s over 20 columns: a column is a second, a half column half of one.
  expect(lines).toEqual([
    'turn 1         ██████████  ·     · ',
    '↳ Find menu    ·    ██▌    ·     · ',
    'turn 2         ·     ·     ·  █████',
  ])
  // A bar's cells carry its color; a label's do not.
  expect(words[(0 * columns + 15) * 3 + 1]).toBe(0xd97757)
})

test('turns draw dividers in Activity and bars on the Timeline', async ($, on) => {
  engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'fix it', turnId: 'turn-a' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/proj/a.gd' })
  await $.tool.call({ tool: 'Bash', command: 'false' })
  await $.turn.complete({ turnId: 'turn-a', reason: 'answer', answer: '', durationMs: 0, isAborted: false } as never)
  await $.turn.start({ text: 'again', turnId: 'turn-b' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/proj/b.gd' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-activity' })
  expect((await ui.find({ type: 'Text', text: /── turn 1/ }))?.text).toMatch(/^── turn 1 · \ds · 2 calls · 1 failed ──$/)
  expect((await ui.find({ type: 'Text', text: /── turn 2/ }))?.text).toMatch(/^── turn 2 · \ds… · 1 call ──$/)
  await ui.press({ key: 'tab-timeline' })
  expect((await ui.find({ type: 'Text', text: /turns ·/ }))?.text).toMatch(/^2 turns · 1 running/)
  const raster = await ui.find({ type: 'Raster' })
  expect(raster?.props.rows).toBe(2)
  await ui.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'tab-timeline' })
  expect((await desk.find({ type: 'Text', text: /^turn 2/ }))?.text).toMatch(/…$/)
  await desk.unmount()
})

test('the legend swatches use the chart colors', () => {
  const key = legend([
    [0xd97757, 'turn'],
    [0x5fa8d3, 'subagent'],
  ])
  const { lines, words } = decode(key.cells, key.columns, 1)
  expect(lines[0]).toBe('█ turn  █ subagent')
  expect(words[1]).toBe(0xd97757)
  expect(words[8 * 3 + 1]).toBe(0x5fa8d3)
})

test('a running bar grows between redraws, repainted by blit, and stops when done', async ($, on) => {
  engine(on, { isTicking: false })
  const clock = mock.clock(on, { now: 1_000 })
  const blits: { cells: string; columns: number; rows: number }[] = []
  on('ui.blit', (_, e) => {
    if ('cells' in e && e.cells !== undefined) {
      blits.push({ cells: e.cells, columns: e.columns ?? 0, rows: e.rows ?? 0 })
    }

    return { value: {} }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-a' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-timeline' })
  await clock.advance(10_000)
  const count = blits.length
  expect(count).toBeGreaterThan(30)
  // The bar fills its row by now, and the leading cell pulses frame to frame.
  const last = decode(blits.at(-1)!.cells, blits.at(-1)!.columns, 1)
  expect(last.lines[0]?.slice(15).trim()).toMatch(/^█+$/)
  const heads = blits.slice(-2).map(one => {
    const words = decode(one.cells, one.columns, 1).words
    return words[(one.columns - 1) * 3 + 1]
  })
  expect(new Set(heads).size).toBe(2)

  await $.turn.complete({ turnId: 'turn-a', reason: 'answer', answer: '', durationMs: 0, isAborted: false } as never)
  await clock.advance(2_000)
  const after = blits.length
  await clock.advance(5_000)
  expect(blits.length).toBe(after)
  await ui.unmount()
})

test('labels a Raster cannot draw turn to ?, and a narrow pane still fits', () => {
  expect(String.fromCharCode(...glyphs('fix 🐛 バグ ↳'))).toBe('fix ? ?? ↳')
  const chart = gantt([{ label: 'ship 🚀', start: 0, end: 500, color: 0xd97757, isSub: true }], 1_000, 8)
  expect(chart.columns).toBe(19)
  const { lines } = decode(chart.cells, chart.columns, chart.rows)
  expect(lines[0]?.slice(0, 9)).toBe('↳ ship ? ')
  expect(gantt([], 1_000, 40)).toMatchObject({ rows: 0, cells: '' })
})

test('test output from five runners is read for counts and names', () => {
  expect(parseTests('(pass) adds [1ms]\n(fail) subtracts [2ms]\n\n 1 pass\n 1 fail\n')).toEqual({
    passed: 1,
    failed: 1,
    names: [
      { name: 'adds', ok: true },
      { name: 'subtracts', ok: false },
    ],
  })
  expect(parseTests(' ✓ renders (5 ms)\n ✕ clicks\nTests: 1 failed, 1 passed, 2 total')).toMatchObject({
    passed: 1,
    failed: 1,
    names: [{ name: 'renders', ok: true }, { name: 'clicks', ok: false }],
  })
  expect(parseTests('tests/a.py::test_x PASSED  [ 50%]\n=== 1 passed in 0.1s ===')?.names).toEqual([
    { name: 'tests/a.py::test_x', ok: true },
  ])
  expect(parseTests('test a::b ... ok\ntest result: ok. 1 passed; 0 failed')).toMatchObject({ passed: 1, failed: 0 })
  expect(parseTests('--- FAIL: TestJump (0.00s)')).toMatchObject({ passed: 0, failed: 1 })
  expect(parseTests('compiled fine')).toBeUndefined()
})

const run = (id: string, names: [string, boolean][], extra = {}) => ({
  id,
  at: 0,
  command: 'bun test',
  passed: names.filter(([, ok]) => ok).length,
  failed: names.filter(([, ok]) => !ok).length,
  isError: false,
  names: names.map(([name, ok]) => ({ name, ok })),
  ...extra,
})

test('the scoreboard puts failing tests first and flags flips as flaky', () => {
  const runs = [
    run('r1', [['jump', true], ['dash', true]]),
    run('r2', [['jump', false], ['dash', true]]),
    run('r3', [['jump', true], ['dash', false]]),
  ]
  expect([...flaky(runs)]).toEqual(['jump'])
  const board = scoreboard(runs, 40, 10)
  expect(board.names).toEqual(['dash', 'jump'])
  const { lines, words } = decode(board.cells, board.columns, board.rows)
  expect(lines).toEqual(['runs           █ █ █ ', 'dash           ▆ ▆ ▆ ', 'jump           ▆ ▆ ▆ '])
  const fg = (row: number, col: number) => words[(row * board.columns + col) * 3 + 1]
  expect([fg(0, 15), fg(0, 17), fg(0, 19)]).toEqual([0x6cc070, 0xe06c75, 0xe06c75])
  expect([fg(1, 15), fg(1, 19)]).toEqual([0x6cc070, 0xe06c75])
  expect(fg(2, 0)).toBe(0xe0a040)
})

test('the pulse stacks calls into buckets, newest on the right', () => {
  const beats = [
    { at: 9_500, kind: 'read', status: 'ok' },
    { at: 9_800, kind: 'edit', status: 'ok' },
    { at: 5_000, kind: 'run', status: 'failed' },
  ]
  const strip = pulse(beats, 10_000, 6, 1000)
  const { lines, words } = decode(strip.cells, 6, 1)
  // Two calls in the last second, one five seconds back; four fill a cell.
  expect(lines[0]).toBe('▂▁▁▁▁▄')
  expect(words[5 * 3 + 1]).toBe(0xe0a040)
  expect(words[0 * 3 + 1]).toBe(0xe06c75)
})

test('the gauge fills by fraction, colors by level and marks compaction', () => {
  const { lines, words } = decode(gauge(0.6, 10, 0.8).cells, 10, 1)
  expect(lines[0]).toBe('██████░░┃░')
  expect(words[1]).toBe(0xe0a040)
})

test('the area chart rises in eighths and draws the compaction line', () => {
  const chart = area([0.25, 0.5, 1], 9, 4, 0.75)
  expect(decode(chart.cells, 9, 4).lines).toEqual([
    '──────██─',
    '      ██ ',
    '   ██ ██ ',
    '██ ██ ██ ',
  ])
})

test('the treemap covers the box and labels the tiles that fit', () => {
  const map = treemap(
    [
      { label: 'player.gd', weight: 6, color: 0xb4532f },
      { label: 'menu.gd', weight: 3, color: 0x2f5f80 },
      { label: 'x', weight: 1, color: 0x2f5f80 },
    ],
    30,
    6,
  )
  expect(map.placed.map(one => one.tile.label)).toEqual(['player.gd', 'menu.gd', 'x'])
  const biggest = map.placed[0]!
  expect(biggest.width * biggest.height).toBeGreaterThan(80)
  const { lines, words } = decode(map.cells, 30, 6)
  expect(lines[biggest.row]?.slice(biggest.col, biggest.col + 9)).toBe('player.gd')
  expect(words[(biggest.row * 30 + biggest.col) * 3 + 2]).toBe(0xb4532f)
})

test('git log --graph reads into commits with stats and forks', () => {
  const out = [
    '* \x1e3d4035d\x1fadd timeline\x1f2 hours ago\x1fHEAD -> work',
    '|  2 files changed, 418 insertions(+), 4 deletions(-)',
    '| * \x1eabc1234\x1fside fix\x1f3 hours ago\x1f',
    '|/  ',
    '|  1 file changed, 1 deletion(-)',
    '* \x1e0f88d45\x1freadme\x1f4 hours ago\x1f',
  ].join('\n')
  expect(parseLog(out)).toEqual([
    { graph: '*', sha: '3d4035d', subject: 'add timeline', when: '2 hours ago', refs: 'HEAD -> work', added: 418, removed: 4 },
    { graph: '| *', sha: 'abc1234', subject: 'side fix', when: '3 hours ago', added: 0, removed: 1 },
    { graph: '|/' },
    { graph: '*', sha: '0f88d45', subject: 'readme', when: '4 hours ago' },
  ])
})

const USAGE = {
  startedAt: 0,
  context: {
    tokens: 120_000,
    window: 200_000,
    percent: 60,
    breakdown: {
      categories: [
        { name: 'System prompt', tokens: 20_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
        { name: 'Messages', tokens: 100_000, color: 'permission', isDeferred: false, kind: 'used' },
        { name: 'Free space', tokens: 47_000, color: 'inactive', isDeferred: false, kind: 'free' },
        { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
      ],
    },
  },
  rateLimits: [{ kind: 'five_hour', percentUsed: 23 }],
  cost: { usd: 4.2 },
}

test('the Context tab shows the gauge, what fills it and each turn', async ($, on) => {
  engine(on)
  on('session.usage', () => ({ value: USAGE }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({
    text: '',
    usage: { model: 'm', input_tokens: 12_300, output_tokens: 1_200, cache_read_input_tokens: 98_000, cache_creation_input_tokens: 3_100 },
  }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-a' } as never)
  await $.turn.complete({ turnId: 'turn-a', reason: 'answer', answer: '', durationMs: 0, isAborted: false } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-context' })
  expect((await ui.find({ type: 'Text', text: /compacts at/ }))?.text).toBe(
    'Context 60% 120k / 200k · compacts at 167k · $4.20 so far',
  )
  expect(await ui.find({ type: 'Raster', key: 'ctx-gauge' })).toBeDefined()
  expect(await ui.find({ type: 'Raster', key: 'ctx-area' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^turn 1:/ }))?.text).toBe(
    'turn 1: 12.3k in · 1.2k out · 98.0k cache read · 3.1k cache write',
  )
  expect((await ui.find({ type: 'Text', text: /^limits/ }))?.text).toBe('limits: five hour 23%')
  await ui.press({ key: 'tab-now' })
  expect((await ui.find({ type: 'Text', text: /context 60%/ }))?.text).toMatch(/context 60% · \$4\.20$/)
  await ui.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'tab-context' })
  expect((await desk.find({ type: 'Text', text: /^Messages/ }))?.text).toBe('Messages 100k')
  await desk.unmount()
})

const BUN_OUT = (jump: boolean) =>
  `(pass) dash [1ms]\n(${jump ? 'pass' : 'fail'}) jump [2ms]\n\n ${jump ? 2 : 1} pass\n ${jump ? 0 : 1} fail\n`

test('test commands land on the Tests tab as runs', async ($, on) => {
  let jump = true
  engine(on, {
    bash: command =>
      command.startsWith('bun test') ? { text: BUN_OUT(jump), isError: !jump } : undefined,
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'bun test', description: 'Run the suite' })
  jump = false
  await $.tool.call({ tool: 'Bash', command: 'bun test', description: 'Run the suite' })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-tests' })
    expect((await ui.find({ type: 'Text', text: /pass · \d fail/ }))?.text).toMatch(/^✗ 1 pass · 1 fail bun test · \d+s ago$/)
    expect((await ui.find({ type: 'Raster', key: 'tests-board' })) !== undefined).toBe(surface === 'terminal')
    expect(await ui.find({ type: 'Text', text: /^✓\s+2 pass/ })).toBeDefined()
    await ui.press({ key: 'tab-now' })
    await ui.unmount()
  }
})

test('files read and edited draw as tiles; pressing one opens its diff', async ($, on) => {
  engine(on)
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '@@ -1 +1 @@\n-a\n+b\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/proj/player.gd' })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/player.gd', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Read', file_path: '/proj/menu.gd' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-files' })
  expect(await ui.find({ type: 'Raster', key: 'files-map' })).toBeDefined()
  expect((await ui.find({ type: 'Button', text: /player\.gd/ }))?.text).toBe('± player.gd 1 read · 1 edit')
  await ui.press({ key: 'touch-player.gd' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1 +1 @@\n-a\n+b')
  await ui.unmount()
})

test("the Commits tab draws this session's graph and refreshes after a commit", async ($, on) => {
  let log = '* \x1e1111111\x1ffirst\x1f1 minute ago\x1fHEAD -> work\n|  1 file changed, 2 insertions(+)\n'
  const asked: string[][] = []
  engine(on)
  on('session.usage', () => ({ value: { ...USAGE, startedAt: 1_700_000_000_000 } }))
  on('process.run', (_, e) => {
    asked.push([...e.argv])
    const stdout = e.argv.includes('rev-list') ? 'basesha\n' : e.argv.includes('log') ? log : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(asked.find(argv => argv.includes('rev-list'))).toEqual(['git', '-C', '/proj', 'rev-list', '-1', '--before=@1700000000', 'HEAD'])
  expect(asked.find(argv => argv.includes('log'))?.at(-1)).toBe('^basesha')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-commits' })
  expect((await ui.find({ type: 'Text', text: /1111111/ }))?.text).toBe('● 1111111 first (HEAD -> work) +2 −0 1 minute ago')
  log = '* \x1e2222222\x1fsecond\x1fnow\x1fHEAD -> work\n' + log.replace('HEAD -> work', '')
  await $.tool.call({ tool: 'Bash', command: 'git commit -m second', description: 'Commit' })
  expect((await ui.find({ type: 'Text', text: /^This session's commits/ }))?.text).toBe("This session's commits 2")
  await ui.unmount()
})

test('a share bar keeps its parts in proportion and shows each that has any', () => {
  const bar = shareBar(
    [
      { n: 30, color: 0x6cc070, word: '+30' },
      { n: 1, color: 0xe06c75, word: '−1' },
    ],
    10,
  )
  const { lines, words } = decode(bar.cells, bar.columns, 1)
  expect(lines[0]).toBe('+30 −1 ██████████')
  expect(words[(bar.columns - 1) * 3 + 1]).toBe(0xe06c75)
  expect(patchCounts({ structuredPatch: [{ lines: [' a', '-b', '+c', '+d'] }] })).toEqual({ added: 2, removed: 1 })
  expect(patchCounts({ type: 'create', content: 'a\nb\nc', structuredPatch: [] })).toEqual({ added: 3, removed: 0 })
})

// Stands for the engine's own drawing of a row or the band.
const ENGINE_ROW = () => ({ type: 'Text', props: {}, children: ['engine row'] }) as never

const TOOL_RESULT = (tool_use_id: string, tool: string, output: unknown) =>
  ({
    plugin: 'show-work',
    component: 'ToolResult',
    requestId: tool_use_id,
    props: { tool_use_id, tool, output, isErrored: false },
  }) as const

test("an edit's row in the chat gets a bar of lines added and removed", async ($, on) => {
  engine(on)
  on('ui.render', ENGINE_ROW)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({
    ...TOOL_RESULT('toolu_e1', 'Edit', { structuredPatch: [{ lines: ['-a', '+b', '+c'] }] }),
    surface: 'terminal',
  })
  const bar = await ui.find({ type: 'Raster', key: 'edit-toolu_e1' })
  expect(decode(bar?.props.cells, bar?.props.columns, 1).lines[0]).toMatch(/^\+2 −1 █+$/)
  await ui.unmount()
})

test("a test command's row in the chat gets a pass and fail bar", async ($, on) => {
  let id = ''
  engine(on, {
    bash: (command, callId) => {
      id = callId

      return command === 'bun test' ? { text: BUN_OUT(false), isError: true } : undefined
    },
  })
  on('ui.render', ENGINE_ROW)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'bun test', description: 'Run the suite' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...TOOL_RESULT(id, 'Bash', { stdout: '' }), surface })
    if (surface === 'terminal') {
      const bar = await ui.find({ type: 'Raster', key: `tests-${id}` })
      expect(decode(bar?.props.cells, bar?.props.columns, 1).lines[0]).toMatch(/^✗ 1 pass 1 fail █+$/)
    } else {
      expect((await ui.find({ type: 'Text', text: /pass/ }))?.text).toBe('✗ 1 pass · 1 fail')
    }
    await ui.unmount()
  }
})

const BAND = (isWorking: boolean) =>
  ({
    plugin: 'show-work',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }) as const

test('the band shows the pulse, context and step while Claude works, and nothing idle', async ($, on) => {
  engine(on)
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.render', ENGINE_ROW)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__show-work__plan',
    goal: 'Ship it',
    steps: [{ text: 'Write the band', status: 'doing' }],
  })
  await $.tool.call({ tool: 'Read', file_path: '/proj/a.gd' })

  const idle = await $.ui.mount({ ...BAND(false), surface: 'terminal' })
  expect(await idle.find({ type: 'Raster' })).toBeUndefined()
  await idle.unmount()

  const ui = await $.ui.mount({ ...BAND(true), surface: 'terminal' })
  expect(await ui.find({ type: 'Raster', key: 'hud-pulse' })).toBeDefined()
  expect(await ui.find({ type: 'Raster', key: 'hud-gauge' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /▸/ }))?.text).toBe('60% · ▸ Write the band')
  await ui.unmount()
})

import { matches, parseStatus, treeRows } from '../hooks/explorer'

const FILES = ['README.md', 'hooks/register.tsx', 'hooks/charts.ts', 'tests/show-work.test.tsx', 'types/index.d.ts']

test('the tree lists folders first and opens only the open ones', () => {
  const closed = treeRows(FILES, new Set())
  expect(closed.map(row => row.path)).toEqual(['hooks', 'tests', 'types', 'README.md'])
  const open = treeRows(FILES, new Set(['hooks']))
  expect(open.map(row => `${'  '.repeat(row.depth)}${row.name}`)).toEqual([
    'hooks',
    '  charts.ts',
    '  register.tsx',
    'tests',
    'types',
    'README.md',
  ])
})

test('a filter finds files by a few letters, name hits first', () => {
  expect(matches(FILES, 'reg', 5)[0]).toBe('hooks/register.tsx')
  expect(matches(FILES, 'hct', 5)).toEqual(['hooks/charts.ts'])
  expect(matches(FILES, 'zzz', 5)).toEqual([])
  expect(parseStatus(' M hooks/register.tsx\n?? hooks/explorer.ts\nR  a.ts -> b.ts\n')).toEqual({
    'hooks/register.tsx': 'M',
    'hooks/explorer.ts': '??',
    'b.ts': 'R',
  })
})

test('the Explorer walks the tree, filters, previews a file and mentions it', async ($, on) => {
  const filled = engine(on)
  on('process.run', (_, e) => {
    const stdout = e.argv.includes('ls-files')
      ? FILES.join('\n') + '\n'
      : e.argv.includes('status')
        ? ' M hooks/register.tsx\n'
        : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: 'export const register = 1\nexport const two = 2\n' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-explorer' })
  expect((await ui.find({ type: 'Button', key: 'tab-explorer' }))?.text).toBe('Explorer 1')
  expect((await ui.find({ type: 'Text', text: /files/ }))?.text).toBe('5 files · 1 changed')
  await ui.press({ key: 'ex-hooks' })
  expect((await ui.find({ type: 'Button', key: 'ex-hooks/register.tsx' }))?.text).toBe('    register.tsx M')

  await ui.input({ key: 'ex-filter', text: 'chts', kind: 'change' })
  expect((await ui.findAll({ type: 'Button', text: /charts/ })).map(one => one.key)).toEqual(['ex-hooks/charts.ts'])
  await ui.input({ key: 'ex-filter', text: 'reg', kind: 'submit' })
  const code = await ui.find({ type: 'Code' })
  expect(code?.props).toMatchObject({ path: 'hooks/register.tsx', startLine: 1 })
  expect(code?.props.source).toMatch(/^export const register = 1/)
  expect(await ui.find({ type: 'Button', key: 'ex-diff' })).toBeDefined()
  await ui.press({ key: 'ex-mention' })
  expect(filled).toEqual(['@hooks/register.tsx '])
  await ui.press({ key: 'ex-close' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.unmount()
})

import { parseGit, parseHits, plain } from '../hooks/explorer'

test('git status, grep hits and coloured output are read plainly', () => {
  expect(parseGit('## main [ahead 3]\n').branch).toBe('main')
  expect(parseGit('## work...origin/work [ahead 2, behind 1]\nM  a.ts\n M b.ts\n?? c.ts\n')).toEqual({
    branch: 'work',
    ahead: 2,
    behind: 1,
    files: [
      { path: 'a.ts', index: 'M', worktree: ' ' },
      { path: 'b.ts', index: ' ', worktree: 'M' },
      { path: 'c.ts', index: '?', worktree: '?' },
    ],
  })
  expect(parseHits('a.ts:3:  const x = 1\nb/c.ts:10:x()\nnot a hit\n', 1)).toEqual({
    hits: [{ file: 'a.ts', line: 3, text: 'const x = 1' }],
    isCut: true,
  })
  expect(plain('\x1b[32m✓ ok\x1b[0m')).toBe('✓ ok')
  expect(plain('10%\r50%\r100% done')).toBe('100% done')
})

test('the Run tab streams a command, keeps its tail and hands it to Claude', async ($, on) => {
  const filled = engine(on)
  const spawned: string[][] = []
  on('process.spawn', async function* ($, e, next) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: 'building\n\x1b[31merror: x\x1b[0m\npart' }
    yield { stream: 'stderr' as const, text: 'ial\n' }

    return { value: { code: 1, signal: null } } as never
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-run' })
  await ui.input({ key: 'run-cmd', text: 'make build', kind: 'submit' })
  expect(spawned).toEqual([['bash', '-lc', 'make build']])
  expect((await ui.find({ type: 'Button', text: /^. make build/ }))?.text).toMatch(/^✗ make build \d+s · exit 1$/)
  expect((await ui.findAll({ type: 'Text', text: /building|error|partial/ })).map(one => [one.text, one.props.color])).toEqual([
    ['building', undefined],
    ['error: x', 'error'],
    ['partial', undefined],
  ])
  await ui.press({ key: 'run-ask' })
  expect(filled[0]).toBe('The output of `make build` (failed, exit 1):\n```\nbuilding\nerror: x\npartial\n```\n')
  await ui.unmount()
})

test('the Git tab stages a file, commits with a message and shows what git said', async ($, on) => {
  engine(on)
  const ran: string[][] = []
  let status = '## work\n M a.ts\n?? b.ts\n'
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    if (e.argv.includes('add')) {
      status = '## work\nM  a.ts\n?? b.ts\n'
    }
    if (e.argv.includes('commit')) {
      status = '## work [ahead 1]\n?? b.ts\n'
    }
    const stdout = e.argv.includes('--branch') ? status : e.argv.includes('commit') ? '[work 1234567] Fix a\n' : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-git' })
  expect((await ui.find({ type: 'Button', key: 'git-w-a.ts' }))?.text).toBe('○ a.ts modified')
  expect(await ui.find({ type: 'Input', key: 'git-msg' })).toBeUndefined()
  await ui.press({ key: 'git-w-a.ts' })
  expect(ran.find(argv => argv.includes('add'))).toEqual(['git', '-C', '/proj', 'add', '--', 'a.ts'])
  expect((await ui.find({ type: 'Button', key: 'git-s-a.ts' }))?.text).toBe('● a.ts modified')
  await ui.input({ key: 'git-msg', text: 'Fix a', kind: 'submit' })
  expect(ran.find(argv => argv.includes('commit'))).toEqual(['git', '-C', '/proj', 'commit', '-m', 'Fix a'])
  expect((await ui.find({ type: 'Text', text: /^git commit/ }))?.text).toBe('git commit: [work 1234567] Fix a')
  expect((await ui.find({ type: 'Text', text: /⎇/ }))?.text).toBe('⎇ work ↑1')
  expect(await ui.find({ type: 'Button', key: 'git-push' })).toBeDefined()
  await ui.unmount()
})

test('the Search tab finds text and a hit opens the file at that line', async ($, on) => {
  engine(on)
  on('process.run', (_, e) => {
    const stdout = e.argv[0] === 'rg' ? 'hooks/a.ts:42:  jump()\nhooks/a.ts:50:jump(2)\nREADME.md:3:jump here\n' : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n') }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-search' })
  await ui.input({ key: 'search-q', text: 'jump', kind: 'submit' })
  expect((await ui.find({ type: 'Text', text: /hits in/ }))?.text).toBe('3 hits in 2 files')
  expect((await ui.find({ type: 'Button', key: 'hit-hooks/a.ts:42' }))?.text).toBe('   42 jump()')
  await ui.press({ key: 'hit-hooks/a.ts:42' })
  const code = await ui.find({ type: 'Code' })
  expect(code?.props).toMatchObject({ path: 'hooks/a.ts', startLine: 32 })
  expect(code?.props.source).toMatch(/^line 32\n/)
  expect((await ui.find({ type: 'Text', text: /line 42 of/ }))?.text).toBe('hooks/a.ts line 42 of 80')
  await ui.unmount()
})
